import { config } from '../config.js';
import { logger } from '../logger.js';
import { batchFallbacks, batchRequests, batchSize, providerDuration, providerRequests } from '../metrics.js';
import { withRetry } from '../utils/retry.js';
import {
    allFieldsNull,
    type BalanceEntry,
    type BalancesResult,
    emptyMetadata,
    httpStatusToNullReason,
    type MetadataResult,
} from './types.js';

interface TokenApiResponse {
    data: Array<{
        contract: string;
        name: string;
        symbol: string;
        decimals: number;
        circulating_supply: number;
        holders: number;
        total_transfers: number;
        network: string;
        last_update_timestamp: number;
        last_update_block_num: number;
    }>;
}

/** Token API `/v1/evm/holders` response. */
interface TokenApiHoldersResponse {
    data: Array<{
        address: string;
        amount: string;
        last_update_timestamp: number;
    }>;
}

/** Extended result that includes the block timestamp from the Token API's last_update_timestamp. */
export interface TokenApiResult extends MetadataResult {
    block_timestamp: Date | null;
}

const BATCH_LIMIT = 100;

/** Fetches token metadata and balances from the Pinax Token API. */
export class TokenApiProvider {
    name = 'token-api';
    private metadataCache = new Map<string, TokenApiResult>();

    async fetchMetadata(network: string, contract: string): Promise<TokenApiResult> {
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

    async fetchBalances(network: string, contract: string): Promise<BalancesResult> {
        const url = `${config.tokenApiBaseUrl}/v1/evm/holders?network=${network}&contract=${contract}&limit=100`;
        const headers = { Authorization: `Bearer ${config.tokenApiJwt}` };

        const start = Date.now();
        const response = await withRetry(
            () => fetch(url, { headers }),
            {
                maxAttempts: config.retryMaxAttempts,
                baseDelay: config.retryBaseDelayMs,
                shouldRetry: (res) => res.status === 429,
            },
            `token-api:balances:${network}:${contract}`
        );
        const responseTimeMs = Date.now() - start;
        providerDuration.observe({ provider: 'token-api', endpoint: 'balance' }, responseTimeMs / 1000);
        providerRequests.inc({
            provider: 'token-api',
            network,
            endpoint: 'balance',
            status: response.ok ? 'success' : 'error',
        });

        if (!response.ok) {
            logger.warn(`Token API balances returned ${response.status} for ${network}:${contract}`);
            return {
                balances: [],
                fetched_at: new Date(),
                response_time_ms: responseTimeMs,
                url,
                provider: this.name,
                null_reason: httpStatusToNullReason(response.status),
                block_timestamp: null,
            };
        }

        const body = (await response.json()) as TokenApiHoldersResponse;
        const balances: BalanceEntry[] = (body.data ?? []).map((entry) => ({
            address: entry.address.toLowerCase(),
            balance: entry.amount,
        }));

        const firstEntry = body.data?.[0];
        const blockTimestamp = firstEntry?.last_update_timestamp
            ? new Date(firstEntry.last_update_timestamp * 1000)
            : null;

        return {
            balances,
            fetched_at: new Date(),
            response_time_ms: responseTimeMs,
            url,
            provider: this.name,
            null_reason: balances.length === 0 ? 'empty' : null,
            block_timestamp: blockTimestamp,
        };
    }

    private async fetchMetadataSingle(network: string, contract: string): Promise<TokenApiResult> {
        const url = `${config.tokenApiBaseUrl}/v1/evm/tokens?network=${network}&contract=${contract}`;
        const headers = { Authorization: `Bearer ${config.tokenApiJwt}` };

        const start = Date.now();
        const response = await withRetry(
            () => fetch(url, { headers }),
            {
                maxAttempts: config.retryMaxAttempts,
                baseDelay: config.retryBaseDelayMs,
                shouldRetry: (res) => res.status === 429,
            },
            `token-api:${network}:${contract}`
        );
        const responseTimeMs = Date.now() - start;
        providerDuration.observe({ provider: 'token-api', endpoint: 'metadata' }, responseTimeMs / 1000);
        providerRequests.inc({
            provider: 'token-api',
            network,
            endpoint: 'metadata',
            status: response.ok ? 'success' : 'error',
        });

        if (!response.ok) {
            logger.warn(`Token API returned ${response.status} for ${network}:${contract}`);
            return {
                data: emptyMetadata(),
                fetched_at: new Date(),
                response_time_ms: responseTimeMs,
                url,
                provider: this.name,
                null_reasons: allFieldsNull(httpStatusToNullReason(response.status)),
                block_timestamp: null,
            };
        }

        const body = (await response.json()) as TokenApiResponse;
        const token = body.data?.[0];

        if (!token) {
            logger.warn(`Token API returned empty data for ${network}:${contract}`);
            return {
                data: emptyMetadata(),
                fetched_at: new Date(),
                response_time_ms: responseTimeMs,
                url,
                provider: this.name,
                null_reasons: allFieldsNull('empty'),
                block_timestamp: null,
            };
        }

        return this.buildResult(token, url, new Date(), responseTimeMs);
    }

    private async fetchChunk(network: string, contracts: string[]): Promise<void> {
        const batchUrl = `${config.tokenApiBaseUrl}/v1/evm/tokens?network=${network}&contract=${contracts.join(',')}`;
        const headers = { Authorization: `Bearer ${config.tokenApiJwt}` };

        const start = Date.now();
        const response = await withRetry(
            () => fetch(batchUrl, { headers }),
            {
                maxAttempts: config.retryMaxAttempts,
                baseDelay: config.retryBaseDelayMs,
                shouldRetry: (res) => res.status === 429,
            },
            `token-api:${network}:batch(${contracts.length})`
        );
        const responseTimeMs = Date.now() - start;
        providerDuration.observe({ provider: 'token-api', endpoint: 'metadata' }, responseTimeMs / 1000);

        if (!response.ok) {
            batchRequests.inc({ provider: 'token-api', network, status: 'error' });
            batchFallbacks.inc({ provider: 'token-api', network });
            logger.warn(
                `Token API batch returned ${response.status} for ${network} (${contracts.length} contracts), falling back to individual`
            );
            for (const contract of contracts) {
                const result = await this.fetchMetadataSingle(network, contract);
                this.metadataCache.set(`${network}:${contract.toLowerCase()}`, result);
            }
            return;
        }

        batchRequests.inc({ provider: 'token-api', network, status: 'success' });
        batchSize.observe({ provider: 'token-api', network }, contracts.length);

        const body = (await response.json()) as TokenApiResponse;
        const fetched_at = new Date();

        const itemByContract = new Map<string, TokenApiResponse['data'][number]>();
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
                    data: emptyMetadata(),
                    fetched_at,
                    response_time_ms: responseTimeMs,
                    url: individualUrl,
                    provider: this.name,
                    null_reasons: allFieldsNull('empty'),
                    block_timestamp: null,
                });
                continue;
            }

            providerRequests.inc({ provider: 'token-api', network, endpoint: 'metadata', status: 'success' });
            this.metadataCache.set(cacheKey, this.buildResult(item, individualUrl, fetched_at, responseTimeMs));
        }
    }

    private buildResult(
        token: TokenApiResponse['data'][number],
        url: string,
        fetched_at: Date,
        responseTimeMs: number
    ): TokenApiResult {
        const data = {
            name: token.name ?? null,
            symbol: token.symbol ?? null,
            decimals: token.decimals ?? null,
            // API field is named circulating_supply but represents total supply
            total_supply: token.circulating_supply != null ? String(token.circulating_supply) : null,
        };

        const null_reasons: TokenApiResult['null_reasons'] = {};
        if (data.name == null) null_reasons.name = 'empty';
        if (data.symbol == null) null_reasons.symbol = 'empty';
        if (data.decimals == null) null_reasons.decimals = 'empty';
        if (data.total_supply == null) null_reasons.total_supply = 'empty';

        return {
            data,
            fetched_at,
            response_time_ms: responseTimeMs,
            url,
            provider: this.name,
            null_reasons,
            block_timestamp: token.last_update_timestamp ? new Date(token.last_update_timestamp * 1000) : null,
        };
    }
}
