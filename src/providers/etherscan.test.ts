import { describe, expect, test } from 'bun:test';
import { parseEtherscanError } from './etherscan.js';

describe('parseEtherscanError', () => {
    test('missing API key', () => expect(parseEtherscanError('Missing/Invalid API Key')).toBe('paid_plan_required'));
    test('invalid API key', () => expect(parseEtherscanError('Invalid API Key')).toBe('forbidden'));
    test('not eligible', () =>
        expect(parseEtherscanError('API key not eligible for this endpoint')).toBe('paid_plan_required'));
    test('global rate limit', () => expect(parseEtherscanError('Max rate limit reached')).toBe('rate_limited'));
    test('per-sec rate limit', () =>
        expect(parseEtherscanError('Max calls per sec rate limit reached (5/sec)')).toBe('rate_limited'));
    test('invalid action', () => expect(parseEtherscanError('Missing Or invalid Action name')).toBe('server_error'));
    test('no token found', () =>
        expect(parseEtherscanError('No token found for the provided contract address')).toBe('not_found'));
    test('unknown error falls back to server_error', () =>
        expect(parseEtherscanError('something unexpected')).toBe('server_error'));
});
