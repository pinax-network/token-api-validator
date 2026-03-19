import { describe, expect, test } from 'bun:test';
import { EtherscanProvider, parseEtherscanError } from './etherscan.js';

describe('EtherscanProvider', () => {
    test('supportsNetwork returns false without API key', () => {
        const provider = new EtherscanProvider();
        // config.etherscanApiKey is undefined in test-preload
        expect(provider.supportsNetwork('mainnet')).toBe(false);
        expect(provider.supportsNetwork('solana')).toBe(false);
    });
});

describe('parseEtherscanError', () => {
    test('missing API key', () => expect(parseEtherscanError('Missing/Invalid API Key')).toBe('forbidden'));
    test('invalid API key', () => expect(parseEtherscanError('Invalid API Key')).toBe('forbidden'));
    test('not eligible', () =>
        expect(parseEtherscanError('API key not eligible for this endpoint')).toBe('paid_plan_required'));
    test('free tier chain restriction', () =>
        expect(
            parseEtherscanError(
                'Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage. https://etherscan.io/apis'
            )
        ).toBe('paid_plan_required'));
    test('global rate limit', () => expect(parseEtherscanError('Max rate limit reached')).toBe('rate_limited'));
    test('global rate limit with hint', () =>
        expect(parseEtherscanError('Max rate limit reached, please use API Key for higher rate limit')).toBe(
            'rate_limited'
        ));
    test('per-sec rate limit', () =>
        expect(parseEtherscanError('Max calls per sec rate limit reached (5/sec)')).toBe('rate_limited'));
    test('query timeout', () =>
        expect(parseEtherscanError('Query Timeout occured. Please select a smaller result dataset')).toBe('timeout'));
    test('unexpected timeout', () => expect(parseEtherscanError('Unexpected err, timeout occurred')).toBe('timeout'));
    test('invalid action', () => expect(parseEtherscanError('Missing Or invalid Action name')).toBe('server_error'));
    test('invalid module', () =>
        expect(parseEtherscanError('Error! Missing Or invalid Module name (#2)')).toBe('server_error'));
    test('no token found', () =>
        expect(parseEtherscanError('No token found for the provided contract address')).toBe('not_found'));
    test('token info not found', () => expect(parseEtherscanError('Token info not found')).toBe('not_found'));
    test('invalid address format', () =>
        expect(parseEtherscanError('Error! Invalid address format')).toBe('not_found'));
    test('invalid contract address format', () =>
        expect(parseEtherscanError('Error! Invalid contract address format')).toBe('not_found'));
    test('unknown error falls back to server_error', () =>
        expect(parseEtherscanError('something unexpected')).toBe('server_error'));
});
