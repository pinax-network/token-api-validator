import { config } from '../config.js';
import { logger } from '../logger.js';
import { providerDuration, providerRequests } from '../metrics.js';
import { withRetry } from '../utils/retry.js';
import {
    allFieldsNull,
    emptyMetadata,
    type FieldNullReasons,
    httpStatusToNullReason,
    type NullReason,
    type ProviderResult,
} from './types.js';

const ETHERSCAN_V2_BASE = 'https://api.etherscan.io/v2/api';

interface EtherscanResponse {
    status: string;
    message: string;
    result: unknown;
}

interface TokenInfoEntry {
    contractAddress: string;
    tokenName: string;
    symbol: string;
    divisor: string;
    totalSupply: string;
    tokenType: string;
}

/**
 * Parse Etherscan error body into a NullReason.
 *
 * Known error result strings (https://docs.etherscan.io/resources/common-error-messages):
 *   "Max rate limit reached"
 *   "Max calls per sec rate limit reached (N/sec)"
 *   "Invalid API Key"
 *   "Too many invalid api key attempts, please try again later"
 *   "Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage."
 *   "Missing or unsupported chainid parameter (required for v2 api), ..."
 *   "Error! Missing Or invalid Action name"
 *   "Query Timeout occured. Please select a smaller result dataset"
 *   "Sorry, it looks like you are trying to access an API Pro endpoint. Contact us to upgrade to API Pro."
 *
 * When status=1, message may contain "OK-Missing/Invalid API Key, rate limit of 1/5sec applied"
 * (still returns data but at reduced rate — not an error).
 */
function parseEtherscanError(result: string): NullReason {
    const lower = result.toLowerCase();
    if (lower.includes('rate limit reached')) return 'rate_limited';
    if (lower.startsWith('free api access is not supported')) return 'paid_plan_required';
    if (lower.includes('api pro endpoint')) return 'paid_plan_required';
    if (lower.startsWith('invalid api key') || lower.startsWith('too many invalid api key')) return 'forbidden';
    if (lower.includes('missing or unsupported chainid')) return 'not_found';
    if (lower.includes('timeout')) return 'timeout';
    return 'server_error';
}

type ApiResult = { ok: true; data: EtherscanResponse; url: string } | { ok: false; reason: NullReason; url: string };

/**
 * Fetches token metadata from Etherscan V2 unified API using the `token/tokeninfo` endpoint.
 * Requires a paid API plan — if the plan lapses, all fields will return `paid_plan_required`.
 */
export class EtherscanProvider {
    name = 'etherscan';

    async fetch(network: string, contract: string, chainId: number): Promise<ProviderResult> {
        const params: Record<string, string> = {
            chainid: String(chainId),
            contractaddress: contract,
            module: 'token',
            action: 'tokeninfo',
        };
        if (config.etherscanApiKey) params.apikey = config.etherscanApiKey;

        const start = Date.now();
        const result = await this.callApi(network, params);
        const responseTimeMs = Date.now() - start;

        if (!result.ok) {
            return {
                data: emptyMetadata(),
                fetched_at: new Date(),
                response_time_ms: responseTimeMs,
                url: result.url,
                provider: 'etherscan',
                null_reasons: allFieldsNull(result.reason),
            };
        }

        const token = (Array.isArray(result.data.result) ? result.data.result[0] : undefined) as
            | TokenInfoEntry
            | undefined;

        if (!token) {
            return {
                data: emptyMetadata(),
                fetched_at: new Date(),
                response_time_ms: responseTimeMs,
                url: result.url,
                provider: 'etherscan',
                null_reasons: allFieldsNull('empty'),
            };
        }

        const data = {
            symbol: token.symbol != null && token.symbol !== '' ? token.symbol : null,
            decimals: token.divisor != null && token.divisor !== '' ? Number(token.divisor) : null,
            total_supply:
                typeof token.totalSupply === 'string' && token.totalSupply.length > 0 ? token.totalSupply : null,
        };
        const null_reasons: FieldNullReasons = {};
        if (data.symbol == null) null_reasons.symbol = 'empty';
        if (data.decimals == null) null_reasons.decimals = 'empty';
        if (data.total_supply == null) null_reasons.total_supply = 'empty';

        return {
            data,
            fetched_at: new Date(),
            response_time_ms: responseTimeMs,
            url: result.url,
            provider: 'etherscan',
            null_reasons,
        };
    }

    /** Etherscan V2 API call with retry, error handling, and metrics. */
    private async callApi(network: string, params: Record<string, string>): Promise<ApiResult> {
        const url = `${ETHERSCAN_V2_BASE}?${new URLSearchParams(params)}`;
        const { apikey: _, ...storedParams } = params;
        const storedUrl = `${ETHERSCAN_V2_BASE}?${new URLSearchParams(storedParams)}`;
        const label = `etherscan:${params.action}:${network}`;

        try {
            const callStart = Date.now();
            const { res, body } = await withRetry(
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
                        (body.status !== '1' &&
                            String(body.result ?? '')
                                .toLowerCase()
                                .includes('rate limit reached')),
                },
                label
            );
            providerDuration.observe({ provider: 'etherscan' }, (Date.now() - callStart) / 1000);

            if (!res.ok) {
                logger.warn(`${label}: HTTP ${res.status}`);
                providerRequests.inc({ provider: 'etherscan', network, status: 'error' });
                return { ok: false, reason: httpStatusToNullReason(res.status), url: storedUrl };
            }

            if (body.status !== '1') {
                logger.warn(`${label}: ${body.result}`);
                providerRequests.inc({ provider: 'etherscan', network, status: 'error' });
                return { ok: false, reason: parseEtherscanError(String(body.result ?? '')), url: storedUrl };
            }

            providerRequests.inc({ provider: 'etherscan', network, status: 'success' });
            return { ok: true, data: body, url: storedUrl };
        } catch (error) {
            logger.warn(`${label}: ${error}`);
            return { ok: false, reason: 'server_error', url: storedUrl };
        }
    }
}
