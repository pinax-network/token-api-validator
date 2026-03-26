import { APIError, type EvmNetwork, type SvmNetwork, TokenAPI } from '@pinax/token-api';
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

/** Common shape for metadata items across EVM and SVM SDK responses. */
interface TokenMetadataItem {
    name: string | null;
    symbol: string | null;
    decimals: number | null;
    circulating_supply: number;
    last_update_block_num: number;
    last_update_timestamp: number;
}

interface HolderEntry {
    entity: string;
    amount: string;
    block_num: number;
    timestamp: number;
}

interface VmConfig {
    prefix: string;
    param: string;
    cacheKey: (address: string) => string;
}

const EVM: VmConfig = { prefix: 'evm', param: 'contract', cacheKey: (a) => a.toLowerCase() };
const SVM: VmConfig = { prefix: 'svm', param: 'mint', cacheKey: (a) => a };

function vmFor(network: string): VmConfig {
    return network === 'solana' ? SVM : EVM;
}

/** shouldRetry predicate: retry on 429, 5xx, or network errors. */
export function isRetryableResult(result: unknown): boolean {
    if (!(result instanceof Error)) return false;
    if (result instanceof APIError) return result.status === 429 || result.status >= 500;
    return true; // network error — retry
}

/** Classify a Token API SDK error into a NullReason. */
export function classifySdkError(error: unknown): NullReason {
    if (error instanceof APIError) return httpStatusToNullReason(error.status);
    return 'server_error';
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
        const vm = vmFor(network);
        const key = `${network}:${vm.cacheKey(contract)}`;
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

        const vm = vmFor(network);
        if (contracts.length === 1) {
            const contract = contracts[0] as string;
            const result = await this.fetchMetadataSingle(network, contract);
            this.metadataCache.set(`${network}:${vm.cacheKey(contract)}`, result);
            return;
        }

        for (let offset = 0; offset < contracts.length; offset += BATCH_LIMIT) {
            const chunk = contracts.slice(offset, offset + BATCH_LIMIT);
            await this.fetchChunk(network, chunk);
        }
    }

    async fetchBalances(network: string, contract: string): Promise<ProviderResult> {
        const vm = vmFor(network);
        const url = `${config.tokenApiBaseUrl}/v1/${vm.prefix}/holders?network=${network}&${vm.param}=${contract}&limit=100`;
        const label = `token-api:balances:${network}:${contract}`;

        const start = Date.now();
        let holders: HolderEntry[];
        try {
            const body =
                network === 'solana'
                    ? await this.callWithRetry(
                          () =>
                              this.client.svm.tokens.getHolders({
                                  network: network as SvmNetwork,
                                  mint: contract,
                                  limit: 100,
                              }),
                          label
                      )
                    : await this.callWithRetry(
                          () =>
                              this.client.evm.tokens.getHolders({
                                  network: network as EvmNetwork,
                                  contract,
                                  limit: 100,
                              }),
                          label
                      );
            // SVM uses `token_account` (ATA), EVM uses `address`
            holders = (body.data ?? []).map((e) => ({
                entity: 'token_account' in e ? e.token_account : e.address.toLowerCase(),
                amount: e.amount,
                block_num: e.last_update_block_num,
                timestamp: e.last_update_timestamp,
            }));
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

        const entries: ComparableEntry[] = holders.map((h) => ({
            field: 'balance',
            entity: h.entity,
            value: h.amount,
            null_reason: null,
            block_number: h.block_num,
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

        const first = holders[0] as HolderEntry;
        return {
            domain: 'balance',
            entries,
            fetched_at: new Date(),
            response_time_ms: responseTimeMs,
            url,
            provider: this.name,
            block_number: first.block_num ?? null,
            block_timestamp: first.timestamp ? new Date(first.timestamp * 1000) : null,
        };
    }

    private async fetchMetadataSingle(network: string, address: string): Promise<ProviderResult> {
        const vm = vmFor(network);
        const url = `${config.tokenApiBaseUrl}/v1/${vm.prefix}/tokens?network=${network}&${vm.param}=${address}`;

        const start = Date.now();
        let body: { data: TokenMetadataItem[] };
        try {
            body =
                network === 'solana'
                    ? await this.callWithRetry(
                          () =>
                              this.client.svm.tokens.getTokenMetadata({
                                  network: network as SvmNetwork,
                                  mint: address,
                              }),
                          `token-api:${network}:${address}`
                      )
                    : await this.callWithRetry(
                          () =>
                              this.client.evm.tokens.getTokenMetadata({
                                  network: network as EvmNetwork,
                                  contract: address,
                              }),
                          `token-api:${network}:${address}`
                      );
        } catch (error) {
            const responseTimeMs = Date.now() - start;
            providerDuration.observe({ provider: 'token-api', endpoint: 'metadata' }, responseTimeMs / 1000);
            providerRequests.inc({ provider: 'token-api', network, endpoint: 'metadata', status: 'error' });
            logger.warn(`Token API returned error for ${network}:${address}: ${error}`);
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
            logger.warn(`Token API returned empty data for ${network}:${address}`);
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

    private async fetchChunk(network: string, addresses: string[]): Promise<void> {
        const vm = vmFor(network);
        const start = Date.now();

        let items: { key: string; meta: TokenMetadataItem }[];
        const label = `token-api:${network}:batch(${addresses.length})`;
        try {
            const body =
                network === 'solana'
                    ? await this.callWithRetry(
                          () =>
                              this.client.svm.tokens.getTokenMetadata({
                                  network: network as SvmNetwork,
                                  mint: addresses,
                              }),
                          label
                      )
                    : await this.callWithRetry(
                          () =>
                              this.client.evm.tokens.getTokenMetadata({
                                  network: network as EvmNetwork,
                                  contract: addresses,
                              }),
                          label
                      );
            items = (body.data ?? []).map((item) => ({
                key: 'mint' in item ? item.mint : item.contract,
                meta: item,
            }));
        } catch (error) {
            const responseTimeMs = Date.now() - start;
            providerDuration.observe({ provider: 'token-api', endpoint: 'metadata' }, responseTimeMs / 1000);
            batchRequests.inc({ provider: 'token-api', network, status: 'error' });
            batchFallbacks.inc({ provider: 'token-api', network });
            logger.warn(
                `Token API batch failed for ${network} (${addresses.length} tokens), falling back to individual: ${error}`
            );
            for (const address of addresses) {
                const result = await this.fetchMetadataSingle(network, address);
                this.metadataCache.set(`${network}:${vm.cacheKey(address)}`, result);
            }
            return;
        }

        const responseTimeMs = Date.now() - start;
        providerDuration.observe({ provider: 'token-api', endpoint: 'metadata' }, responseTimeMs / 1000);
        batchRequests.inc({ provider: 'token-api', network, status: 'success' });
        batchSize.observe({ provider: 'token-api', network }, addresses.length);

        const fetched_at = new Date();
        const itemByKey = new Map<string, TokenMetadataItem>();
        for (const item of items) {
            itemByKey.set(vm.cacheKey(item.key), item.meta);
        }

        for (const address of addresses) {
            const normalized = vm.cacheKey(address);
            const cacheKey = `${network}:${normalized}`;
            const individualUrl = `${config.tokenApiBaseUrl}/v1/${vm.prefix}/tokens?network=${network}&${vm.param}=${address}`;
            const item = itemByKey.get(normalized);

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
        token: TokenMetadataItem,
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
