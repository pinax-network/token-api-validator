import { config } from '../config.js';
import { logger } from '../logger.js';
import { batchFallbacks, batchRequests, batchSize, providerDuration, providerRequests } from '../metrics.js';
import { withRetry } from '../utils/retry.js';
import { allFieldsNull, emptyMetadata, httpStatusToNullReason, type ProviderResult } from './types.js';

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

/** Extended result that includes the block timestamp from the Token API's last_update_timestamp. */
export interface TokenApiResult extends ProviderResult {
    block_timestamp: Date | null;
}

const BATCH_LIMIT = 100;

/** Fetches token metadata from the Pinax Token API. */
export class TokenApiProvider {
    name = 'token-api';

    async fetch(network: string, contract: string): Promise<TokenApiResult> {
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
        providerDuration.observe({ provider: 'token-api' }, responseTimeMs / 1000);
        providerRequests.inc({ provider: 'token-api', network, status: response.ok ? 'success' : 'error' });

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

    /**
     * Fetch metadata for multiple contracts in one request, chunked to the batch limit.
     * On HTTP error, falls back to individual fetches for that chunk.
     */
    async fetchBatch(network: string, contracts: string[]): Promise<Map<string, TokenApiResult>> {
        if (contracts.length <= 1) {
            const contract = contracts[0] as string;
            const result = await this.fetch(network, contract);
            return new Map([[contract.toLowerCase(), result]]);
        }

        const results = new Map<string, TokenApiResult>();

        for (let offset = 0; offset < contracts.length; offset += BATCH_LIMIT) {
            const chunk = contracts.slice(offset, offset + BATCH_LIMIT);
            const chunkResults = await this.fetchChunk(network, chunk);
            for (const [contract, result] of chunkResults) {
                results.set(contract, result);
            }
        }

        return results;
    }

    private async fetchChunk(network: string, contracts: string[]): Promise<Map<string, TokenApiResult>> {
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
        providerDuration.observe({ provider: 'token-api' }, responseTimeMs / 1000);

        if (!response.ok) {
            batchRequests.inc({ provider: 'token-api', network, status: 'error' });
            batchFallbacks.inc({ provider: 'token-api', network });
            logger.warn(
                `Token API batch returned ${response.status} for ${network} (${contracts.length} contracts), falling back to individual`
            );
            const results = new Map<string, TokenApiResult>();
            for (const contract of contracts) {
                const result = await this.fetch(network, contract);
                results.set(contract.toLowerCase(), result);
            }
            return results;
        }

        batchRequests.inc({ provider: 'token-api', network, status: 'success' });
        batchSize.observe({ provider: 'token-api', network }, contracts.length);

        const body = (await response.json()) as TokenApiResponse;
        const fetched_at = new Date();

        // Index response items by contract
        const itemByContract = new Map<string, TokenApiResponse['data'][number]>();
        for (const item of body.data ?? []) {
            itemByContract.set(item.contract.toLowerCase(), item);
        }

        // Build results for all requested contracts
        const results = new Map<string, TokenApiResult>();
        for (const contract of contracts) {
            const key = contract.toLowerCase();
            const individualUrl = `${config.tokenApiBaseUrl}/v1/evm/tokens?network=${network}&contract=${contract}`;
            const item = itemByContract.get(key);

            if (!item) {
                providerRequests.inc({ provider: 'token-api', network, status: 'error' });
                results.set(key, {
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

            providerRequests.inc({ provider: 'token-api', network, status: 'success' });
            results.set(key, this.buildResult(item, individualUrl, fetched_at, responseTimeMs));
        }

        return results;
    }

    private buildResult(
        token: TokenApiResponse['data'][number],
        url: string,
        fetched_at: Date,
        responseTimeMs: number
    ): TokenApiResult {
        const data = {
            symbol: token.symbol ?? null,
            decimals: token.decimals ?? null,
            // API field is named circulating_supply but represents total supply
            total_supply: token.circulating_supply != null ? String(token.circulating_supply) : null,
        };

        const null_reasons: TokenApiResult['null_reasons'] = {};
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
