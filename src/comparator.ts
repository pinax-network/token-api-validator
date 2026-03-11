import { logger } from './logger.js';
import type { TokenMetadata } from './providers/types.js';
import { normalizeString, scaleDown } from './utils/normalize.js';

/** Defines how a token metadata field is compared: exact match or within a relative threshold. */
export interface FieldTolerance {
    type: 'exact' | 'relative';
    normalize?: boolean;
    /** Maximum allowed relative difference (e.g. 0.01 = 1%). Only used for 'relative' type. */
    threshold?: number;
}

export const TOLERANCES: Record<keyof TokenMetadata, FieldTolerance> = {
    decimals: { type: 'exact' },
    symbol: { type: 'exact', normalize: true },
    total_supply: { type: 'relative', threshold: 0.01 },
};

/** Outcome of comparing a single field between our data and a reference source. */
export interface ComparisonResult {
    field: string;
    our_value: string | null;
    reference_value: string | null;
    is_match: boolean;
    relative_diff: number | null;
    tolerance: number;
}

function compareField(
    field: keyof TokenMetadata,
    ourValue: unknown,
    refValue: unknown,
    tolerance: FieldTolerance
): ComparisonResult {
    const ourStr = ourValue != null ? String(ourValue) : null;
    const refStr = refValue != null ? String(refValue) : null;

    // If either value is null, skip comparison (tracked for coverage, not accuracy)
    if (ourStr == null || refStr == null) {
        return {
            field,
            our_value: ourStr,
            reference_value: refStr,
            is_match: false,
            relative_diff: null,
            tolerance: tolerance.threshold ?? 0,
        };
    }

    if (tolerance.type === 'exact') {
        const a = tolerance.normalize ? normalizeString(ourStr) : ourStr;
        const b = tolerance.normalize ? normalizeString(refStr) : refStr;

        return {
            field,
            our_value: ourStr,
            reference_value: refStr,
            is_match: a === b,
            relative_diff: null,
            tolerance: 0,
        };
    }

    const ourNum = Number(ourStr);
    const refNum = Number(refStr);

    if (!Number.isFinite(ourNum) || !Number.isFinite(refNum)) {
        logger.warn(`${field}: cannot parse as numbers — ours="${ourStr}" ref="${refStr}"`);
        return {
            field,
            our_value: ourStr,
            reference_value: refStr,
            is_match: false,
            relative_diff: null,
            tolerance: tolerance.threshold ?? 0,
        };
    }

    // Handle zero reference — exact comparison when ref is 0
    if (refNum === 0) {
        return {
            field,
            our_value: ourStr,
            reference_value: refStr,
            is_match: ourNum === 0,
            relative_diff: ourNum === 0 ? 0 : null,
            tolerance: tolerance.threshold ?? 0,
        };
    }

    const diff = Math.abs(ourNum - refNum) / Math.abs(refNum);

    return {
        field,
        our_value: ourStr,
        reference_value: refStr,
        is_match: diff <= (tolerance.threshold ?? 0),
        relative_diff: diff,
        tolerance: tolerance.threshold ?? 0,
    };
}

/** Compare all token metadata fields between our data and a reference, applying configured tolerances. */
export function compare(ours: TokenMetadata, reference: TokenMetadata): ComparisonResult[] {
    // Normalize reference total_supply from raw integer to human-readable using decimals from either side
    const decimals = reference.decimals ?? ours.decimals;
    const normalizedRef = { ...reference };
    if (normalizedRef.total_supply != null && decimals != null) {
        normalizedRef.total_supply = scaleDown(normalizedRef.total_supply, decimals);
    }

    const results: ComparisonResult[] = [];

    for (const [field, tolerance] of Object.entries(TOLERANCES)) {
        const key = field as keyof TokenMetadata;
        results.push(compareField(key, ours[key], normalizedRef[key], tolerance));
    }

    return results;
}

/** Check if a comparison should be excluded from accuracy due to a provider error. */
export function isNullComparison(result: {
    our_null_reason: string | null;
    reference_null_reason: string | null;
}): boolean {
    return isErrorNullReason(result.our_null_reason) || isErrorNullReason(result.reference_null_reason);
}

function isErrorNullReason(reason: string | null): boolean {
    return reason != null && reason !== 'empty';
}
