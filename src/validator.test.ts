import { describe, expect, test } from 'bun:test';
import type { ProviderResult, TokenReference } from './providers/types.js';
import { detectOverriddenFields, shouldSkipComparison } from './validator.js';

const token: TokenReference = {
    network: 'mainnet',
    contract: '0x514910771af9ca656af840dff83e8264ecf986ca',
    coingecko_id: 'chainlink',
    symbol: 'LINK',
    name: 'Chainlink',
};

function makeResult(provider: string, entries: { field: string; value: string | null }[]): ProviderResult {
    return {
        domain: 'metadata',
        provider,
        entries: entries.map((e) => ({ ...e, entity: '', null_reason: null })),
        fetched_at: new Date(),
        response_time_ms: 100,
        url: 'https://example.com',
    };
}

function fulfilled(result: ProviderResult): PromiseFulfilledResult<ProviderResult> {
    return { status: 'fulfilled', value: result };
}

describe('detectOverriddenFields', () => {
    test('detects overridden name when curated differs from on-chain', () => {
        const refs = [fulfilled(makeResult('rpc', [{ field: 'name', value: 'ChainLink Token' }]))];
        const result = detectOverriddenFields(token, refs);
        expect(result).toEqual(new Set(['name']));
    });

    test('detects non-override when curated matches on-chain', () => {
        const refs = [fulfilled(makeResult('rpc', [{ field: 'name', value: 'Chainlink' }]))];
        const result = detectOverriddenFields(token, refs);
        expect(result).toEqual(new Set());
    });

    test('case-insensitive comparison', () => {
        const refs = [fulfilled(makeResult('rpc', [{ field: 'name', value: 'chainlink' }]))];
        const result = detectOverriddenFields(token, refs);
        expect(result).toEqual(new Set());
    });

    test('detects both name and symbol overrides independently', () => {
        const refs = [
            fulfilled(
                makeResult('rpc', [
                    { field: 'name', value: 'ChainLink Token' },
                    { field: 'symbol', value: 'LINK' },
                ])
            ),
        ];
        const result = detectOverriddenFields(token, refs);
        expect(result).toEqual(new Set(['name']));
    });

    test('returns null when no RPC provider in refs', () => {
        const refs = [fulfilled(makeResult('etherscan', [{ field: 'name', value: 'ChainLink Token' }]))];
        const result = detectOverriddenFields(token, refs);
        expect(result).toBeNull();
    });

    test('returns null when all refs rejected', () => {
        const refs: PromiseSettledResult<ProviderResult>[] = [{ status: 'rejected', reason: new Error('fail') }];
        const result = detectOverriddenFields(token, refs);
        expect(result).toBeNull();
    });

    test('uses solana-rpc as RPC provider', () => {
        const solToken: TokenReference = { ...token, network: 'solana', name: 'Chainlink' };
        const refs = [fulfilled(makeResult('solana-rpc', [{ field: 'name', value: 'Chainlink Token' }]))];
        const result = detectOverriddenFields(solToken, refs);
        expect(result).toEqual(new Set(['name']));
    });

    test('skips RPC entries with null values', () => {
        const refs = [fulfilled(makeResult('rpc', [{ field: 'name', value: null }]))];
        const result = detectOverriddenFields(token, refs);
        expect(result).toEqual(new Set());
    });
});

describe('shouldSkipComparison', () => {
    test('skips RPC comparison for overridden name', () => {
        expect(shouldSkipComparison('name', 'rpc', new Set(['name']))).toBe(true);
    });

    test('keeps RPC comparison for non-overridden name', () => {
        expect(shouldSkipComparison('name', 'rpc', new Set())).toBe(false);
    });

    test('keeps non-RPC comparison for overridden name', () => {
        expect(shouldSkipComparison('name', 'etherscan', new Set(['name']))).toBe(false);
    });

    test('skips non-RPC comparison for non-overridden name', () => {
        expect(shouldSkipComparison('name', 'etherscan', new Set())).toBe(true);
    });

    test('applies same logic to symbol field', () => {
        expect(shouldSkipComparison('symbol', 'rpc', new Set(['symbol']))).toBe(true);
        expect(shouldSkipComparison('symbol', 'blockscout', new Set(['symbol']))).toBe(false);
    });

    test('never skips non-name/symbol fields', () => {
        expect(shouldSkipComparison('decimals', 'rpc', new Set(['name']))).toBe(false);
        expect(shouldSkipComparison('total_supply', 'etherscan', new Set())).toBe(false);
        expect(shouldSkipComparison('balance', 'rpc', new Set(['name']))).toBe(false);
    });

    test('keeps all comparisons when overriddenFields is null', () => {
        expect(shouldSkipComparison('name', 'rpc', null)).toBe(false);
        expect(shouldSkipComparison('name', 'etherscan', null)).toBe(false);
    });

    test('handles solana-rpc as RPC provider', () => {
        expect(shouldSkipComparison('name', 'solana-rpc', new Set(['name']))).toBe(true);
        expect(shouldSkipComparison('name', 'solana-rpc', new Set())).toBe(false);
    });

    test('handles solscan as non-RPC provider', () => {
        expect(shouldSkipComparison('name', 'solscan', new Set(['name']))).toBe(false);
        expect(shouldSkipComparison('name', 'solscan', new Set())).toBe(true);
    });
});
