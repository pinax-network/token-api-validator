import { describe, expect, test } from 'bun:test';
import { type ComparisonRecord, tallyCounts } from './clickhouse.js';

function record(overrides: Partial<ComparisonRecord> = {}): ComparisonRecord {
    return {
        run_id: 'test',
        run_at: '2026-01-01 00:00:00',
        domain: 'metadata',
        network: 'mainnet',
        contract: '0x0',
        symbol: 'TEST',
        field: 'symbol',
        entity: '',
        our_value: 'TEST',
        reference_value: 'TEST',
        provider: 'blockscout',
        relative_diff: null,
        is_match: true,
        tolerance: 0,
        our_fetched_at: '2026-01-01 00:00:00',
        reference_fetched_at: '2026-01-01 00:00:00',
        our_block_timestamp: null,
        our_url: '',
        reference_url: '',
        our_null_reason: null,
        reference_null_reason: null,
        ...overrides,
    };
}

describe('tallyCounts', () => {
    test('empty records', () => {
        expect(tallyCounts([])).toEqual({ comparisons: 0, matches: 0, mismatches: 0, nulls: 0 });
    });

    test('all matches', () => {
        const records = [record(), record(), record()];
        expect(tallyCounts(records)).toEqual({ comparisons: 3, matches: 3, mismatches: 0, nulls: 0 });
    });

    test('mismatch counted correctly', () => {
        const records = [record({ is_match: false })];
        expect(tallyCounts(records)).toEqual({ comparisons: 1, matches: 0, mismatches: 1, nulls: 0 });
    });

    test('error null reasons count as null, not mismatch', () => {
        const records = [
            record({ is_match: false, our_null_reason: 'rate_limited' }),
            record({ is_match: false, reference_null_reason: 'server_error' }),
            record({ is_match: false, our_null_reason: 'forbidden' }),
            record({ is_match: false, reference_null_reason: 'not_found' }),
            record({ is_match: false, our_null_reason: 'timeout' }),
            record({ is_match: false, reference_null_reason: 'paid_plan_required' }),
        ];
        expect(tallyCounts(records)).toEqual({ comparisons: 6, matches: 0, mismatches: 0, nulls: 6 });
    });

    test('empty null reason counts as mismatch (not null)', () => {
        const records = [record({ is_match: false, our_null_reason: 'empty' })];
        expect(tallyCounts(records)).toEqual({ comparisons: 1, matches: 0, mismatches: 1, nulls: 0 });
    });

    test('mixed scenario', () => {
        const records = [
            record({ is_match: true }),
            record({ is_match: true }),
            record({ is_match: false }),
            record({ is_match: false, our_null_reason: 'rate_limited' }),
        ];
        expect(tallyCounts(records)).toEqual({ comparisons: 4, matches: 2, mismatches: 1, nulls: 1 });
    });
});
