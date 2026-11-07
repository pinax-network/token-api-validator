import { describe, expect, test } from 'bun:test';
import { APIError } from '@pinax/token-api';
import { classifySdkError, isRetryableResult, sdkErrorStatus } from './token-api.js';

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

// The SDK raises a plain Error, not APIError, for error bodies without a `message`.
const plain401 = new Error('API Error: {"error":{"status":401,"code":"unauthorized"}}');
const plain500 = new Error(
    'API Error: "Internal server error{\\"error\\":{\\"status\\":500,\\"code\\":\\"internal_server_error\\"}}"'
);

describe('SDK errors without a message', () => {
    test('status read from the body', () => {
        expect(sdkErrorStatus(plain401)).toBe(401);
        expect(sdkErrorStatus(plain500)).toBe(500);
    });
    test('APIError status', () => expect(sdkErrorStatus(apiError(429, 'rate_limited', 'x'))).toBe(429));
    test('network error has no status', () => expect(sdkErrorStatus(new TypeError('fetch failed'))).toBeNull());
    test('401 → forbidden, not retried', () => {
        expect(classifySdkError(plain401)).toBe('forbidden');
        expect(isRetryableResult(plain401)).toBe(false);
    });
    test('500 → server_error, retried', () => {
        expect(classifySdkError(plain500)).toBe('server_error');
        expect(isRetryableResult(plain500)).toBe(true);
    });
});
