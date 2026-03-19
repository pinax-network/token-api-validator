import { describe, expect, test } from 'bun:test';
import { BaseError, HttpRequestError, RpcRequestError } from 'viem';
import { bytes32ToString, classifyViemError, stripRpcApiKey } from './rpc.js';

const RPC_URL = 'https://rpc.example.com';
const DUMMY_KEY = 'abcdef1234567890abcdef1234567890abcdef1234567890';

function httpError(status: number) {
    return new HttpRequestError({ url: RPC_URL, status });
}

function rpcError(code: number, message: string) {
    return new RpcRequestError({ body: { method: 'eth_call' }, error: { code, message }, url: RPC_URL });
}

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
        const hex = '0x6162636465666768696a6b6c6d6e6f707172737475767778797a313233343536';
        expect(bytes32ToString(hex as `0x${string}`)).toBe('abcdefghijklmnopqrstuvwxyz123456');
    });

    test('all-zero bytes32 returns empty string', () => {
        const hex = `0x${'0'.repeat(64)}`;
        expect(bytes32ToString(hex as `0x${string}`)).toBe('');
    });
});

describe('classifyViemError', () => {
    describe('direct HttpRequestError', () => {
        test('429 → rate_limited', () => expect(classifyViemError(httpError(429))).toBe('rate_limited'));
        test('403 → forbidden', () => expect(classifyViemError(httpError(403))).toBe('forbidden'));
        test('404 → not_found', () => expect(classifyViemError(httpError(404))).toBe('not_found'));
        test('504 → timeout', () => expect(classifyViemError(httpError(504))).toBe('timeout'));
        test('500 → server_error', () => expect(classifyViemError(httpError(500))).toBe('server_error'));
    });

    describe('direct RpcRequestError', () => {
        test('-32005 (limit exceeded) → rate_limited', () => {
            expect(classifyViemError(rpcError(-32005, 'limit exceeded'))).toBe('rate_limited');
        });
        test('-32603 (internal error) → server_error', () => {
            expect(classifyViemError(rpcError(-32603, 'internal error'))).toBe('server_error');
        });
        test('-32000 (execution error) → server_error', () => {
            expect(classifyViemError(rpcError(-32000, 'execution reverted'))).toBe('server_error');
        });
    });

    describe('wrapped in BaseError cause chain', () => {
        test('HttpRequestError one level deep', () => {
            const wrapper = new BaseError('Contract call failed', { cause: httpError(429) });
            expect(classifyViemError(wrapper)).toBe('rate_limited');
        });

        test('HttpRequestError two levels deep', () => {
            const mid = new BaseError('Call failed', { cause: httpError(429) });
            const outer = new BaseError('Contract function failed', { cause: mid });
            expect(classifyViemError(outer)).toBe('rate_limited');
        });

        test('RpcRequestError one level deep', () => {
            const wrapper = new BaseError('Contract call failed', { cause: rpcError(-32603, 'internal error') });
            expect(classifyViemError(wrapper)).toBe('server_error');
        });
    });

    describe('non-viem fallbacks', () => {
        test('plain Error → server_error', () => expect(classifyViemError(new Error('broke'))).toBe('server_error'));
        test('null → server_error', () => expect(classifyViemError(null)).toBe('server_error'));
        test('undefined → server_error', () => expect(classifyViemError(undefined)).toBe('server_error'));
        test('string → server_error', () => expect(classifyViemError('timeout')).toBe('server_error'));
    });
});

describe('stripRpcApiKey', () => {
    test('strips key from Pinax RPC URL', () => {
        expect(stripRpcApiKey(`https://arbone.rpc.pinax.network/v1/${DUMMY_KEY}/`)).toBe(
            'https://arbone.rpc.pinax.network/'
        );
    });

    test('strips key without trailing slash', () => {
        expect(stripRpcApiKey(`https://arbone.rpc.pinax.network/v1/${DUMMY_KEY}`)).toBe(
            'https://arbone.rpc.pinax.network/'
        );
    });

    test('strips key embedded in multi-line error message', () => {
        const msg = `HTTP request failed.\n\nStatus: 429\nURL: https://arbone.rpc.pinax.network/v1/${DUMMY_KEY}/\nDetails: Too Many Requests`;
        expect(stripRpcApiKey(msg)).toBe(
            'HTTP request failed.\n\nStatus: 429\nURL: https://arbone.rpc.pinax.network/\nDetails: Too Many Requests'
        );
    });

    test('leaves non-Pinax URLs unchanged', () => {
        expect(stripRpcApiKey('https://mainnet.infura.io/v3/abc123')).toBe('https://mainnet.infura.io/v3/abc123');
    });

    test('leaves URLs without key path unchanged', () => {
        expect(stripRpcApiKey('https://arbone.rpc.service.pinax.network/')).toBe(
            'https://arbone.rpc.service.pinax.network/'
        );
    });
});
