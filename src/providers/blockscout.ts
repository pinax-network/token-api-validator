import { config } from '../config.js';
import { logger } from '../logger.js';
import { providerDuration, providerRequests } from '../metrics.js';
import { withRetry } from '../utils/retry.js';
import { emptyMetadata, httpStatusToNullReason, type ProviderResult } from './types.js';

interface BlockscoutTokenResponse {
    symbol: string;
    decimals: string;
    totalSupply: string;
    type: string;
}

/** Fetches token metadata from Blockscout block explorers. */
export class BlockscoutProvider {
    name = 'blockscout';

    async fetch(network: string, contract: string, baseUrl: string): Promise<ProviderResult> {
        const url = `${baseUrl}?module=token&action=getToken&contractaddress=${contract}`;

        const start = Date.now();
        const response = await withRetry(
            () => fetch(url),
            {
                maxAttempts: config.retryMaxAttempts,
                baseDelay: config.retryBaseDelayMs,
                shouldRetry: (res) => res.status === 429,
            },
            `blockscout:${network}:${contract}`
        );
        const responseTimeMs = Date.now() - start;
        providerDuration.observe({ provider: 'blockscout' }, responseTimeMs / 1000);

        const result: ProviderResult = {
            data: emptyMetadata(),
            fetched_at: new Date(),
            response_time_ms: responseTimeMs,
            url,
            provider: 'blockscout',
            null_reason: null,
        };

        if (!response.ok) {
            providerRequests.inc({ provider: 'blockscout', network, status: 'error' });
            logger.warn(`Blockscout returned ${response.status} for ${network}:${contract}`);
            result.null_reason = httpStatusToNullReason(response.status);
            return result;
        }

        providerRequests.inc({ provider: 'blockscout', network, status: 'success' });
        const body = await response.json();
        const token = (body as { result?: BlockscoutTokenResponse }).result;

        if (!token) {
            logger.warn(`Blockscout returned no result for ${network}:${contract}`);
            result.null_reason = 'empty';
            return result;
        }

        result.data = {
            symbol: token.symbol ?? null,
            decimals: token.decimals != null ? Number(token.decimals) : null,
            total_supply: token.totalSupply ?? null,
        };

        return result;
    }
}
