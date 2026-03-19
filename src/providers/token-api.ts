import { type EvmHoldersResponse, type EvmNetwork, type EvmTokensResponse, TokenAPI } from '@pinax/token-api';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { batchFallbacks, batchRequests, batchSize, providerDuration, providerRequests } from '../metrics.js';
import { withRetry } from '../utils/retry.js';
import {
    type ComparableEntry,
    httpStatusToNullReason,
    type NullReason,
    type Provider,
    type ProviderResult,
} from './types.js';

const BATCH_LIMIT = 100;
const METADATA_FIELDS = ['name', 'symbol', 'decimals', 'total_supply'] as const;

/** Extract HTTP status from SDK error message (format: `API Error: {"status":429,...}`). */
export function parseErrorStatus(error: unknown): number | null {
    const msg = error instanceof Error ? error.message : '';
    const match = msg.match(/API Error: (\{.*\})/);
    if (!match?.[1]) return null;
    try {
        return (JSON.parse(match[1]) as { status?: number }).status ?? null;
    } catch {
        return null;
    }
}

/** shouldRetry predicate: retry if the result is a retryable error (429, 5xx, network). */
export function isRetryableResult(result: unknown): boolean {
    if (!(result instanceof Error)) return false;
    const status = parseErrorStatus(result);
    if (status === null) return true; // network error — retry
    return status === 429 || status >= 500;
}

/** Classify a Token API SDK error into a NullReason. */
export function classifySdkError(error: unknown): NullReason {
    const status = parseErrorStatus(error);
    return status ? httpStatusToNullReason(status) : 'server_error';
}

function errorEntries(fields: readonly string[], reason: NullReason): ComparableEntry[] {
    return fields.map((f) => ({
        field: f,
        entity: '',
        value: null,
        null_reason: reason,
    }));
}

/** Fetches token metadata and balances from the Pinax Token API. */
export class TokenApiProvider implements Provider {
    name = 'token-api';
    private client = new TokenAPI({ apiToken: config.tokenApiJwt, baseUrl: config.tokenApiBaseUrl });
    private metadataCache = new Map<string, ProviderResult>();

    supportsNetwork(_network: string): boolean {
        return true;
    }

    async fetchMetadata(network: string, contract: string): Promise<ProviderResult> {
        const key = `${network}:${contract.toLowerCase()}`;
        const cached = this.metadataCache.get(key);
        if (cached) {
            this.metadataCache.delete(key);
            return cached;
        }

        return this.fetchMetadataSingle(network, contract);
    }

    /**
     * Pre-fetch metadata for all contracts on a network in a single batch request.
     * Subsequent `fetchMetadata()` calls for these contracts read from the internal cache.
     */
    async prefetchMetadata(network: string, contracts: string[]): Promise<void> {
        if (contracts.length === 0) return;

        if (contracts.length === 1) {
            const contract = contracts[0] as string;
            const result = await this.fetchMetadataSingle(network, contract);
            this.metadataCache.set(`${network}:${contract.toLowerCase()}`, result);
            return;
        }

        for (let offset = 0; offset < contracts.length; offset += BATCH_LIMIT) {
            const chunk = contracts.slice(offset, offset + BATCH_LIMIT);
            await this.fetchChunk(network, chunk);
        }
    }

    async fetchBalances(network: string, contract: string): Promise<ProviderResult> {
        const url = `${config.tokenApiBaseUrl}/v1/evm/holders?network=${network}&contract=${contract}&limit=100`;

        const start = Date.now();
        let body: EvmHoldersResponse;
        try {
            body = await this.callWithRetry(
                () => this.client.evm.tokens.getHolders({ network: network as EvmNetwork, contract, limit: 100 }),
                `token-api:balances:${network}:${contract}`
            );
        } catch (error) {
            const responseTimeMs = Date.now() - start;
            providerDuration.observe({ provider: 'token-api', endpoint: 'balance' }, responseTimeMs / 1000);
            providerRequests.inc({ provider: 'token-api', network, endpoint: 'balance', status: 'error' });
            logger.warn(`Token API balances failed for ${network}:${contract}: ${error}`);
            return {
                domain: 'balance',
                fetched_at: new Date(),
                response_time_ms: responseTimeMs,
                url,
                provider: this.name,
                entries: [{ field: 'balance', entity: '', value: null, null_reason: classifySdkError(error) }],
            };
        }

        const responseTimeMs = Date.now() - start;
        providerDuration.observe({ provider: 'token-api', endpoint: 'balance' }, responseTimeMs / 1000);
        providerRequests.inc({ provider: 'token-api', network, endpoint: 'balance', status: 'success' });

        const entries: ComparableEntry[] = (body.data ?? []).map((entry) => ({
            field: 'balance',
            entity: entry.address.toLowerCase(),
            value: entry.amount,
            null_reason: null,
        }));

        if (entries.length === 0) {
            return {
                domain: 'balance',
                fetched_at: new Date(),
                response_time_ms: responseTimeMs,
                url,
                provider: this.name,
                entries: [{ field: 'balance', entity: '', value: null, null_reason: 'empty' }],
            };
        }

        const firstEntry = body.data[0];
        return {
            domain: 'balance',
            entries,
            fetched_at: new Date(),
            response_time_ms: responseTimeMs,
            url,
            provider: this.name,
            block_number: firstEntry?.last_update_block_num ?? null,
            block_timestamp: firstEntry?.last_update_timestamp
                ? new Date(firstEntry.last_update_timestamp * 1000)
                : null,
        };
    }

