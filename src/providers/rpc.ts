import {
    type Address,
    BaseError,
    createPublicClient,
    type Hex,
    HttpRequestError,
    hexToString,
    http,
    RpcRequestError,
} from 'viem';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { providerDuration, providerRequests } from '../metrics.js';
import { getRpcUrl } from '../registry.js';
import { scaleDown } from '../utils/normalize.js';
import {
    type ComparableEntry,
    httpStatusToNullReason,
    type NullReason,
    type Provider,
    type ProviderResult,
    rpcCodeToNullReason,
} from './types.js';

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

/**
 * Classify a viem error into a NullReason by walking the cause chain.
 *
 * Viem wraps errors in layers: ContractFunctionExecutionError → CallExecutionError → root cause.
 * The root cause is either HttpRequestError (HTTP-level, has `.status`) or RpcRequestError
 * (JSON-RPC-level, has `.code`). We use viem's `.walk(predicate)` to find the relevant layer.
 */
export function classifyViemError(error: unknown): NullReason {
    if (error instanceof BaseError) {
        const httpErr = error.walk((e) => e instanceof HttpRequestError);
        if (httpErr instanceof HttpRequestError && httpErr.status) {
            return httpStatusToNullReason(httpErr.status);
        }

        const rpcErr = error.walk((e) => e instanceof RpcRequestError);
        if (rpcErr instanceof RpcRequestError) {
            return rpcCodeToNullReason(rpcErr.code);
        }
    }

    // Fallback for unwrapped HttpRequestError or non-viem errors
    if (error instanceof HttpRequestError && error.status) {
        return httpStatusToNullReason(error.status);
    }

    return 'server_error';
}

/** Strip the API key path segment from a Pinax RPC URL for safe storage. */
export function stripRpcApiKey(url: string): string {
    return url.replace(/\/v1\/[a-f0-9]+\/?/, '/');
}

/** Redact any Pinax RPC API key from an error before it leaves the provider. */
function sanitizeError(error: unknown): Error {
    if (error instanceof Error) {
        const sanitized = new Error(stripRpcApiKey(error.message));
        sanitized.stack = error.stack ? stripRpcApiKey(error.stack) : undefined;
        return sanitized;
    }
    return new Error(stripRpcApiKey(String(error)));
}

/** Convert a bytes32 return (from pre-standard tokens like MKR/SAI) to a string. */
export function bytes32ToString(raw: Hex): string {
    return hexToString(raw, { size: 32 }).replace(/\0/g, '');
}

/** Reads ERC-20 metadata directly from smart contracts via JSON-RPC `eth_call`. */
export class RpcProvider implements Provider {
    name = 'rpc';
    private clients = new Map<string, ReturnType<typeof createPublicClient>>();

    /** Get or create a viem client for the given RPC URL. Reusing clients avoids connection churn that triggers 400s. */
    private getClient(rpcUrl: string): ReturnType<typeof createPublicClient> {
        let client = this.clients.get(rpcUrl);
        if (!client) {
            client = createPublicClient({
                transport: http(rpcUrl, {
                    batch: { wait: 0, batchSize: config.rpcBatchSize },
                    retryCount: config.retryMaxAttempts - 1,
                    retryDelay: config.retryBaseDelayMs,
                }),
            });
            this.clients.set(rpcUrl, client);
        }
        return client;
    }

    supportsNetwork(network: string): boolean {
        return getRpcUrl(network) !== null;
    }

