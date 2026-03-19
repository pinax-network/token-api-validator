import { describe, expect, test } from 'bun:test';

describe('SolscanProvider', () => {
    test('imports without error', async () => {
        const { SolscanProvider } = await import('./solscan.js');
        expect(SolscanProvider).toBeDefined();
    });

    test('supportsNetwork returns false without API key', async () => {
        const { SolscanProvider } = await import('./solscan.js');
        const provider = new SolscanProvider();
        // config.solscanApiKey is undefined in test-preload
        expect(provider.supportsNetwork('solana')).toBe(false);
        expect(provider.supportsNetwork('mainnet')).toBe(false);
    });
});
