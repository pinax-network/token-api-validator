/** Why a field value is null. */
export type NullReason =
    | 'empty' // Provider responded successfully but returned no data — still compared for accuracy
    | 'not_found' // HTTP 404
    | 'forbidden' // HTTP 403 or invalid API key
    | 'rate_limited' // HTTP 429 or explicit rate limit error
    | 'timeout' // HTTP 504 or query timeout
    | 'server_error' // Other HTTP/provider error
    | 'paid_plan_required'; // Endpoint requires a paid API plan

/** A single comparable entry returned by a provider. */
export interface ComparableEntry {
    field: string;
    entity: string;
    value: string | null;
    null_reason: NullReason | null;
    block_number?: number | null;
}

/** Uniform result from any provider fetch (metadata or balances). */
export interface ProviderResult {
    domain: string;
    entries: ComparableEntry[];
    fetched_at: Date;
    response_time_ms: number;
    url: string;
    provider: string;
    block_number?: number | null;
    block_timestamp?: Date | null;
}

/** Contract that all providers (Token API, Blockscout, Etherscan, RPC) implement. */
export interface Provider {
    name: string;
    supportsNetwork(network: string): boolean;
    fetchMetadata(network: string, contract: string, blockNumber?: number | null): Promise<ProviderResult>;
    fetchBalances(
        network: string,
        contract: string,
        holders?: string[],
        holderBlocks?: Map<string, number>
    ): Promise<ProviderResult>;
}

/** Map an HTTP status code to a NullReason. Used by all providers that make HTTP requests. */
export function httpStatusToNullReason(status: number): NullReason {
    if (status === 404) return 'not_found';
    if (status === 403) return 'forbidden';
    if (status === 429) return 'rate_limited';
    if (status === 504) return 'timeout';
    return 'server_error';
}

/**
 * Map a JSON-RPC error code to a NullReason.
 *
 * Codes per EIP-1474 (standard: -32700 to -32603, non-standard: -32000 to -32006).
 * Code 3 is the execution reverted code used by eth_call.
 */
export function rpcCodeToNullReason(code: number): NullReason {
    if (code === -32001) return 'not_found'; // Resource not found (e.g., block/state unavailable)
    if (code === -32005) return 'rate_limited'; // Limit exceeded
    return 'server_error';
}

/** A token to validate, as defined in tokens.json. */
export interface TokenReference {
    network: string;
    contract: string;
    coingecko_id: string;
    symbol: string;
    name: string;
}
