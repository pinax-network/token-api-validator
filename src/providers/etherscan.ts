import { config } from '../config.js';
import { logger } from '../logger.js';
import { providerDuration, providerRequests } from '../metrics.js';
import { getChainId } from '../registry.js';
import { scaleDown, scaleUp } from '../utils/normalize.js';
import { withRetry } from '../utils/retry.js';
import {
    type ComparableEntry,
    httpStatusToNullReason,
    type NullReason,
    type Provider,
    type ProviderResult,
} from './types.js';

const ETHERSCAN_V2_BASE = 'https://api.etherscan.io/v2/api';

interface EtherscanResponse {
    status: string;
    message: string;
    result: unknown;
}

/** Etherscan V2 `token/tokeninfo` response entry. */
interface TokenInfoEntry {
    contractAddress: string;
    tokenName: string;
    symbol: string;
    divisor: string;
    totalSupply: string;
    tokenType: string;
}

/** Etherscan V2 `token/topholders` response entry. */
interface TopHolderEntry {
    TokenHolderAddress: string;
    TokenHolderQuantity: string;
}

/**
 * Parse Etherscan error body into a NullReason.
 *
 * Matches exact strings from https://docs.etherscan.io/resources/common-error-messages
 */
export function parseEtherscanError(result: string): NullReason {
    if (result === 'Missing/Invalid API Key') return 'paid_plan_required';
    if (result === 'Invalid API Key') return 'forbidden';
    if (result === 'API key not eligible for this endpoint') return 'paid_plan_required';
    if (result === 'Max rate limit reached') return 'rate_limited';
    if (result === 'Max calls per sec rate limit reached (5/sec)') return 'rate_limited';
    if (result.includes('Missing Or invalid Action name')) return 'server_error';
    if (result.includes('No token found')) return 'not_found';
    return 'server_error';
}

type ApiResult = { ok: true; data: EtherscanResponse; url: string } | { ok: false; reason: NullReason; url: string };

const METADATA_FIELDS = ['name', 'symbol', 'decimals', 'total_supply'] as const;

/**
 * Fetches token metadata and balances from Etherscan V2 unified API.
 * Requires a paid API plan — if the plan lapses, all fields will return `paid_plan_required`.
 */
export class EtherscanProvider implements Provider {
    name = 'etherscan';

    supportsNetwork(network: string): boolean {
        return getChainId(network) !== null;
    }

    private decimalsLookup = new Map<string, number>();

    private lookupKey(network: string, contract: string): string {
        return `${network}:${contract.toLowerCase()}`;
    }

    async fetchMetadata(network: string, contract: string): Promise<ProviderResult> {
        const chainId = getChainId(network);
        if (chainId == null) throw new Error(`No chain ID for network ${network}`);

        const params: Record<string, string> = {
            chainid: String(chainId),
            contractaddress: contract,
            module: 'token',
            action: 'tokeninfo',
        };
        if (config.etherscanApiKey) params.apikey = config.etherscanApiKey;

        const start = Date.now();
        const result = await this.callApi(network, params, 'metadata');
        const responseTimeMs = Date.now() - start;

        const base = {
            domain: 'metadata',
            fetched_at: new Date(),
            response_time_ms: responseTimeMs,
            url: result.url,
            provider: 'etherscan',
        };

        if (!result.ok) {
            return {
                ...base,
                entries: METADATA_FIELDS.map((f) => ({
                    field: f,
                    entity: '',
                    value: null,
                    null_reason: result.reason,
                })),
            };
        }

        const token = (Array.isArray(result.data.result) ? result.data.result[0] : undefined) as
            | TokenInfoEntry
            | undefined;

        if (!token) {
            return {
                ...base,
                entries: METADATA_FIELDS.map((f) => ({
                    field: f,
                    entity: '',
                    value: null,
                    null_reason: 'empty' as const,
                })),
            };
        }

        const decimals = token.divisor != null && token.divisor !== '' ? Number(token.divisor) : null;
        if (decimals != null) {
            this.decimalsLookup.set(this.lookupKey(network, contract), decimals);
        }
        const rawSupply =
            typeof token.totalSupply === 'string' && token.totalSupply.length > 0 ? token.totalSupply : null;
        const totalSupply = rawSupply != null && decimals != null ? scaleDown(rawSupply, decimals) : rawSupply;

        const values: Record<string, string | null> = {
            name: token.tokenName != null && token.tokenName !== '' ? token.tokenName : null,
            symbol: token.symbol != null && token.symbol !== '' ? token.symbol : null,
            decimals: decimals != null ? String(decimals) : null,
            total_supply: totalSupply,
        };

        const entries: ComparableEntry[] = METADATA_FIELDS.map((field) => ({
            field,
            entity: '',
            value: values[field] ?? null,
            null_reason: values[field] == null ? ('empty' as const) : null,
        }));

        return { ...base, entries };
    }

