/** Core token fields that are compared between our API and reference sources. */
export interface TokenMetadata {
    symbol: string | null;
    decimals: number | null;
    total_supply: string | null;
}

export function emptyMetadata(): TokenMetadata {
    return { symbol: null, decimals: null, total_supply: null };
}

/** Result of fetching token metadata from a provider, with timing info. */
export interface ProviderResult {
    data: TokenMetadata;
    fetched_at: Date;
    response_time_ms: number;
    url: string;
    provider: string;
    null_reason: string | null;
}

/** Map an HTTP status code to a null_reason value. */
export function httpStatusToNullReason(status: number): string {
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
