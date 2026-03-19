import { config } from '../config.js';
import { logger } from '../logger.js';
import { providerDuration, providerRequests } from '../metrics.js';
import { scaleDown } from '../utils/normalize.js';
import { withRetry } from '../utils/retry.js';
import {
    type ComparableEntry,
    httpStatusToNullReason,
    type NullReason,
    type Provider,
    type ProviderResult,
} from './types.js';

const SOLSCAN_BASE = 'https://pro-api.solscan.io/v2.0';
const METADATA_FIELDS = ['name', 'symbol', 'decimals', 'total_supply'] as const;

interface SolscanResponse<T> {
    success: boolean;
    data: T;
    errors?: { code: number; message: string };
}

interface SolscanTokenMeta {
    name: string;
    symbol: string;
    decimals: number;
    supply: string;
    holder: number;
}

interface SolscanHolderEntry {
    address: string;
    /** Solscan returns amount as a JSON number — values exceeding Number.MAX_SAFE_INTEGER lose precision at parse time. */
    amount: number;
    decimals: number;
    owner: string;
    rank: number;
}

interface SolscanHoldersData {
    total: number;
    items: SolscanHolderEntry[];
}

/** Classify a Solscan error response into a NullReason. */
function classifySolscanError(response: SolscanResponse<unknown>): NullReason {
    if (response.errors?.code === 1100) return 'not_found';
    return 'server_error';
}

/** Fetches token metadata and balances from the Solscan Pro API (Solana only). */
export class SolscanProvider implements Provider {
    name = 'solscan';

    supportsNetwork(network: string): boolean {
        return network === 'solana' && !!config.solscanApiKey;
    }

    async fetchMetadata(network: string, contract: string): Promise<ProviderResult> {
        const url = `${SOLSCAN_BASE}/token/meta?address=${contract}`;

        const start = Date.now();
        const result = await this.callApi<SolscanTokenMeta>(url, `solscan:meta:${contract}`);
        const responseTimeMs = Date.now() - start;
        providerDuration.observe({ provider: 'solscan', endpoint: 'metadata' }, responseTimeMs / 1000);

        const base = {
            domain: 'metadata',
            fetched_at: new Date(),
            response_time_ms: responseTimeMs,
            url,
            provider: 'solscan',
        };

        if (!result.ok) {
            providerRequests.inc({ provider: 'solscan', network, endpoint: 'metadata', status: 'error' });
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

        const data = result.data;
        if (!data.name && !data.symbol) {
            providerRequests.inc({ provider: 'solscan', network, endpoint: 'metadata', status: 'error' });
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

        providerRequests.inc({ provider: 'solscan', network, endpoint: 'metadata', status: 'success' });

        const totalSupply =
            data.supply != null && data.decimals != null
                ? scaleDown(data.supply, data.decimals)
                : (data.supply ?? null);

        const values: Record<string, string | null> = {
            name: data.name || null,
            symbol: data.symbol || null,
            decimals: data.decimals != null ? String(data.decimals) : null,
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
        const holdersUrl = `${SOLSCAN_BASE}/token/holders?address=${contract}&page_size=40`;

        const start = Date.now();
        const entries: ComparableEntry[] = [];
        let lastReason: NullReason | null = null;

        for (let page = 1; page <= 3; page++) {
            const pageUrl = `${holdersUrl}&page=${page}`;
            const result = await this.callApi<SolscanHoldersData>(pageUrl, `solscan:holders:${contract}:page${page}`);

            if (!result.ok) {
                providerRequests.inc({ provider: 'solscan', network, endpoint: 'balance', status: 'error' });
                lastReason = result.reason;
                break;
            }

            providerRequests.inc({ provider: 'solscan', network, endpoint: 'balance', status: 'success' });

            for (const entry of result.data.items ?? []) {
                entries.push({
                    field: 'balance',
                    entity: entry.address,
                    value: String(entry.amount),
                    null_reason: null,
                });
                if (entries.length >= 100) break;
            }

            if (entries.length >= 100 || (result.data.items ?? []).length < 40) break;
        }

        const responseTimeMs = Date.now() - start;
        providerDuration.observe({ provider: 'solscan', endpoint: 'balance' }, responseTimeMs / 1000);

        if (entries.length === 0 && !lastReason) lastReason = 'empty';

        if (lastReason) {
            return {
                domain: 'balance',
                entries: [{ field: 'balance', entity: '', value: null, null_reason: lastReason }],
                fetched_at: new Date(),
                response_time_ms: responseTimeMs,
                url: holdersUrl,
                provider: 'solscan',
            };
        }

        return {
            domain: 'balance',
            entries,
            fetched_at: new Date(),
            response_time_ms: responseTimeMs,
            url: holdersUrl,
            provider: 'solscan',
        };
    }

    private async callApi<T>(
        url: string,
        label: string
    ): Promise<{ ok: true; data: T } | { ok: false; reason: NullReason }> {
        try {
            const response = await withRetry(
                () => fetch(url, { headers: { token: config.solscanApiKey as string } }),
                {
                    maxAttempts: config.retryMaxAttempts,
                    baseDelay: config.retryBaseDelayMs,
                    shouldRetry: (res) => res.status === 429,
                },
                label
            );

            if (!response.ok) {
                logger.warn(`${label}: HTTP ${response.status}`);
                return { ok: false, reason: httpStatusToNullReason(response.status) };
            }

            const body = (await response.json()) as SolscanResponse<T>;

            if (!body.success) {
                logger.warn(`${label}: ${body.errors?.message ?? 'unknown error'}`);
                return { ok: false, reason: classifySolscanError(body) };
            }

            return { ok: true, data: body.data };
        } catch (error) {
            logger.warn(`${label}: ${error}`);
            return { ok: false, reason: 'server_error' };
        }
    }
}
