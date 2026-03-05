import { config } from '../config.js';
import { logger } from '../logger.js';
import { providerDuration, providerRequests } from '../metrics.js';
import { withRetry } from '../utils/retry.js';
import { emptyMetadata, httpStatusToNullReason, type ProviderResult } from './types.js';

const ETHERSCAN_V2_BASE = 'https://api.etherscan.io/v2/api';

interface EtherscanResponse {
    status: string;
    message: string;
    result: string;
}

/**
 * Parse Etherscan error body into a null_reason.
 *
 * Known error result strings (https://docs.etherscan.io/resources/common-error-messages):
 *   "Max rate limit reached"
 *   "Invalid API Key"
 *   "Too many invalid api key attempts, please try again later"
 *   "Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage."
 *   "Missing or unsupported chainid parameter (required for v2 api), ..."
 *   "Error! Missing Or invalid Action name"
 *   "Query Timeout occured. Please select a smaller result dataset"
 *
 * When status=1, message may contain "OK-Missing/Invalid API Key, rate limit of 1/5sec applied"
 * (still returns data but at reduced rate — not an error).
 */
function parseEtherscanError(result: string): string {
    const lower = result.toLowerCase();
    if (lower.startsWith('max rate limit reached')) return 'rate_limited';
    if (lower.startsWith('free api access is not supported')) return 'paid_plan_required';
    if (lower.startsWith('invalid api key') || lower.startsWith('too many invalid api key')) return 'forbidden';
    if (lower.includes('missing or unsupported chainid')) return 'not_found';
    if (lower.includes('timeout')) return 'timeout';
    return 'server_error';
}

/** Fetches token metadata from Etherscan V2 unified API. */
export class EtherscanProvider {
    name = 'etherscan';

    async fetch(network: string, contract: string, chainId: number): Promise<ProviderResult> {
        const params = new URLSearchParams({
            chainid: String(chainId),
            module: 'stats',
            action: 'tokensupply',
            contractaddress: contract,
        });
        if (config.etherscanApiKey) params.set('apikey', config.etherscanApiKey);

        const url = `${ETHERSCAN_V2_BASE}?${params}`;

        const start = Date.now();
        const response = await withRetry(
            async () => {
                const res = await fetch(url);
                const body = (await res.json()) as EtherscanResponse;
                return { res, body };
            },
            {
                maxAttempts: config.retryMaxAttempts,
                baseDelay: config.retryBaseDelayMs,
                shouldRetry: ({ res, body }) =>
                    res.status === 429 ||
                    (body.status !== '1' && (body.result ?? '').toLowerCase().startsWith('max rate limit reached')),
            },
            `etherscan:${network}:${contract}`
        );
        const responseTimeMs = Date.now() - start;
        providerDuration.observe({ provider: 'etherscan' }, responseTimeMs / 1000);

        const { res, body } = response;

        const result: ProviderResult = {
            data: emptyMetadata(),
            fetched_at: new Date(),
            response_time_ms: responseTimeMs,
            url,
            provider: 'etherscan',
            null_reason: null,
        };

        if (!res.ok) {
            providerRequests.inc({ provider: 'etherscan', network, status: 'error' });
            logger.warn(`Etherscan returned ${res.status} for ${network}:${contract}`);
            result.null_reason = httpStatusToNullReason(res.status);
            return result;
        }

        if (body.status !== '1') {
            providerRequests.inc({ provider: 'etherscan', network, status: 'error' });
            logger.warn(`Etherscan error for ${network}:${contract}: ${body.result}`);
            result.null_reason = parseEtherscanError(body.result ?? '');
            return result;
        }

        providerRequests.inc({ provider: 'etherscan', network, status: 'success' });
        result.data.total_supply = body.result ?? null;

        return result;
    }
}
