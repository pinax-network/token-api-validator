import { describe, expect, test } from 'bun:test';
import { isRetryableResult, parseErrorStatus } from './token-api.js';

describe('parseErrorStatus', () => {
    test('extracts status from SDK error message', () => {
        const error = new Error('API Error: {"status":429,"code":"rate_limited","message":"Too many requests"}');
        expect(parseErrorStatus(error)).toBe(429);
    });

    test('extracts 404 status', () => {
        const error = new Error('API Error: {"status":404,"code":"not_found_data","message":"Resource not found"}');
        expect(parseErrorStatus(error)).toBe(404);
    });

    test('extracts 500 status', () => {
        const error = new Error(
            'API Error: {"status":500,"code":"internal_server_error","message":"An unexpected error occurred"}'
        );
        expect(parseErrorStatus(error)).toBe(500);
    });

    test('returns null for "No data returned" error', () => {
        const error = new Error('API Error: No data returned');
        expect(parseErrorStatus(error)).toBeNull();
    });

    test('returns null for network errors', () => {
        const error = new TypeError('fetch failed');
        expect(parseErrorStatus(error)).toBeNull();
    });

    test('returns null for non-Error values', () => {
        expect(parseErrorStatus('string error')).toBeNull();
        expect(parseErrorStatus(null)).toBeNull();
    });
});

describe('isRetryableResult', () => {
    test('non-Error values are not retryable', () => {
        expect(isRetryableResult({ data: [] })).toBe(false);
        expect(isRetryableResult('success')).toBe(false);
    });

    test('429 is retryable', () => {
        const error = new Error('API Error: {"status":429,"code":"rate_limited","message":"Too many requests"}');
        expect(isRetryableResult(error)).toBe(true);
    });

    test('500 is retryable', () => {
        const error = new Error('API Error: {"status":500,"code":"internal_server_error","message":"fail"}');
        expect(isRetryableResult(error)).toBe(true);
    });

    test('502 is retryable', () => {
        const error = new Error('API Error: {"status":502,"code":"bad_database_response","message":"fail"}');
        expect(isRetryableResult(error)).toBe(true);
    });

    test('404 is not retryable', () => {
        const error = new Error('API Error: {"status":404,"code":"not_found_data","message":"Resource not found"}');
        expect(isRetryableResult(error)).toBe(false);
    });

    test('403 is not retryable', () => {
        const error = new Error('API Error: {"status":403,"code":"forbidden","message":"Access denied"}');
        expect(isRetryableResult(error)).toBe(false);
    });

    test('401 is not retryable', () => {
        const error = new Error('API Error: {"status":401,"code":"unauthorized","message":"Authentication required"}');
        expect(isRetryableResult(error)).toBe(false);
    });

    test('network errors are retryable', () => {
        const error = new TypeError('fetch failed');
        expect(isRetryableResult(error)).toBe(true);
    });
});