    async fetchBalances(network: string, contract: string): Promise<ProviderResult> {
        const chainId = getChainId(network);
        if (chainId == null) throw new Error(`No chain ID for network ${network}`);

        const decimals = await this.getDecimals(network, contract);
        if (decimals == null) {
            logger.warn(`Etherscan: no decimals for ${network}:${contract}, skipping balance fetch`);
            return {
                domain: 'balance',
                entries: [{ field: 'balance', entity: '', value: null, null_reason: 'server_error' }],
                fetched_at: new Date(),
                response_time_ms: 0,
                url: '',
                provider: 'etherscan',
            };
        }

        const params: Record<string, string> = {
            chainid: String(chainId),
            contractaddress: contract,
            module: 'token',
            action: 'topholders',
            offset: '100',
        };
        if (config.etherscanApiKey) params.apikey = config.etherscanApiKey;

        const start = Date.now();
        const result = await this.callApi(network, params, 'balance');
        const responseTimeMs = Date.now() - start;

        const storedParams = { ...params };
        delete storedParams.apikey;
        const storedUrl = `${ETHERSCAN_V2_BASE}?${new URLSearchParams(storedParams)}`;
        const base = {
            domain: 'balance',
            fetched_at: new Date(),
            response_time_ms: responseTimeMs,
            url: storedUrl,
            provider: 'etherscan',
        };

        if (!result.ok) {
            return { ...base, entries: [{ field: 'balance', entity: '', value: null, null_reason: result.reason }] };
        }

        const rawEntries = Array.isArray(result.data.result) ? (result.data.result as TopHolderEntry[]) : [];
        const entries: ComparableEntry[] = rawEntries.map((e) => ({
            field: 'balance',
            entity: e.TokenHolderAddress.toLowerCase(),
            value: decimals != null ? scaleUp(e.TokenHolderQuantity, decimals) : e.TokenHolderQuantity,
            null_reason: null,
        }));

        if (entries.length === 0) {
            return { ...base, entries: [{ field: 'balance', entity: '', value: null, null_reason: 'empty' }] };
        }

        return { ...base, entries };
    }

    /** Get decimals for a contract, using the lookup table or fetching metadata on miss. */
    private async getDecimals(network: string, contract: string): Promise<number | null> {
        const key = this.lookupKey(network, contract);
        const cached = this.decimalsLookup.get(key);
        if (cached != null) return cached;

        const metadata = await this.fetchMetadata(network, contract);
        const decimalsEntry = metadata.entries.find((e) => e.field === 'decimals');
        return decimalsEntry?.value != null ? Number(decimalsEntry.value) : null;
    }

    /** Etherscan V2 API call with retry, error handling, and metrics. */
    private async callApi(network: string, params: Record<string, string>, endpoint: string): Promise<ApiResult> {
        const url = `${ETHERSCAN_V2_BASE}?${new URLSearchParams(params)}`;
        const { apikey: _, ...storedParams } = params;
        const storedUrl = `${ETHERSCAN_V2_BASE}?${new URLSearchParams(storedParams)}`;
        const label = `etherscan:${params.action}:${network}`;

        try {
            const callStart = Date.now();
            let lastBody: EtherscanResponse | undefined;

            const res = await withRetry(
                async () => {
                    const r = await fetch(url);
                    lastBody = (await r.json()) as EtherscanResponse;
                    return r;
                },
                {
                    maxAttempts: config.retryMaxAttempts,
                    baseDelay: config.retryBaseDelayMs,
                    shouldRetry: () => {
                        const msg = String(lastBody?.result ?? '');
                        return msg.includes('rate limit') || msg.includes('Max rate limit');
                    },
                },
                label
            );
            providerDuration.observe({ provider: 'etherscan', endpoint }, (Date.now() - callStart) / 1000);

            if (!res.ok) {
                logger.warn(`${label}: HTTP ${res.status}`);
                providerRequests.inc({ provider: 'etherscan', network, endpoint, status: 'error' });
                return { ok: false, reason: httpStatusToNullReason(res.status), url: storedUrl };
            }

            const body = lastBody as EtherscanResponse;

            if (body.status !== '1') {
                logger.warn(`${label}: ${body.result}`);
                providerRequests.inc({ provider: 'etherscan', network, endpoint, status: 'error' });
                return { ok: false, reason: parseEtherscanError(String(body.result ?? '')), url: storedUrl };
            }

            providerRequests.inc({ provider: 'etherscan', network, endpoint, status: 'success' });
            return { ok: true, data: body, url: storedUrl };
        } catch (error) {
            logger.warn(`${label}: ${error}`);
            providerRequests.inc({ provider: 'etherscan', network, endpoint, status: 'error' });
            return { ok: false, reason: 'server_error', url: storedUrl };
        }
    }
}
