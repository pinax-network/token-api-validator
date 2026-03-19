import { describe, expect, test } from 'bun:test';
import { classifySdkError, isRetryableResult, parseErrorStatus } from './token-api.js';

function sdkError(status: number, code: string, message: string) {
    return new Error(`API Error: {"status":${status},"code":"${code}","message":"${message}"}`);
}

describe('parseErrorStatus', () => {
    test('extracts 429', () => expect(parseErrorStatus(sdkError(429, 'rate_limited', 'Too many requests'))).toBe(429));
    test('extracts 404', () => expect(parseErrorStatus(sdkError(404, 'not_found_data', 'Not found'))).toBe(404));
    test('extracts 500', () => expect(parseErrorStatus(sdkError(500, 'internal_server_error', 'Fail'))).toBe(500));
    test('returns null for non-JSON SDK error', () =>
        expect(parseErrorStatus(new Error('API Error: No data returned'))).toBeNull());
    test('returns null for network error', () => expect(parseErrorStatus(new TypeError('fetch failed'))).toBeNull());
    test('returns null for non-Error', () => {
        expect(parseErrorStatus('string')).toBeNull();
        expect(parseErrorStatus(null)).toBeNull();
    });
});

describe('classifySdkError', () => {
    test('429 → rate_limited', () =>
        expect(classifySdkError(sdkError(429, 'rate_limited', 'Too many requests'))).toBe('rate_limited'));
    test('403 → forbidden', () =>
        expect(classifySdkError(sdkError(403, 'forbidden', 'Access denied'))).toBe('forbidden'));
    test('404 → not_found', () =>
        expect(classifySdkError(sdkError(404, 'not_found_data', 'Not found'))).toBe('not_found'));
    test('500 → server_error', () =>
        expect(classifySdkError(sdkError(500, 'internal_server_error', 'Fail'))).toBe('server_error'));
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
        expect(isRetryableResult(sdkError(429, 'rate_limited', 'Too many requests'))).toBe(true));
    test('500 is retryable', () =>
        expect(isRetryableResult(sdkError(500, 'internal_server_error', 'Fail'))).toBe(true));
    test('502 is retryable', () =>
        expect(isRetryableResult(sdkError(502, 'bad_database_response', 'Fail'))).toBe(true));
    test('404 is not retryable', () =>
        expect(isRetryableResult(sdkError(404, 'not_found_data', 'Not found'))).toBe(false));
    test('403 is not retryable', () => expect(isRetryableResult(sdkError(403, 'forbidden', 'Denied'))).toBe(false));
    test('401 is not retryable', () =>
        expect(isRetryableResult(sdkError(401, 'unauthorized', 'Auth required'))).toBe(false));
    test('network errors are retryable', () => expect(isRetryableResult(new TypeError('fetch failed'))).toBe(true));
});
