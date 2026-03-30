import { describe, expect, test } from 'bun:test';
import { httpStatusToNullReason, rpcCodeToNullReason } from './types.js';

describe('httpStatusToNullReason', () => {
    test('404 → not_found', () => expect(httpStatusToNullReason(404)).toBe('not_found'));
    test('403 → forbidden', () => expect(httpStatusToNullReason(403)).toBe('forbidden'));
    test('429 → rate_limited', () => expect(httpStatusToNullReason(429)).toBe('rate_limited'));
    test('504 → timeout', () => expect(httpStatusToNullReason(504)).toBe('timeout'));
    test('500 → server_error', () => expect(httpStatusToNullReason(500)).toBe('server_error'));
    test('502 → server_error', () => expect(httpStatusToNullReason(502)).toBe('server_error'));
    test('503 → server_error', () => expect(httpStatusToNullReason(503)).toBe('server_error'));
});

describe('rpcCodeToNullReason', () => {
    test('-32001 (resource not found) → not_found', () => expect(rpcCodeToNullReason(-32001)).toBe('not_found'));
    test('-32005 (limit exceeded) → rate_limited', () => expect(rpcCodeToNullReason(-32005)).toBe('rate_limited'));
    test('-32603 (internal error) → server_error', () => expect(rpcCodeToNullReason(-32603)).toBe('server_error'));
    test('-32000 (invalid input) → server_error', () => expect(rpcCodeToNullReason(-32000)).toBe('server_error'));
    test('-32700 (parse error) → server_error', () => expect(rpcCodeToNullReason(-32700)).toBe('server_error'));
    test('-32002 (resource unavailable) → timeout', () => expect(rpcCodeToNullReason(-32002)).toBe('timeout'));
    test('3 (execution reverted) → server_error', () => expect(rpcCodeToNullReason(3)).toBe('server_error'));
});
