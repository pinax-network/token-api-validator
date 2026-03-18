import { NetworksRegistry } from '@pinax/graph-networks-registry';
import { config } from './config.js';
import { logger } from './logger.js';
import { withRetry } from './utils/retry.js';

interface NetworkProviders {
    blockscout_url: string | null;
    chain_id: number | null;
    rpc_urls: string[];
}

// Network ID mapping: CoinGecko platform → Token API network ID
export const PLATFORM_TO_NETWORK: Record<string, string> = {
    ethereum: 'mainnet',
    'binance-smart-chain': 'bsc',
    'polygon-pos': 'polygon',
    avalanche: 'avalanche',
    'arbitrum-one': 'arbitrum-one',
    'optimistic-ethereum': 'optimism',
    base: 'base',
    unichain: 'unichain',
    tron: 'tron',
    solana: 'solana',
};

// Registry network IDs that differ from Token API network IDs
const REGISTRY_TO_NETWORK: Record<string, string> = {
    matic: 'polygon',
};

// Sensible defaults — used before first registry sync and as the canonical list of supported networks
const DEFAULTS: Record<string, NetworkProviders> = {
    mainnet: { blockscout_url: 'https://eth.blockscout.com/api', chain_id: 1, rpc_urls: [] },
    base: { blockscout_url: 'https://base.blockscout.com/api', chain_id: 8453, rpc_urls: [] },
    'arbitrum-one': { blockscout_url: 'https://arbitrum.blockscout.com/api', chain_id: 42161, rpc_urls: [] },
    bsc: { blockscout_url: null, chain_id: 56, rpc_urls: [] },
    polygon: { blockscout_url: 'https://polygon.blockscout.com/api', chain_id: 137, rpc_urls: [] },
    optimism: { blockscout_url: 'https://optimism.blockscout.com/api', chain_id: 10, rpc_urls: [] },
    avalanche: { blockscout_url: null, chain_id: 43114, rpc_urls: [] },
    unichain: { blockscout_url: null, chain_id: 130, rpc_urls: [] },
};

// Synced from registry at startup and before each validation run
let providerMap: Record<string, NetworkProviders> = { ...DEFAULTS };

/** Look up the Blockscout API base URL for a network. */
export function getBlockscoutUrl(network: string): string | null {
    return providerMap[network]?.blockscout_url ?? null;
}

/** Look up the EVM chain ID for a network. */
export function getChainId(network: string): number | null {
    return providerMap[network]?.chain_id ?? null;
}

/** Look up the best RPC URL for a network. Prefers Pinax RPCs, falls back to first available. */
export function getRpcUrl(network: string): string | null {
    const urls = providerMap[network]?.rpc_urls ?? [];
    return urls.find((u) => u.includes('.rpc.service.pinax.network')) ?? urls[0] ?? null;
}

/** Parse a chain ID from a CAIP-2 identifier (e.g. "eip155:1" → 1). */
function parseChainId(caip2Id: string | undefined): number | null {
    if (!caip2Id) return null;
    const parts = caip2Id.split(':');
    if (parts[0] !== 'eip155' || !parts[1]) return null;
    const id = Number(parts[1]);
    return Number.isFinite(id) ? id : null;
}

/** Fetch the latest graph-networks-registry and refresh provider info. Falls back to last-known state on failure. */
export async function syncRegistry(): Promise<void> {
    try {
        const registry = await withRetry(
            () => NetworksRegistry.fromLatestVersion(),
            { maxAttempts: config.retryMaxAttempts, baseDelay: config.retryBaseDelayMs },
            'registry-sync'
        );

        const updated: Record<string, NetworkProviders> = { ...DEFAULTS };

        for (const network of registry.networks) {
            const networkId = REGISTRY_TO_NETWORK[network.id] ?? network.id;
            if (!updated[networkId]) continue;

            const chainId = parseChainId(network.caip2Id);
            if (chainId != null) updated[networkId].chain_id = chainId;

            for (const apiUrl of network.apiUrls ?? []) {
                if (apiUrl.kind === 'blockscout' && apiUrl.url) {
                    updated[networkId].blockscout_url = apiUrl.url;
                }
            }

            if (network.rpcUrls && network.rpcUrls.length > 0) {
                updated[networkId].rpc_urls = network.rpcUrls;
            }
        }

        providerMap = updated;
        logger.info(`Registry synced: ${Object.keys(updated).length} networks`);
    } catch (error) {
        logger.warn('Registry sync failed, using last-known state', error);
    }
}
