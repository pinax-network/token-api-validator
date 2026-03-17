import { describe, expect, test } from 'bun:test';
import { normalizeString, scaleDown, scaleUp } from './normalize.js';

describe('normalizeString', () => {
    test('lowercases and trims', () => {
        expect(normalizeString('  Hello World  ')).toBe('hello world');
    });

    test('collapses internal whitespace', () => {
        expect(normalizeString('foo   bar\tbaz')).toBe('foo bar baz');
    });

    test('empty string', () => {
        expect(normalizeString('')).toBe('');
    });
});

describe('scaleDown', () => {
    test('basic 18-decimal token', () => {
        expect(scaleDown('1000000000000000000', 18)).toBe('1');
    });

    test('6-decimal token (USDC-like)', () => {
        expect(scaleDown('1000000', 6)).toBe('1');
    });

    test('fractional result', () => {
        expect(scaleDown('1500000', 6)).toBe('1.5');
    });

    test('strips trailing zeros from fraction', () => {
        expect(scaleDown('1100000', 6)).toBe('1.1');
    });

    test('zero decimals returns raw', () => {
        expect(scaleDown('12345', 0)).toBe('12345');
    });

    test('value smaller than 1 unit', () => {
        expect(scaleDown('500000', 6)).toBe('0.5');
    });

    test('very small value', () => {
        expect(scaleDown('1', 18)).toBe('0.000000000000000001');
    });

    test('large supply', () => {
        expect(scaleDown('100000000000000000000000000', 18)).toBe('100000000');
    });

    test('zero', () => {
        expect(scaleDown('0', 6)).toBe('0');
    });
});

describe('scaleUp', () => {
    test('integer without dot is unchanged', () => {
        expect(scaleUp('1', 18)).toBe('1');
    });

    test('decimal value', () => {
        expect(scaleUp('1.5', 6)).toBe('1500000');
    });

    test('large integer without dot is unchanged', () => {
        expect(scaleUp('1000000', 6)).toBe('1000000');
    });

    test('zero decimals strips dot', () => {
        expect(scaleUp('1.5', 0)).toBe('15');
    });

    test('pads short fraction', () => {
        expect(scaleUp('1.1', 6)).toBe('1100000');
    });

    test('truncates excess fraction digits', () => {
        expect(scaleUp('1.1234567890', 6)).toBe('1123456');
    });

    test('leading zeros stripped', () => {
        expect(scaleUp('0.5', 6)).toBe('500000');
    });

    test('zero', () => {
        expect(scaleUp('0.0', 6)).toBe('0');
    });
});
