import { describe, expect, test } from 'bun:test';
import { bytes32ToString } from './rpc.js';

describe('bytes32ToString', () => {
    test('standard bytes32 (MKR)', () => {
        const hex = `0x4d4b5200000000000000000000000000${'0'.repeat(32)}`;
        expect(bytes32ToString(hex as `0x${string}`)).toBe('MKR');
    });

    test('single character', () => {
        const hex = `0x41${'0'.repeat(62)}`;
        expect(bytes32ToString(hex as `0x${string}`)).toBe('A');
    });

    test('full 32-byte string', () => {
        // "abcdefghijklmnopqrstuvwxyz123456" = 32 chars
        const hex = '0x6162636465666768696a6b6c6d6e6f707172737475767778797a313233343536';
        expect(bytes32ToString(hex as `0x${string}`)).toBe('abcdefghijklmnopqrstuvwxyz123456');
    });

    test('all-zero bytes32 returns empty string', () => {
        const hex = `0x${'0'.repeat(64)}`;
        expect(bytes32ToString(hex as `0x${string}`)).toBe('');
    });
});
