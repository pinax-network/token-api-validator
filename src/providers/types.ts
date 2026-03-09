/** Core token fields that are compared between our API and reference sources. */
export interface TokenMetadata {
    symbol: string | null;
    decimals: number | null;
    total_supply: string | null;
}

export function emptyMetadata(): TokenMetadata {
    return { symbol: null, decimals: null, total_supply: null };
}

/** Why a value is null — either the provider request failed or the field isn't supported. */
export type NullReason =
    | 'empty' // Provider responded successfully but returned no data (e.g. missing token in Blockscout)
    | 'not_found' // HTTP 404
    | 'forbidden' // HTTP 403 or invalid API key
    | 'rate_limited' // HTTP 429 or explicit rate limit error
    | 'timeout' // HTTP 504 or query timeout
    | 'server_error' // Other HTTP/provider error
    | 'paid_plan_required'; // Endpoint requires a paid API plan

/** Per-field null reasons — why each field's value is missing (if it is). */
export type FieldNullReasons = Partial<Record<keyof TokenMetadata, NullReason>>;

/** Result of fetching token metadata from a provider, with timing info. */
export interface ProviderResult {
    data: TokenMetadata;
    fetched_at: Date;
    response_time_ms: number;
    url: string;
    provider: string;
    null_reasons: FieldNullReasons;
}

/** Convenience: set the same null reason on all fields (whole-request failure). */
export function allFieldsNull(reason: NullReason): FieldNullReasons {
    return { decimals: reason, symbol: reason, total_supply: reason };
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
