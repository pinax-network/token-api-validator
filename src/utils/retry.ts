import { logger } from '../logger.js';

export interface RetryOptions<T = unknown> {
    maxAttempts: number;
    baseDelay: number;
    maxDelay?: number;
    /** If provided, retry when fn returns a result that satisfies this predicate.
     *  On exhaustion, returns the last result (unlike errors, which throw). */
    shouldRetry?: (result: T) => boolean;
}

/**
 * Execute `fn` with exponential backoff retries.
 * - Errors (fn throws): retried, then thrown on exhaustion.
 * - shouldRetry match (fn returns but predicate is true): retried, then returned on exhaustion.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions<T>, label = 'operation'): Promise<T> {
    const { maxAttempts, baseDelay, maxDelay = 30_000, shouldRetry } = opts;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const result = await fn();
            if (shouldRetry?.(result) && attempt < maxAttempts) {
                const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
                logger.warn(`${label}: attempt ${attempt}/${maxAttempts} should retry, retrying in ${delay}ms`);
                await new Promise((resolve) => setTimeout(resolve, delay));
                continue;
            }
            return result;
        } catch (error) {
            if (attempt === maxAttempts) {
                logger.error(`${label}: all ${maxAttempts} attempts failed`, error);
                throw error;
            }

            const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
            logger.warn(`${label}: attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms`);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }

    throw new Error(`${label}: unreachable`);
}
