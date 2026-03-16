import { config } from '../config.js';
import { logger } from '../logger.js';
import { providerDuration, providerRequests } from '../metrics.js';
import { getBlockscoutUrl } from '../registry.js';
import { scaleDown } from '../utils/normalize.js';
import { withRetry } from '../utils/retry.js';
import {
    allFieldsNull,
    type BalanceEntry,
    type BalancesResult,
    emptyMetadata,
    httpStatusToNullReason,
    type MetadataResult,
    type NullReason,
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

/** Fetches token metadata and balances from Blockscout block explorers. */
export class BlockscoutProvider {
    name = 'blockscout';

    async fetchMetadata(network: string, contract: string): Promise<MetadataResult> {
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

        const result: MetadataResult = {
            data: emptyMetadata(),
            fetched_at: new Date(),
            response_time_ms: responseTimeMs,
            url,
            provider: 'blockscout',
            null_reasons: {},
        };

        if (!response.ok) {
            providerRequests.inc({ provider: 'blockscout', network, endpoint: 'metadata', status: 'error' });
            logger.warn(`Blockscout returned ${response.status} for ${network}:${contract}`);
            result.null_reasons = allFieldsNull(httpStatusToNullReason(response.status));
            return result;
        }

        const body = await response.json();
        const token = (body as { result?: BlockscoutTokenResponse }).result;

        if (!token) {
            providerRequests.inc({ provider: 'blockscout', network, endpoint: 'metadata', status: 'error' });
            logger.warn(`Blockscout returned no result for ${network}:${contract}`);
            result.null_reasons = allFieldsNull('empty');
            return result;
        }

        providerRequests.inc({ provider: 'blockscout', network, endpoint: 'metadata', status: 'success' });

        const decimals = token.decimals != null ? Number(token.decimals) : null;
        const rawSupply = token.totalSupply ?? null;
        const totalSupply = rawSupply != null && decimals != null ? scaleDown(rawSupply, decimals) : rawSupply;

        result.data = {
            name: token.name ?? null,
            symbol: token.symbol ?? null,
            decimals,
            total_supply: totalSupply,
        };

        if (result.data.name == null) result.null_reasons.name = 'empty';
        if (result.data.symbol == null) result.null_reasons.symbol = 'empty';
        if (result.data.decimals == null) result.null_reasons.decimals = 'empty';
        if (result.data.total_supply == null) result.null_reasons.total_supply = 'empty';

        return result;
    }

    async fetchBalances(network: string, contract: string): Promise<BalancesResult> {
        const baseUrl = getBlockscoutUrl(network);
        if (!baseUrl) throw new Error(`No Blockscout URL for network ${network}`);

        // REST v2 uses a different base URL pattern than the RPC module API.
        // baseUrl is e.g. "https://eth.blockscout.com/api" — strip "/api" to get the v2 base.
        const v2Base = baseUrl.replace(/\/api\/?$/, '');
        const holdersUrl = `${v2Base}/api/v2/tokens/${contract}/holders`;

        const start = Date.now();
        const balances: BalanceEntry[] = [];
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
                balances.push({
                    address: entry.address.hash.toLowerCase(),
                    balance: entry.value,
                });
                if (balances.length >= 100) break;
            }

            if (balances.length >= 100 || !body.next_page_params) break;
            nextParams = body.next_page_params;
        }

        const responseTimeMs = Date.now() - start;
        providerDuration.observe({ provider: 'blockscout', endpoint: 'balance' }, responseTimeMs / 1000);

        if (balances.length === 0 && !lastReason) {
            lastReason = 'empty';
        }

        return {
            balances,
            fetched_at: new Date(),
            response_time_ms: responseTimeMs,
            url: holdersUrl,
            provider: 'blockscout',
            null_reason: lastReason,
            block_timestamp: null,
        };
    }
}
