/** A single validation run's summary, stored in the `runs` table. */
export interface RunRecord {
    run_id: string;
    started_at: string;
    completed_at: string | null;
    trigger: 'scheduled' | 'manual';
    tokens_checked: number;
    comparisons: number;
    matches: number;
    mismatches: number;
    nulls: number;
    errors: number;
    status: 'success' | 'partial' | 'failed';
    error_detail: string | null;
}

/** A single comparison result, stored in the unified `comparisons` table. */
export interface ComparisonRecord {
    run_id: string;
    run_at: string;
    domain: string;
    network: string;
    contract: string;
    symbol: string;
    field: string;
    entity: string;
    our_value: string | null;
    reference_value: string | null;
    provider: string;
    relative_diff: number | null;
    is_match: boolean;
    tolerance: number;
    our_fetched_at: string;
    reference_fetched_at: string;
    our_block_timestamp: string | null;
    our_url: string;
    reference_url: string;
    our_null_reason: string | null;
    reference_null_reason: string | null;
}

/** Tally match/mismatch/null counts from comparison records. */
export function tallyCounts(records: ComparisonRecord[]): {
    comparisons: number;
    matches: number;
    mismatches: number;
    nulls: number;
} {
    let matches = 0;
    let mismatches = 0;
    let nulls = 0;
    for (const c of records) {
        if (isErrorNull(c.our_null_reason) || isErrorNull(c.reference_null_reason)) {
            nulls++;
        } else if (c.is_match) {
            matches++;
        } else {
            mismatches++;
        }
    }
    return { comparisons: records.length, matches, mismatches, nulls };
}

function isErrorNull(reason: string | null): boolean {
    return reason != null && reason !== 'empty';
}
