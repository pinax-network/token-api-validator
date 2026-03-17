import { describe, expect, test } from 'bun:test';
import { httpStatusToNullReason } from './types.js';

describe('httpStatusToNullReason', () => {
    test('404 → not_found', () => expect(httpStatusToNullReason(404)).toBe('not_found'));
    test('403 → forbidden', () => expect(httpStatusToNullReason(403)).toBe('forbidden'));
    test('429 → rate_limited', () => expect(httpStatusToNullReason(429)).toBe('rate_limited'));
    test('504 → timeout', () => expect(httpStatusToNullReason(504)).toBe('timeout'));
    test('500 → server_error', () => expect(httpStatusToNullReason(500)).toBe('server_error'));
    test('502 → server_error', () => expect(httpStatusToNullReason(502)).toBe('server_error'));
    test('503 → server_error', () => expect(httpStatusToNullReason(503)).toBe('server_error'));
});
