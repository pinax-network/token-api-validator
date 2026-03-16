import { config } from '../config.js';
import { logger } from '../logger.js';
import { providerDuration, providerRequests } from '../metrics.js';
import { getBlockscoutUrl } from '../registry.js';
import { scaleDown } from '../utils/normalize.js';
import { withRetry } from '../utils/retry.js';
import {
    type ComparableEntry,
    httpStatusToNullReason,
    type NullReason,
    type Provider,
    type ProviderResult,
} from './types.js';

/** Blockscout RPC module response for token metadata. */
interface BlockscoutTokenResponse {
    name: string;
    symbol: string;
    decimals: string;
    totalSupply: string;
    type: string;
}

/** Blockscout REST v2 response entry for a single holder. */
interface BlockscoutHolderEntry {
    address: { hash: string };
    value: string;
}

/** Blockscout REST v2 paginated holders response. */
interface BlockscoutHoldersResponse {
    items: BlockscoutHolderEntry[];
    next_page_params: Record<string, string> | null;
}

const METADATA_FIELDS = ['name', 'symbol', 'decimals', 'total_supply'] as const;

/** Fetches token metadata and balances from Blockscout block explorers. */
export class BlockscoutProvider implements Provider {
    name = 'blockscout';

    async fetchMetadata(network: string, contract: string): Promise<ProviderResult> {
        const baseUrl = getBlockscoutUrl(network);
        if (!baseUrl) throw new Error(`No Blockscout URL for network ${network}`);

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
        providerDuration.observe({ provider: 'blockscout', endpoint: 'metadata' }, responseTimeMs / 1000);

        const base = {
            domain: 'metadata',
            fetched_at: new Date(),
            response_time_ms: responseTimeMs,
            url,
            provider: 'blockscout',
            block_timestamp: null,
        };

        if (!response.ok) {
            providerRequests.inc({ provider: 'blockscout', network, endpoint: 'metadata', status: 'error' });
            logger.warn(`Blockscout returned ${response.status} for ${network}:${contract}`);
            const reason = httpStatusToNullReason(response.status);
            return {
                ...base,
                entries: METADATA_FIELDS.map((f) => ({ field: f, entity: '', value: null, null_reason: reason })),
            };
        }

        const body = await response.json();
        const token = (body as { result?: BlockscoutTokenResponse }).result;

        if (!token) {
            providerRequests.inc({ provider: 'blockscout', network, endpoint: 'metadata', status: 'error' });
            logger.warn(`Blockscout returned no result for ${network}:${contract}`);
            return {
                ...base,
                entries: METADATA_FIELDS.map((f) => ({ field: f, entity: '', value: null, null_reason: 'empty' })),
            };
        }

        providerRequests.inc({ provider: 'blockscout', network, endpoint: 'metadata', status: 'success' });

        const decimals = token.decimals != null ? Number(token.decimals) : null;
        const rawSupply = token.totalSupply ?? null;
        const totalSupply = rawSupply != null && decimals != null ? scaleDown(rawSupply, decimals) : rawSupply;

        const values: Record<string, string | null> = {
            name: token.name ?? null,
            symbol: token.symbol ?? null,
            decimals: decimals != null ? String(decimals) : null,
            total_supply: totalSupply,
        };

        const entries: ComparableEntry[] = METADATA_FIELDS.map((field) => ({
            field,
            entity: '',
            value: values[field] ?? null,
            null_reason: values[field] == null ? 'empty' : null,
        }));

        return { ...base, entries };
    }

    async fetchBalances(network: string, contract: string): Promise<ProviderResult> {
        const baseUrl = getBlockscoutUrl(network);
        if (!baseUrl) throw new Error(`No Blockscout URL for network ${network}`);

        const v2Base = baseUrl.replace(/\/api\/?$/, '');
        const holdersUrl = `${v2Base}/api/v2/tokens/${contract}/holders`;

        const start = Date.now();
        const entries: ComparableEntry[] = [];
        let nextParams: Record<string, string> | null = null;
        let pageUrl = holdersUrl;
        let lastReason: NullReason | null = null;
        const maxPages = 3;

        for (let page = 0; page < maxPages; page++) {
            if (page > 0 && nextParams) {
                const qs = new URLSearchParams(nextParams).toString();
                pageUrl = `${holdersUrl}?${qs}`;
            }

            const response = await withRetry(
                () => fetch(pageUrl),
                {
                    maxAttempts: config.retryMaxAttempts,
                    baseDelay: config.retryBaseDelayMs,
                    shouldRetry: (res) => res.status === 429,
                },
                `blockscout:balances:${network}:${contract}:page${page}`
            );

            if (!response.ok) {
                providerRequests.inc({ provider: 'blockscout', network, endpoint: 'balance', status: 'error' });
                logger.warn(`Blockscout balances returned ${response.status} for ${network}:${contract}`);
                lastReason = httpStatusToNullReason(response.status);
                break;
            }

            const body = (await response.json()) as BlockscoutHoldersResponse;
            providerRequests.inc({ provider: 'blockscout', network, endpoint: 'balance', status: 'success' });

            for (const entry of body.items ?? []) {
                entries.push({
                    field: 'balance',
                    entity: entry.address.hash.toLowerCase(),
                    value: entry.value,
                    null_reason: null,
                });
                if (entries.length >= 100) break;
            }

            if (entries.length >= 100 || !body.next_page_params) break;
            nextParams = body.next_page_params;
        }

        const responseTimeMs = Date.now() - start;
        providerDuration.observe({ provider: 'blockscout', endpoint: 'balance' }, responseTimeMs / 1000);

        if (entries.length === 0 && !lastReason) {
            lastReason = 'empty';
        }

        if (lastReason) {
            return {
                domain: 'balance',
                entries: [{ field: 'balance', entity: '', value: null, null_reason: lastReason }],
                fetched_at: new Date(),
                response_time_ms: responseTimeMs,
                url: holdersUrl,
                provider: 'blockscout',
                block_timestamp: null,
            };
        }

        return {
            domain: 'balance',
            entries,
            fetched_at: new Date(),
            response_time_ms: responseTimeMs,
            url: holdersUrl,
            provider: 'blockscout',
            block_timestamp: null,
        };
    }
}
