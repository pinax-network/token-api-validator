import { mock } from 'bun:test';

mock.module('./config.js', () => ({
    config: {
        port: 3000,
        clickhouseUrl: 'http://localhost:8123',
        clickhouseUsername: 'default',
        clickhousePassword: '',
        clickhouseDatabase: 'validation',
        tokenApiBaseUrl: 'https://token-api.thegraph.com',
        tokenApiJwt: 'test-jwt',
        etherscanApiKey: undefined,
        cronSchedule: '0 */6 * * *',
        rateLimitMs: 500,
        retryMaxAttempts: 3,
        retryBaseDelayMs: 1000,
        verbose: false,
        prettyLogging: false,
    },
}));
