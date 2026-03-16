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
}

/** Uniform result from any provider fetch (metadata or balances). */
export interface ProviderResult {
    domain: string;
    entries: ComparableEntry[];
    fetched_at: Date;
    response_time_ms: number;
    url: string;
    provider: string;
    block_timestamp: Date | null;
}

/** Map an HTTP status code to a null_reason value. */
export function httpStatusToNullReason(status: number): NullReason {
    if (status === 404) return 'not_found';
    if (status === 403) return 'forbidden';
    if (status === 429) return 'rate_limited';
    if (status === 504) return 'timeout';
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
