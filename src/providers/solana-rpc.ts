import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import bs58 from 'bs58';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { providerDuration, providerRequests } from '../metrics.js';
import { withRetry } from '../utils/retry.js';
import {
    type ComparableEntry,
    httpStatusToNullReason,
    type NullReason,
    type Provider,
    type ProviderResult,
    rpcCodeToNullReason,
} from './types.js';

const DRPC_SOLANA_URL = 'https://lb.drpc.org/ogrpc?network=solana';

/**
 * Metaplex Token Metadata Program — the standard for on-chain name/symbol on Solana.
 * Immutable (no upgrade authority), used by virtually all SPL tokens.
 * https://github.com/metaplex-foundation/mpl-token-metadata
 */
const METADATA_PROGRAM_ID = bs58.decode('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

// --- PDA derivation ---

/**
 * Derive the Metaplex Token Metadata PDA for a given SPL token mint.
 * Seeds: ["metadata", METADATA_PROGRAM_ID, mint_pubkey]
 * Follows the Solana PDA algorithm: find a bump seed (255..0) such that
 * SHA-256(seeds || bump || program_id || "ProgramDerivedAddress") is NOT on the ed25519 curve.
 */
export function deriveMetadataPDA(mintBase58: string): string {
    const mintBytes = bs58.decode(mintBase58);
    const seeds = [new TextEncoder().encode('metadata'), METADATA_PROGRAM_ID, mintBytes];
    const suffix = new TextEncoder().encode('ProgramDerivedAddress');

    const concatBytes = (...arrays: Uint8Array[]): Uint8Array => {
        const total = arrays.reduce((sum, a) => sum + a.length, 0);
        const result = new Uint8Array(total);
        let offset = 0;
        for (const a of arrays) {
            result.set(a, offset);
            offset += a.length;
        }
        return result;
    };

    const isOnCurve = (point: Uint8Array): boolean => {
        try {
            ed25519.ExtendedPoint.fromHex(point);
            return true;
        } catch {
            return false;
        }
    };

    for (let bump = 255; bump >= 0; bump--) {
        const hash = sha256(concatBytes(...seeds, new Uint8Array([bump]), METADATA_PROGRAM_ID, suffix));
        if (!isOnCurve(hash)) return bs58.encode(hash);
    }

    throw new Error(`Could not derive PDA for mint ${mintBase58}`);
}

// --- Metaplex binary parsing ---

/**
 * Parse name and symbol from a Metaplex Token Metadata account's raw data.
 *
 * Layout (v1):
 *   1 byte:  key (account type discriminator)
 *   32 bytes: update_authority
 *   32 bytes: mint
 *   4 bytes:  name_len (u32 LE)
 *   N bytes:  name (null-padded)
 *   4 bytes:  symbol_len (u32 LE)
 *   N bytes:  symbol (null-padded)
 */
export function parseMetaplexMetadata(data: Buffer): { name: string; symbol: string } | null {
    const MIN_HEADER = 1 + 32 + 32 + 4; // key + authority + mint + name_len
    if (data.length < MIN_HEADER) return null;

    try {
        let offset = 1 + 32 + 32;

        const nameLen = data.readUInt32LE(offset);
        offset += 4;
        if (offset + nameLen > data.length) return null;
        const name = data
            .subarray(offset, offset + nameLen)
            .toString('utf8')
            .replace(/\0/g, '')
            .trim();
        offset += nameLen;

        if (offset + 4 > data.length) return null;
        const symbolLen = data.readUInt32LE(offset);
        offset += 4;
        if (offset + symbolLen > data.length) return null;
        const symbol = data
            .subarray(offset, offset + symbolLen)
            .toString('utf8')
            .replace(/\0/g, '')
            .trim();

        return { name, symbol };
    } catch {
        return null;
    }
}

// --- RPC types ---

interface JsonRpcError {
    code: number;
    message: string;
}

type RpcResult<T> =
    | { ok: true; result: T; httpStatus: number }
    | { ok: false; error: JsonRpcError; httpStatus: number };

interface TokenAmountResult {
    value: {
        amount: string;
        decimals: number;
        uiAmountString: string;
    };
}

interface AccountInfoResult {
    value: {
        data: [string, string]; // [base64_data, encoding]
        owner: string;
    } | null;
}

/** Classify a Solana JSON-RPC or HTTP error into a NullReason. */
export function classifySolanaRpcError(error: JsonRpcError | null, httpStatus: number): NullReason {
    if (error) {
        if (error.code === 24) return 'timeout'; // dRPC timeout
        if (error.code === -32602) return 'not_found'; // invalid/closed account
        return rpcCodeToNullReason(error.code);
    }
    return httpStatusToNullReason(httpStatus);
}

// --- Provider ---

/** Reads Solana SPL token data via dRPC JSON-RPC. */
export class SolanaRpcProvider implements Provider {
    name = 'solana-rpc';

    supportsNetwork(network: string): boolean {
        return network === 'solana' && config.drpcApiKey != null;
    }

    async fetchMetadata(network: string, contract: string): Promise<ProviderResult> {
        const start = Date.now();
        const metadataPDA = deriveMetadataPDA(contract);

        const [supplyResult, metaplexResult] = await Promise.allSettled([
            this.callWithRetry<TokenAmountResult>('getTokenSupply', [contract], `supply:${contract}`),
            this.callWithRetry<AccountInfoResult>(
                'getAccountInfo',
                [metadataPDA, { encoding: 'base64' }],
                `metaplex:${contract}`
            ),
        ]);

        const responseTimeMs = Date.now() - start;
        providerDuration.observe({ provider: 'solana-rpc', endpoint: 'metadata' }, responseTimeMs / 1000);

        const storedUrl = `${DRPC_SOLANA_URL}#mint=${contract}`;
        const entries: ComparableEntry[] = [];

        // Supply + decimals from getTokenSupply
        if (supplyResult.status === 'fulfilled' && supplyResult.value.ok) {
            const { decimals, uiAmountString } = supplyResult.value.result.value;
            entries.push({ field: 'decimals', entity: '', value: String(decimals), null_reason: null });
            entries.push({ field: 'total_supply', entity: '', value: uiAmountString, null_reason: null });
        } else {
            const reason = this.classifySettledResult(supplyResult);
            entries.push({ field: 'decimals', entity: '', value: null, null_reason: reason });
            entries.push({ field: 'total_supply', entity: '', value: null, null_reason: reason });
        }

        // Name + symbol from Metaplex
        const metaplex = this.extractMetaplex(metaplexResult);
        for (const field of ['name', 'symbol'] as const) {
            const value = metaplex?.[field] || null;
            entries.push({
                field,
                entity: '',
                value,
                null_reason: value ? null : metaplex === null ? this.classifySettledResult(metaplexResult) : 'empty',
            });
        }

        const allFailed = entries.every((e) => e.value === null);
        providerRequests.inc({
            provider: 'solana-rpc',
            network,
            endpoint: 'metadata',
            status: allFailed ? 'error' : 'success',
        });

        return {
            domain: 'metadata',
            entries,
            fetched_at: new Date(),
            response_time_ms: responseTimeMs,
            url: storedUrl,
            provider: 'solana-rpc',
        };
    }

    async fetchBalances(network: string, contract: string, holders?: string[]): Promise<ProviderResult> {
        if (!holders || holders.length === 0) {
            return {
                domain: 'balance',
                entries: [],
                fetched_at: new Date(),
                response_time_ms: 0,
                url: '',
                provider: 'solana-rpc',
            };
        }

        const start = Date.now();
        const entries: ComparableEntry[] = [];
        const failureCounts = new Map<NullReason, number>();

        for (let offset = 0; offset < holders.length; offset += config.rpcBatchSize) {
            const chunk = holders.slice(offset, offset + config.rpcBatchSize);
            const results = await this.rpcBatch<TokenAmountResult>(
                chunk.map((holder) => ({ method: 'getTokenAccountBalance', params: [holder] }))
            );

            for (let i = 0; i < chunk.length; i++) {
                const result = results[i];
                const holder = chunk[i] as string;

                if (result?.ok) {
                    entries.push({
                        field: 'balance',
                        entity: holder,
                        value: result.result.value.amount,
                        null_reason: null,
                    });
                } else {
                    const reason = result ? classifySolanaRpcError(result.error, result.httpStatus) : 'server_error';
                    failureCounts.set(reason, (failureCounts.get(reason) ?? 0) + 1);
                    entries.push({
                        field: 'balance',
                        entity: holder,
                        value: null,
                        null_reason: reason,
                    });
                }
            }
        }

        const responseTimeMs = Date.now() - start;
        providerDuration.observe({ provider: 'solana-rpc', endpoint: 'balance' }, responseTimeMs / 1000);

        if (failureCounts.size > 0) {
            const summary = [...failureCounts.entries()].map(([r, n]) => `${n} ${r}`).join(', ');
            logger.warn(`Solana RPC balance failures for ${contract}: ${summary}`);
        }

        const hasSuccesses = entries.some((e) => e.value !== null);
        providerRequests.inc({
            provider: 'solana-rpc',
            network,
            endpoint: 'balance',
            status: hasSuccesses ? 'success' : 'error',
        });

        return {
            domain: 'balance',
            entries,
            fetched_at: new Date(),
            response_time_ms: responseTimeMs,
            url: `${DRPC_SOLANA_URL}#mint=${contract}`,
            provider: 'solana-rpc',
        };
    }

    // --- Private helpers ---

    private async rpcCall<T>(method: string, params: unknown[]): Promise<RpcResult<T>> {
        const res = await fetch(DRPC_SOLANA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Drpc-Key': config.drpcApiKey ?? '' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });

        const body = (await res.json()) as { result?: T; error?: JsonRpcError };

        if (body.error) {
            return { ok: false, error: body.error, httpStatus: res.status };
        }

        return { ok: true, result: body.result as T, httpStatus: res.status };
    }

    private async rpcBatch<T>(calls: { method: string; params: unknown[] }[]): Promise<RpcResult<T>[]> {
        const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params }));

        const res = await fetch(DRPC_SOLANA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Drpc-Key': config.drpcApiKey ?? '' },
            body: JSON.stringify(body),
        });

        const results = (await res.json()) as { id: number; result?: T; error?: JsonRpcError }[];
        results.sort((a, b) => a.id - b.id);

        return results.map((r) =>
            r.error
                ? { ok: false as const, error: r.error, httpStatus: res.status }
                : { ok: true as const, result: r.result as T, httpStatus: res.status }
        );
    }

    private async callWithRetry<T>(method: string, params: unknown[], label: string): Promise<RpcResult<T>> {
        return withRetry(
            () => this.rpcCall<T>(method, params),
            {
                maxAttempts: config.retryMaxAttempts,
                baseDelay: config.retryBaseDelayMs,
                shouldRetry: (result: RpcResult<T>) =>
                    !result.ok && (result.httpStatus === 429 || result.httpStatus === 408 || result.httpStatus >= 500),
            },
            `solana-rpc:${label}`
        );
    }

    /** Extract name/symbol from a settled Metaplex RPC result. Returns null if the RPC call failed. */
    private extractMetaplex(
        result: PromiseSettledResult<RpcResult<AccountInfoResult>>
    ): { name: string; symbol: string } | undefined | null {
        if (result.status !== 'fulfilled' || !result.value.ok) return null;
        const accountData = result.value.result.value;
        if (!accountData) return undefined;
        const raw = Buffer.from(accountData.data[0], 'base64');
        return parseMetaplexMetadata(raw) ?? undefined;
    }

    private classifySettledResult(result: PromiseSettledResult<RpcResult<unknown>>): NullReason {
        if (result.status === 'rejected') return 'server_error';
        if (result.value.ok) return 'empty';
        return classifySolanaRpcError(result.value.error, result.value.httpStatus);
    }
}
