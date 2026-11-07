import { describe, expect, test } from 'bun:test';
import { selectRpcUrl } from './registry.js';

const KEY = 'Ab-9_xYz';

describe('selectRpcUrl', () => {
    test('prefers the Pinax RPC listed after a public one, with the key', () => {
        const urls = ['https://mainnet.gateway.tenderly.co', 'https://eth.rpc.pinax.network', 'https://eth.drpc.org'];
        expect(selectRpcUrl('mainnet', urls, KEY)).toBe(`https://eth.rpc.pinax.network/v1/${KEY}/`);
    });

    test('maps a service host to the public host', () => {
        expect(selectRpcUrl('bsc', ['https://bsc.rpc.service.pinax.network/'], KEY)).toBe(
            `https://bsc.rpc.pinax.network/v1/${KEY}/`
        );
    });

    test('adds the Avalanche C-Chain path', () => {
        const urls = ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche.rpc.pinax.network'];
        expect(selectRpcUrl('avalanche', urls, KEY)).toBe(`https://avalanche.rpc.pinax.network/v1/${KEY}/ext/bc/C/rpc`);
    });

    test('without a key, the Pinax RPC is still preferred', () => {
        const urls = ['https://mainnet.optimism.io', 'https://optimism.rpc.pinax.network'];
        expect(selectRpcUrl('optimism', urls, undefined)).toBe('https://optimism.rpc.pinax.network');
    });

    test('without a Pinax RPC, the first URL', () => {
        expect(selectRpcUrl('base', ['https://mainnet.base.org', 'https://1rpc.io/base'], KEY)).toBe(
            'https://mainnet.base.org'
        );
    });

    test('a look-alike host is not taken for Pinax', () => {
        expect(selectRpcUrl('base', ['https://evil.example/eth.rpc.pinax.network', 'https://x.org'], KEY)).toBe(
            'https://evil.example/eth.rpc.pinax.network'
        );
    });

    test('no URLs', () => expect(selectRpcUrl('unichain', [], KEY)).toBeNull());
});