    private async fetchMetadataSingle(network: string, contract: string): Promise<ProviderResult> {
        const url = `${config.tokenApiBaseUrl}/v1/evm/tokens?network=${network}&contract=${contract}`;

        const start = Date.now();
        let body: EvmTokensResponse;
        try {
            body = await this.callWithRetry(
                () => this.client.evm.tokens.getTokenMetadata({ network: network as EvmNetwork, contract }),
                `token-api:${network}:${contract}`
            );
        } catch (error) {
            const responseTimeMs = Date.now() - start;
            providerDuration.observe({ provider: 'token-api', endpoint: 'metadata' }, responseTimeMs / 1000);
            providerRequests.inc({ provider: 'token-api', network, endpoint: 'metadata', status: 'error' });
            logger.warn(`Token API returned error for ${network}:${contract}: ${error}`);
            return {
                domain: 'metadata',
                fetched_at: new Date(),
                response_time_ms: responseTimeMs,
                url,
                provider: this.name,
                entries: errorEntries(METADATA_FIELDS, classifySdkError(error)),
            };
        }

        const responseTimeMs = Date.now() - start;
        providerDuration.observe({ provider: 'token-api', endpoint: 'metadata' }, responseTimeMs / 1000);
        providerRequests.inc({ provider: 'token-api', network, endpoint: 'metadata', status: 'success' });

        const token = body.data?.[0];
        if (!token) {
            logger.warn(`Token API returned empty data for ${network}:${contract}`);
            return {
                domain: 'metadata',
                fetched_at: new Date(),
                response_time_ms: responseTimeMs,
                url,
                provider: this.name,
                entries: errorEntries(METADATA_FIELDS, 'empty'),
            };
        }

        return this.buildResult(token, url, new Date(), responseTimeMs);
    }

    private async fetchChunk(network: string, contracts: string[]): Promise<void> {
        const start = Date.now();
        let body: EvmTokensResponse;
        try {
            body = await this.callWithRetry(
                () => this.client.evm.tokens.getTokenMetadata({ network: network as EvmNetwork, contract: contracts }),
                `token-api:${network}:batch(${contracts.length})`
            );
        } catch (error) {
            const responseTimeMs = Date.now() - start;
            providerDuration.observe({ provider: 'token-api', endpoint: 'metadata' }, responseTimeMs / 1000);
            batchRequests.inc({ provider: 'token-api', network, status: 'error' });
            batchFallbacks.inc({ provider: 'token-api', network });
            logger.warn(
                `Token API batch failed for ${network} (${contracts.length} contracts), falling back to individual: ${error}`
            );
            for (const contract of contracts) {
                const result = await this.fetchMetadataSingle(network, contract);
                this.metadataCache.set(`${network}:${contract.toLowerCase()}`, result);
            }
            return;
        }

        const responseTimeMs = Date.now() - start;
        providerDuration.observe({ provider: 'token-api', endpoint: 'metadata' }, responseTimeMs / 1000);
        batchRequests.inc({ provider: 'token-api', network, status: 'success' });
        batchSize.observe({ provider: 'token-api', network }, contracts.length);

        const fetched_at = new Date();
        const itemByContract = new Map<string, (typeof body.data)[number]>();
        for (const item of body.data ?? []) {
            itemByContract.set(item.contract.toLowerCase(), item);
        }

        for (const contract of contracts) {
            const key = contract.toLowerCase();
            const cacheKey = `${network}:${key}`;
            const individualUrl = `${config.tokenApiBaseUrl}/v1/evm/tokens?network=${network}&contract=${contract}`;
            const item = itemByContract.get(key);

            if (!item) {
                providerRequests.inc({ provider: 'token-api', network, endpoint: 'metadata', status: 'error' });
                this.metadataCache.set(cacheKey, {
                    domain: 'metadata',
                    entries: errorEntries(METADATA_FIELDS, 'empty'),
                    fetched_at,
                    response_time_ms: responseTimeMs,
                    url: individualUrl,
                    provider: this.name,
                });
                continue;
            }

            providerRequests.inc({ provider: 'token-api', network, endpoint: 'metadata', status: 'success' });
            this.metadataCache.set(cacheKey, this.buildResult(item, individualUrl, fetched_at, responseTimeMs));
        }
    }

    /** Call an SDK method with retry on transient errors (429, 5xx, network). Non-retryable errors throw immediately. */
    private async callWithRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
        const result = await withRetry(
            () => fn().catch((e: unknown) => e),
            {
                maxAttempts: config.retryMaxAttempts,
                baseDelay: config.retryBaseDelayMs,
                shouldRetry: isRetryableResult,
            },
            label
        );
        if (result instanceof Error) throw result;
        return result as T;
    }

    private buildResult(
        token: EvmTokensResponse['data'][number],
        url: string,
        fetched_at: Date,
        responseTimeMs: number
    ): ProviderResult {
        const values: Record<string, string | null> = {
            name: token.name ?? null,
            symbol: token.symbol ?? null,
            decimals: token.decimals != null ? String(token.decimals) : null,
            // API field is named circulating_supply but represents total supply
            total_supply: token.circulating_supply != null ? String(token.circulating_supply) : null,
        };

        const entries: ComparableEntry[] = METADATA_FIELDS.map((field) => ({
            field,
            entity: '',
            value: values[field] ?? null,
            null_reason: values[field] == null ? ('empty' as const) : null,
        }));

        return {
            domain: 'metadata',
            entries,
            fetched_at,
            response_time_ms: responseTimeMs,
            url,
            provider: this.name,
            block_number: token.last_update_block_num ?? null,
            block_timestamp: token.last_update_timestamp ? new Date(token.last_update_timestamp * 1000) : null,
        };
    }
}
