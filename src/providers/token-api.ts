import { config } from '../config.js';
import { logger } from '../logger.js';
import { providerDuration, providerRequests } from '../metrics.js';
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

        const result: TokenApiResult = {
            data: emptyMetadata(),
            fetched_at: new Date(),
            response_time_ms: responseTimeMs,
            url,
            provider: this.name,
            null_reasons: {},
            block_timestamp: null,
        };

        if (!response.ok) {
            providerRequests.inc({ provider: 'token-api', network, status: 'error' });
            logger.warn(`Token API returned ${response.status} for ${network}:${contract}`);
            result.null_reasons = allFieldsNull(httpStatusToNullReason(response.status));
            return result;
        }

        const body = (await response.json()) as TokenApiResponse;
        const token = body.data?.[0];

        if (!token) {
            providerRequests.inc({ provider: 'token-api', network, status: 'error' });
            logger.warn(`Token API returned empty data for ${network}:${contract}`);
            result.null_reasons = allFieldsNull('empty');
            return result;
        }

        providerRequests.inc({ provider: 'token-api', network, status: 'success' });

        result.data = {
            symbol: token.symbol ?? null,
            decimals: token.decimals ?? null,
            // API field is named circulating_supply but represents total supply
            total_supply: token.circulating_supply != null ? String(token.circulating_supply) : null,
        };
        result.block_timestamp = token.last_update_timestamp ? new Date(token.last_update_timestamp * 1000) : null;

        if (result.data.symbol == null) result.null_reasons.symbol = 'empty';
        if (result.data.decimals == null) result.null_reasons.decimals = 'empty';
        if (result.data.total_supply == null) result.null_reasons.total_supply = 'empty';

        return result;
    }
}
