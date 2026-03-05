import { NetworksRegistry } from '@pinax/graph-networks-registry';
import { config } from './config.js';
import { logger } from './logger.js';
import { withRetry } from './utils/retry.js';

/** Available reference providers for a network: Blockscout URL and/or EVM chain ID (for Etherscan V2). */
export interface NetworkProviders {
    blockscout_url: string | null;
    chain_id: number | null;
}

/** A single reference provider option — either a Blockscout URL or an Etherscan chain ID. */
export type ProviderChoice = { kind: 'blockscout'; url: string } | { kind: 'etherscan'; chain_id: number };

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

// Registry network IDs → Token API network IDs (where they differ)
const REGISTRY_TO_NETWORK: Record<string, string> = {
    mainnet: 'mainnet',
    bsc: 'bsc',
    matic: 'polygon',
    avalanche: 'avalanche',
    'arbitrum-one': 'arbitrum-one',
    optimism: 'optimism',
    base: 'base',
    unichain: 'unichain',
};

// Sensible defaults — used before first registry sync
const DEFAULTS: Record<string, NetworkProviders> = {
    mainnet: { blockscout_url: 'https://eth.blockscout.com/api', chain_id: 1 },
    base: { blockscout_url: 'https://base.blockscout.com/api', chain_id: 8453 },
    'arbitrum-one': { blockscout_url: 'https://arbitrum.blockscout.com/api', chain_id: 42161 },
    bsc: { blockscout_url: null, chain_id: 56 },
    polygon: { blockscout_url: 'https://polygon.blockscout.com/api', chain_id: 137 },
    optimism: { blockscout_url: 'https://optimism.blockscout.com/api', chain_id: 10 },
    avalanche: { blockscout_url: null, chain_id: 43114 },
    unichain: { blockscout_url: null, chain_id: 130 },
};

// Synced from registry at startup and before each validation run
let providerMap: Record<string, NetworkProviders> = { ...DEFAULTS };

/** Return all available reference providers for a network (Blockscout and/or Etherscan). */
export function getAvailableProviders(network: string): ProviderChoice[] {
    const info = providerMap[network];
    if (!info) return [];

    const providers: ProviderChoice[] = [];

    if (info.blockscout_url) {
        providers.push({ kind: 'blockscout', url: info.blockscout_url });
    }

    if (info.chain_id != null) {
        providers.push({ kind: 'etherscan', chain_id: info.chain_id });
    }

    return providers;
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

            if (!DEFAULTS[networkId] && !Object.values(REGISTRY_TO_NETWORK).includes(networkId)) {
                continue;
            }

            const info: NetworkProviders = {
                blockscout_url: updated[networkId]?.blockscout_url ?? null,
                chain_id: updated[networkId]?.chain_id ?? parseChainId(network.caip2Id),
            };

            for (const apiUrl of network.apiUrls ?? []) {
                if (apiUrl.kind === 'blockscout' && apiUrl.url) {
                    info.blockscout_url = apiUrl.url;
                }
            }

            // Extract chain ID from registry if not already set
            const registryChainId = parseChainId(network.caip2Id);
            if (registryChainId != null) {
                info.chain_id = registryChainId;
            }

            updated[networkId] = info;
        }

        providerMap = updated;
        logger.info(`Registry synced: ${Object.keys(updated).length} networks`);
    } catch (error) {
        logger.warn('Registry sync failed, using last-known state', error);
    }
}
