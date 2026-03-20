import { describe, expect, test } from 'bun:test';
import { APIError } from '@pinax/token-api';
import { classifySdkError, isRetryableResult } from './token-api.js';

function apiError(status: number, code: string, message: string) {
    return new APIError({ status, code, message });
}

describe('classifySdkError', () => {
    test('429 → rate_limited', () =>
        expect(classifySdkError(apiError(429, 'rate_limited', 'Too many requests'))).toBe('rate_limited'));
    test('403 → forbidden', () =>
        expect(classifySdkError(apiError(403, 'forbidden', 'Access denied'))).toBe('forbidden'));
    test('404 → not_found', () =>
        expect(classifySdkError(apiError(404, 'not_found_data', 'Not found'))).toBe('not_found'));
    test('500 → server_error', () =>
        expect(classifySdkError(apiError(500, 'internal_server_error', 'Fail'))).toBe('server_error'));
    test('network error → server_error', () =>
        expect(classifySdkError(new TypeError('fetch failed'))).toBe('server_error'));
    test('non-Error → server_error', () => expect(classifySdkError('something')).toBe('server_error'));
});

describe('isRetryableResult', () => {
    test('non-Error values are not retryable', () => {
        expect(isRetryableResult({ data: [] })).toBe(false);
        expect(isRetryableResult('success')).toBe(false);
    });

    test('429 is retryable', () =>
        expect(isRetryableResult(apiError(429, 'rate_limited', 'Too many requests'))).toBe(true));
    test('500 is retryable', () =>
        expect(isRetryableResult(apiError(500, 'internal_server_error', 'Fail'))).toBe(true));
    test('502 is retryable', () =>
        expect(isRetryableResult(apiError(502, 'bad_database_response', 'Fail'))).toBe(true));
    test('404 is not retryable', () =>
        expect(isRetryableResult(apiError(404, 'not_found_data', 'Not found'))).toBe(false));
    test('403 is not retryable', () => expect(isRetryableResult(apiError(403, 'forbidden', 'Denied'))).toBe(false));
    test('401 is not retryable', () =>
        expect(isRetryableResult(apiError(401, 'unauthorized', 'Auth required'))).toBe(false));
    test('network errors are retryable', () => expect(isRetryableResult(new TypeError('fetch failed'))).toBe(true));
});