    async fetchMetadata(network: string, contract: string, blockNumber?: number | null): Promise<ProviderResult> {
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
        const client = this.getClient(rpcUrl);
        const address = contract as Address;

        let resolvedBlock: bigint;
        try {
            resolvedBlock = blockNumber != null ? BigInt(blockNumber) : await client.getBlockNumber();
        } catch (error) {
            throw sanitizeError(error);
        }

        const [nameResult, symbolResult, decimalsResult, totalSupplyResult, blockResult] = await Promise.allSettled([
            readStringField(client, address, 'name', resolvedBlock),
            readStringField(client, address, 'symbol', resolvedBlock),
            client.readContract({ address, abi: erc20Abi, functionName: 'decimals', blockNumber: resolvedBlock }),
            client.readContract({ address, abi: erc20Abi, functionName: 'totalSupply', blockNumber: resolvedBlock }),
            client.getBlock({ blockNumber: resolvedBlock }),
        ]);

        const responseTimeMs = Date.now() - start;
        providerDuration.observe({ provider: 'rpc', endpoint: 'metadata' }, responseTimeMs / 1000);

        const storedUrl = `${stripRpcApiKey(rpcUrl)}#contract=${contract}&block=${resolvedBlock}`;
        const blockTimestamp =
            blockResult.status === 'fulfilled' ? new Date(Number(blockResult.value.timestamp) * 1000) : null;

        // All calls failed → likely EOA or non-ERC20 contract
        if (
            nameResult.status === 'rejected' &&
            symbolResult.status === 'rejected' &&
            decimalsResult.status === 'rejected' &&
            totalSupplyResult.status === 'rejected'
        ) {
            const reason = classifyViemError(nameResult.reason);
            providerRequests.inc({ provider: 'rpc', network, endpoint: 'metadata', status: 'error' });
            return {
                domain: 'metadata',
                entries: METADATA_FIELDS.map((f) => ({
                    field: f,
                    entity: '',
                    value: null,
                    null_reason: reason,
                })),
                fetched_at: new Date(),
                response_time_ms: responseTimeMs,
                url: storedUrl,
                provider: 'rpc',
                block_timestamp: blockTimestamp,
            };
        }

        /** Null reason for a metadata field: null if value present, classified error if rejected, 'empty' if fulfilled but no data. */
        const nullReason = (value: unknown, result: PromiseSettledResult<unknown>): NullReason | null =>
            value != null && value !== ''
                ? null
                : result.status === 'rejected'
                  ? classifyViemError(result.reason)
                  : 'empty';

        const entries: ComparableEntry[] = [];

        const name = nameResult.status === 'fulfilled' ? nameResult.value : null;
        entries.push({ field: 'name', entity: '', value: name || null, null_reason: nullReason(name, nameResult) });

        const symbol = symbolResult.status === 'fulfilled' ? symbolResult.value : null;
        entries.push({
            field: 'symbol',
            entity: '',
            value: symbol || null,
            null_reason: nullReason(symbol, symbolResult),
        });

        const decimals = decimalsResult.status === 'fulfilled' ? decimalsResult.value : null;
        entries.push({
            field: 'decimals',
            entity: '',
            value: decimals != null ? String(decimals) : null,
            null_reason: nullReason(decimals, decimalsResult),
        });

        let totalSupply: string | null = null;
        if (totalSupplyResult.status === 'fulfilled') {
            const raw = totalSupplyResult.value;
            totalSupply = decimals != null ? scaleDown(raw.toString(), decimals) : raw.toString();
        }
        entries.push({
            field: 'total_supply',
            entity: '',
            value: totalSupply,
            null_reason: nullReason(totalSupply, totalSupplyResult),
        });

        providerRequests.inc({ provider: 'rpc', network, endpoint: 'metadata', status: 'success' });
        return {
            domain: 'metadata',
            entries,
            fetched_at: new Date(),
            response_time_ms: responseTimeMs,
            url: storedUrl,
            provider: 'rpc',
            block_timestamp: blockTimestamp,
        };
    }

    async fetchBalances(
        network: string,
        contract: string,
        holders?: string[],
        blockNumber?: number | null
    ): Promise<ProviderResult> {
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
        const client = this.getClient(rpcUrl);
        const address = contract as Address;

        let resolvedBlock: bigint;
        try {
            resolvedBlock = blockNumber != null ? BigInt(blockNumber) : await client.getBlockNumber();
        } catch (error) {
            throw sanitizeError(error);
        }

        const [balanceResults, blockResult] = await Promise.all([
            Promise.allSettled(
                holders.map((holder) =>
                    client.readContract({
                        address,
                        abi: erc20BalanceAbi,
                        functionName: 'balanceOf',
                        args: [holder as Address],
                        blockNumber: resolvedBlock,
                    })
                )
            ),
            client.getBlock({ blockNumber: resolvedBlock }).catch(() => null),
        ]);

        const responseTimeMs = Date.now() - start;
        providerDuration.observe({ provider: 'rpc', endpoint: 'balance' }, responseTimeMs / 1000);

        const storedUrl = `${stripRpcApiKey(rpcUrl)}#contract=${contract}&block=${resolvedBlock}`;
        const blockTimestamp = blockResult ? new Date(Number(blockResult.timestamp) * 1000) : null;

        const entries: ComparableEntry[] = [];
        const failureCounts = new Map<NullReason, number>();
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
                const reason = classifyViemError(result?.reason);
                failureCounts.set(reason, (failureCounts.get(reason) ?? 0) + 1);
                entries.push({
                    field: 'balance',
                    entity: holders[i] as string,
                    value: null,
                    null_reason: reason,
                });
            }
        }

        if (failureCounts.size > 0) {
            const summary = [...failureCounts.entries()].map(([r, n]) => `${n} ${r}`).join(', ');
            const firstErr = balanceResults.find((r) => r.status === 'rejected');
            const reason = firstErr?.status === 'rejected' ? firstErr.reason : undefined;
            let detail = '';
            if (reason instanceof BaseError) {
                const httpErr = reason.walk((e) => e instanceof HttpRequestError);
                const status = httpErr instanceof HttpRequestError ? httpErr.status : undefined;
                detail = status
                    ? ` — HTTP ${status}: ${reason.details}`
                    : ` — ${reason.shortMessage} (${reason.details})`;
            }
            logger.warn(`RPC balanceOf failures for ${contract} on ${network}: ${summary}${detail}`);
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
            url: storedUrl,
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
