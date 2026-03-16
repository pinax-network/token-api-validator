import { logger } from './logger.js';
import { normalizeString } from './utils/normalize.js';

/** Defines how a field is compared: exact match or within a relative threshold. */
export interface FieldTolerance {
    type: 'exact' | 'relative';
    normalize?: boolean;
    /** Maximum allowed relative difference (e.g. 0.01 = 1%). Only used for 'relative' type. */
    threshold?: number;
}

/** Outcome of comparing a single field between our data and a reference source. */
export interface ComparisonResult {
    field: string;
    our_value: string | null;
    reference_value: string | null;
    is_match: boolean;
    relative_diff: number | null;
    tolerance: number;
}

/** Compare a single field value between our data and a reference. */
export function compareField(
    field: string,
    ourValue: unknown,
    refValue: unknown,
    tolerance: FieldTolerance
): ComparisonResult {
    const ourStr = ourValue != null ? String(ourValue) : null;
    const refStr = refValue != null ? String(refValue) : null;

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
