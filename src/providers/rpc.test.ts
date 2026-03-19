import { describe, expect, test } from 'bun:test';
import { bytes32ToString, parseViemStatus, stripRpcApiKey } from './rpc.js';

describe('bytes32ToString', () => {
    test('standard bytes32 (MKR)', () => {
        const hex = `0x4d4b5200000000000000000000000000${'0'.repeat(32)}`;
        expect(bytes32ToString(hex as `0x${string}`)).toBe('MKR');
    });

    test('single character', () => {
        const hex = `0x41${'0'.repeat(62)}`;
        expect(bytes32ToString(hex as `0x${string}`)).toBe('A');
    });

    test('full 32-byte string', () => {
        // "abcdefghijklmnopqrstuvwxyz123456" = 32 chars
        const hex = '0x6162636465666768696a6b6c6d6e6f707172737475767778797a313233343536';
        expect(bytes32ToString(hex as `0x${string}`)).toBe('abcdefghijklmnopqrstuvwxyz123456');
    });

    test('all-zero bytes32 returns empty string', () => {
        const hex = `0x${'0'.repeat(64)}`;
        expect(bytes32ToString(hex as `0x${string}`)).toBe('');
    });
});

describe('parseViemStatus', () => {
    test('extracts status from object with status property', () => {
        expect(parseViemStatus({ status: 429 })).toBe(429);
        expect(parseViemStatus({ status: 500 })).toBe(500);
        expect(parseViemStatus({ status: 403 })).toBe(403);
    });

    test('returns null for non-numeric status', () => {
        expect(parseViemStatus({ status: 'error' })).toBeNull();
    });

    test('returns null for missing status', () => {
        expect(parseViemStatus({})).toBeNull();
        expect(parseViemStatus(new Error('something'))).toBeNull();
    });

    test('returns null for non-objects', () => {
        expect(parseViemStatus(null)).toBeNull();
        expect(parseViemStatus(undefined)).toBeNull();
        expect(parseViemStatus('string')).toBeNull();
        expect(parseViemStatus(42)).toBeNull();
    });

    test('works with viem-like HttpRequestError shape', () => {
        const error = Object.assign(new Error('HTTP request failed.'), {
            status: 429,
            url: 'https://arbone.rpc.pinax.network/',
        });
        expect(parseViemStatus(error)).toBe(429);
    });
});

describe('stripRpcApiKey', () => {
    test('strips API key from Pinax RPC URL', () => {
        expect(
            stripRpcApiKey('https://arbone.rpc.pinax.network/v1/abcdef1234567890abcdef1234567890abcdef1234567890/')
        ).toBe('https://arbone.rpc.pinax.network/');
    });

    test('strips API key without trailing slash', () => {
        expect(
            stripRpcApiKey('https://arbone.rpc.pinax.network/v1/abcdef1234567890abcdef1234567890abcdef1234567890')
        ).toBe('https://arbone.rpc.pinax.network/');
    });

    test('strips API key embedded in multi-line error message', () => {
        const msg =
            'HTTP request failed.\n\nStatus: 429\nURL: https://arbone.rpc.pinax.network/v1/abcdef1234567890abcdef1234567890abcdef1234567890/\nDetails: Too Many Requests';
        expect(stripRpcApiKey(msg)).toBe(
            'HTTP request failed.\n\nStatus: 429\nURL: https://arbone.rpc.pinax.network/\nDetails: Too Many Requests'
        );
    });

    test('leaves non-Pinax URLs unchanged', () => {
        expect(stripRpcApiKey('https://mainnet.infura.io/v3/abc123')).toBe('https://mainnet.infura.io/v3/abc123');
    });

    test('leaves URLs without API key path unchanged', () => {
        expect(stripRpcApiKey('https://arbone.rpc.service.pinax.network/')).toBe(
            'https://arbone.rpc.service.pinax.network/'
        );
    });
});
