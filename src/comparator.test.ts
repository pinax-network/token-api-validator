import { describe, expect, mock, test } from 'bun:test';

mock.module('./config.js', () => ({
    config: { verbose: false, prettyLogging: false },
}));
mock.module('./logger.js', () => ({
    logger: { warn: () => {}, error: () => {}, info: () => {} },
}));

import { compareField, type FieldTolerance } from './comparator.js';

const exact: FieldTolerance = { type: 'exact' };
const exactNorm: FieldTolerance = { type: 'exact', normalize: true };
const relative: FieldTolerance = { type: 'relative', threshold: 0.01 };

describe('compareField — exact', () => {
    test('identical strings match', () => {
        const r = compareField('symbol', 'USDC', 'USDC', exact);
        expect(r.is_match).toBe(true);
        expect(r.tolerance).toBe(0);
        expect(r.relative_diff).toBeNull();
    });

    test('different strings mismatch', () => {
        const r = compareField('symbol', 'USDC', 'USDT', exact);
        expect(r.is_match).toBe(false);
    });

    test('case-sensitive without normalize', () => {
        const r = compareField('symbol', 'usdc', 'USDC', exact);
        expect(r.is_match).toBe(false);
    });

    test('case-insensitive with normalize', () => {
        const r = compareField('name', 'ChainLink Token', 'chainlink token', exactNorm);
        expect(r.is_match).toBe(true);
    });

    test('whitespace normalization', () => {
        const r = compareField('name', 'Foo  Bar', 'foo bar', exactNorm);
        expect(r.is_match).toBe(true);
    });

    test('null our value is mismatch', () => {
        const r = compareField('symbol', null, 'USDC', exact);
        expect(r.is_match).toBe(false);
        expect(r.our_value).toBeNull();
    });

    test('null ref value is mismatch', () => {
        const r = compareField('symbol', 'USDC', null, exact);
        expect(r.is_match).toBe(false);
        expect(r.reference_value).toBeNull();
    });

    test('both null is mismatch', () => {
        const r = compareField('symbol', null, null, exact);
        expect(r.is_match).toBe(false);
    });
});

describe('compareField — relative', () => {
    test('identical values match', () => {
        const r = compareField('balance', '1000', '1000', relative);
        expect(r.is_match).toBe(true);
        expect(r.relative_diff).toBe(0);
    });

    test('within 1% tolerance matches', () => {
        const r = compareField('balance', '1005', '1000', relative);
        expect(r.is_match).toBe(true);
        expect(r.relative_diff).toBeCloseTo(0.005, 5);
    });

    test('exactly at threshold matches', () => {
        const r = compareField('balance', '1010', '1000', relative);
        expect(r.is_match).toBe(true);
        expect(r.relative_diff).toBeCloseTo(0.01, 5);
    });

    test('beyond threshold mismatches', () => {
        const r = compareField('balance', '1020', '1000', relative);
        expect(r.is_match).toBe(false);
        expect(r.relative_diff).toBeCloseTo(0.02, 5);
    });

    test('tolerance value is stored', () => {
        const r = compareField('balance', '1000', '1000', relative);
        expect(r.tolerance).toBe(0.01);
    });

    test('zero reference, non-zero ours is mismatch', () => {
        const r = compareField('balance', '100', '0', relative);
        expect(r.is_match).toBe(false);
        expect(r.relative_diff).toBeNull();
    });

    test('both zero match', () => {
        const r = compareField('balance', '0', '0', relative);
        expect(r.is_match).toBe(true);
        expect(r.relative_diff).toBe(0);
    });

    test('non-numeric strings mismatch', () => {
        const r = compareField('balance', 'abc', '1000', relative);
        expect(r.is_match).toBe(false);
        expect(r.relative_diff).toBeNull();
    });

    test('null values mismatch with tolerance stored', () => {
        const r = compareField('balance', null, '1000', relative);
        expect(r.is_match).toBe(false);
        expect(r.tolerance).toBe(0.01);
    });

    test('large numbers with small relative diff', () => {
        const r = compareField('total_supply', '1000000000000000000', '999900000000000000', relative);
        expect(r.is_match).toBe(true);
    });
});
