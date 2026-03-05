import { config } from '../config.js';
import { logger } from '../logger.js';
import { providerDuration, providerRequests } from '../metrics.js';
import { withRetry } from '../utils/retry.js';
import { emptyMetadata, httpStatusToNullReason, type ProviderResult } from './types.js';

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

/** Fetches token metadata from the Pinax Token API. */
export class TokenApiProvider {
    name = 'token-api';

    async fetch(network: string, contract: string): Promise<TokenApiResult> {
        const url = `${config.tokenApiBaseUrl}/v1/evm/tokens?network=${network}&contract=${contract}`;
        const headers: Record<string, string> = {};
        if (config.tokenApiJwt) {
            headers.Authorization = `Bearer ${config.tokenApiJwt}`;
        }

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

        const result: TokenApiResult = {
            data: emptyMetadata(),
            fetched_at: new Date(),
            response_time_ms: responseTimeMs,
            url,
            provider: this.name,
            null_reason: null,
            block_timestamp: null,
        };

        if (!response.ok) {
            providerRequests.inc({ provider: 'token-api', network, status: 'error' });
            logger.warn(`Token API returned ${response.status} for ${network}:${contract}`);
            result.null_reason = httpStatusToNullReason(response.status);
            return result;
        }

        const body = (await response.json()) as TokenApiResponse;
        const token = body.data?.[0];

        providerRequests.inc({ provider: 'token-api', network, status: 'success' });

        if (!token) {
            logger.warn(`Token API returned empty data for ${network}:${contract}`);
            result.null_reason = 'empty';
            return result;
        }

        result.data = {
            symbol: token.symbol ?? null,
            decimals: token.decimals ?? null,
            // API field is named circulating_supply but represents total supply
            total_supply: token.circulating_supply != null ? String(token.circulating_supply) : null,
        };
        result.block_timestamp = token.last_update_timestamp ? new Date(token.last_update_timestamp * 1000) : null;

        return result;
    }
}
