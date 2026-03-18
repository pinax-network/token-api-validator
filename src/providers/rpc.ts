import { type Address, createPublicClient, type Hex, hexToString, http } from 'viem';
import { config } from '../config.js';
import { providerDuration, providerRequests } from '../metrics.js';
import { getRpcUrl } from '../registry.js';
import { scaleDown } from '../utils/normalize.js';
import type { ComparableEntry, Provider, ProviderResult } from './types.js';

const METADATA_FIELDS = ['name', 'symbol', 'decimals', 'total_supply'] as const;

const erc20Abi = [
    { name: 'name', type: 'function', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
    { name: 'symbol', type: 'function', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
    { name: 'decimals', type: 'function', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
    { name: 'totalSupply', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const;

const erc20BalanceAbi = [
    {
        name: 'balanceOf',
        type: 'function',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ type: 'uint256' }],
        stateMutability: 'view',
    },
] as const;

const erc20Bytes32Abi = [
    { name: 'name', type: 'function', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
    { name: 'symbol', type: 'function', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
] as const;

/** Convert a bytes32 return (from pre-standard tokens like MKR/SAI) to a string. */
export function bytes32ToString(raw: Hex): string {
    return hexToString(raw, { size: 32 }).replace(/\0/g, '');
}

/** Reads ERC-20 metadata directly from smart contracts via JSON-RPC `eth_call`. */
export class RpcProvider implements Provider {
    name = 'rpc';

    supportsNetwork(network: string): boolean {
        return getRpcUrl(network) !== null;
    }

    async fetchMetadata(network: string, contract: string): Promise<ProviderResult> {
        const rpcUrl = getRpcUrl(network);
        if (!rpcUrl) {
            return {
                domain: 'metadata',
                entries: METADATA_FIELDS.map((f) => ({
                    field: f,
                    entity: '',
                    value: null,
                    null_reason: 'server_error' as const,
                })),
                fetched_at: new Date(),
                response_time_ms: 0,
                url: '',
                provider: 'rpc',
                block_timestamp: null,
            };
        }

        const start = Date.now();
        const client = createPublicClient({
            transport: http(rpcUrl, {
                batch: { wait: 0 },
                retryCount: config.retryMaxAttempts - 1,
                retryDelay: config.retryBaseDelayMs,
            }),
        });
        const address = contract as Address;

        const blockNumber = await client.getBlockNumber();

        const [nameResult, symbolResult, decimalsResult, totalSupplyResult, blockResult] = await Promise.allSettled([
            readStringField(client, address, 'name', blockNumber),
            readStringField(client, address, 'symbol', blockNumber),
            client.readContract({ address, abi: erc20Abi, functionName: 'decimals', blockNumber }),
            client.readContract({ address, abi: erc20Abi, functionName: 'totalSupply', blockNumber }),
            client.getBlock({ blockNumber }),
        ]);

        const responseTimeMs = Date.now() - start;
        providerDuration.observe({ provider: 'rpc', endpoint: 'metadata' }, responseTimeMs / 1000);

        const blockTimestamp =
            blockResult.status === 'fulfilled' ? new Date(Number(blockResult.value.timestamp) * 1000) : null;

        // All calls failed → likely EOA or non-ERC20 contract
        if (
            nameResult.status === 'rejected' &&
            symbolResult.status === 'rejected' &&
            decimalsResult.status === 'rejected' &&
            totalSupplyResult.status === 'rejected'
        ) {
            providerRequests.inc({ provider: 'rpc', network, endpoint: 'metadata', status: 'error' });
            return {
                domain: 'metadata',
                entries: METADATA_FIELDS.map((f) => ({
                    field: f,
                    entity: '',
                    value: null,
                    null_reason: 'empty' as const,
                })),
                fetched_at: new Date(),
                response_time_ms: responseTimeMs,
                url: rpcUrl,
                provider: 'rpc',
                block_timestamp: blockTimestamp,
            };
        }

        const entries: ComparableEntry[] = [];

        // name
        const name = nameResult.status === 'fulfilled' ? nameResult.value : null;
        entries.push({
            field: 'name',
            entity: '',
            value: name || null,
            null_reason: name ? null : reasonFromSettled(nameResult),
        });

        // symbol
        const symbol = symbolResult.status === 'fulfilled' ? symbolResult.value : null;
        entries.push({
            field: 'symbol',
            entity: '',
            value: symbol || null,
            null_reason: symbol ? null : reasonFromSettled(symbolResult),
        });

        // decimals
        const decimals = decimalsResult.status === 'fulfilled' ? decimalsResult.value : null;
        entries.push({
            field: 'decimals',
            entity: '',
            value: decimals != null ? String(decimals) : null,
            null_reason: decimals != null ? null : reasonFromSettled(decimalsResult),
        });

        // total_supply
        let totalSupply: string | null = null;
        if (totalSupplyResult.status === 'fulfilled') {
            const raw = totalSupplyResult.value;
            totalSupply = decimals != null ? scaleDown(raw.toString(), decimals) : raw.toString();
        }
        entries.push({
            field: 'total_supply',
            entity: '',
            value: totalSupply,
            null_reason: totalSupply != null ? null : reasonFromSettled(totalSupplyResult),
        });

        providerRequests.inc({ provider: 'rpc', network, endpoint: 'metadata', status: 'success' });
        return {
            domain: 'metadata',
            entries,
            fetched_at: new Date(),
            response_time_ms: responseTimeMs,
            url: rpcUrl,
            provider: 'rpc',
            block_timestamp: blockTimestamp,
        };
    }

    async fetchBalances(network: string, contract: string, holders?: string[]): Promise<ProviderResult> {
        const rpcUrl = getRpcUrl(network);
        if (!rpcUrl || !holders || holders.length === 0) {
            return {
                domain: 'balance',
                entries: [],
                fetched_at: new Date(),
                response_time_ms: 0,
                url: '',
                provider: 'rpc',
                block_timestamp: null,
            };
        }

        const start = Date.now();
        const client = createPublicClient({
            transport: http(rpcUrl, {
                batch: { wait: 0 },
                retryCount: config.retryMaxAttempts - 1,
                retryDelay: config.retryBaseDelayMs,
            }),
        });
        const address = contract as Address;

        const blockNumber = await client.getBlockNumber();

        const [balanceResults, blockResult] = await Promise.all([
            Promise.allSettled(
                holders.map((holder) =>
                    client.readContract({
                        address,
                        abi: erc20BalanceAbi,
                        functionName: 'balanceOf',
                        args: [holder as Address],
                        blockNumber,
                    })
                )
            ),
            client.getBlock({ blockNumber }).catch(() => null),
        ]);

        const responseTimeMs = Date.now() - start;
        providerDuration.observe({ provider: 'rpc', endpoint: 'balance' }, responseTimeMs / 1000);

        const blockTimestamp = blockResult ? new Date(Number(blockResult.timestamp) * 1000) : null;

        const entries: ComparableEntry[] = [];
        for (let i = 0; i < holders.length; i++) {
            const result = balanceResults[i];
            if (result?.status === 'fulfilled') {
                entries.push({
                    field: 'balance',
                    entity: holders[i] as string,
                    value: result.value.toString(),
                    null_reason: null,
                });
            } else {
                entries.push({
                    field: 'balance',
                    entity: holders[i] as string,
                    value: null,
                    null_reason: 'server_error',
                });
            }
        }

        const hasSuccesses = entries.some((e) => e.value !== null);
        providerRequests.inc({
            provider: 'rpc',
            network,
            endpoint: 'balance',
            status: hasSuccesses ? 'success' : 'error',
        });
        return {
            domain: 'balance',
            entries,
            fetched_at: new Date(),
            response_time_ms: responseTimeMs,
            url: rpcUrl,
            provider: 'rpc',
            block_timestamp: blockTimestamp,
        };
    }
}

/** Read a string field with bytes32 fallback for pre-standard tokens (MKR, SAI). */
async function readStringField(
    client: ReturnType<typeof createPublicClient>,
    address: Address,
    functionName: 'name' | 'symbol',
    blockNumber: bigint
): Promise<string> {
    try {
        return await client.readContract({ address, abi: erc20Abi, functionName, blockNumber });
    } catch {
        const raw = await client.readContract({ address, abi: erc20Bytes32Abi, functionName, blockNumber });
        return bytes32ToString(raw);
    }
}

function reasonFromSettled(result: PromiseSettledResult<unknown>): 'empty' | 'server_error' {
    if (result.status === 'fulfilled') return 'empty';
    return 'server_error';
}
