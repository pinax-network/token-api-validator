import { describe, expect, test } from 'bun:test';
import bs58 from 'bs58';
import { classifySolanaRpcError, deriveMetadataPDA, parseMetaplexMetadata } from './solana-rpc.js';

// --- Provider gating ---

describe('SolanaRpcProvider', () => {
    test('supportsNetwork returns false without DRPC_API_KEY', async () => {
        const { SolanaRpcProvider } = await import('./solana-rpc.js');
        const provider = new SolanaRpcProvider();
        expect(provider.supportsNetwork('solana')).toBe(false);
    });

    test('supportsNetwork returns false for non-solana networks', async () => {
        const { SolanaRpcProvider } = await import('./solana-rpc.js');
        const provider = new SolanaRpcProvider();
        expect(provider.supportsNetwork('mainnet')).toBe(false);
        expect(provider.supportsNetwork('base')).toBe(false);
        expect(provider.supportsNetwork('polygon')).toBe(false);
    });
});

// --- Error classification ---

describe('classifySolanaRpcError', () => {
    describe('HTTP status mapping', () => {
        test('429 → rate_limited', () => expect(classifySolanaRpcError(null, 429)).toBe('rate_limited'));
        test('403 → forbidden', () => expect(classifySolanaRpcError(null, 403)).toBe('forbidden'));
        test('404 → not_found', () => expect(classifySolanaRpcError(null, 404)).toBe('not_found'));
        test('504 → timeout', () => expect(classifySolanaRpcError(null, 504)).toBe('timeout'));
        test('500 → server_error', () => expect(classifySolanaRpcError(null, 500)).toBe('server_error'));
    });

    describe('JSON-RPC error code mapping', () => {
        test('dRPC code 24 → timeout', () => {
            expect(classifySolanaRpcError({ code: 24, message: 'Request failed with timeout' }, 408)).toBe('timeout');
        });

        test('-32602 → not_found (invalid/closed account)', () => {
            expect(classifySolanaRpcError({ code: -32602, message: 'could not find account' }, 200)).toBe('not_found');
        });

        test('-32005 → rate_limited', () => {
            expect(classifySolanaRpcError({ code: -32005, message: 'limit exceeded' }, 200)).toBe('rate_limited');
        });

        test('-32001 → not_found', () => {
            expect(classifySolanaRpcError({ code: -32001, message: 'resource not found' }, 200)).toBe('not_found');
        });

        test('-32603 → server_error', () => {
            expect(classifySolanaRpcError({ code: -32603, message: 'internal error' }, 200)).toBe('server_error');
        });

        test('unknown code → server_error', () => {
            expect(classifySolanaRpcError({ code: -99999, message: 'unknown' }, 200)).toBe('server_error');
        });
    });

    describe('JSON-RPC error takes precedence over HTTP status', () => {
        test('code 24 with HTTP 408', () => {
            expect(classifySolanaRpcError({ code: 24, message: 'timeout' }, 408)).toBe('timeout');
        });

        test('code -32602 with HTTP 200', () => {
            expect(classifySolanaRpcError({ code: -32602, message: 'invalid param' }, 200)).toBe('not_found');
        });
    });
});

// --- PDA derivation ---

// Reference values generated with @solana/web3.js PublicKey.findProgramAddressSync
const PDA_TEST_VECTORS: [string, string, string][] = [
    ['USDC', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq'],
    ['Wrapped SOL', 'So11111111111111111111111111111111111111112', '6dM4TqWyWJsbx7obrdLcviBkTafD5E8av61zfU6jq57X'],
    ['USDT', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', '8c3zk1t1qt3RU43ckuvPkCS7HLbjJqq3J3Me8ov4aHrp'],
    ['BONK', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'FDZZbyY9XGpL3CNKUZxLk3wFTTQYL3TkDiDzqxrizcPN'],
    ['JUP', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', '5pddDLA4taryBwRYGdtKmS9qkwssXD8vHECeNbCZnwUy'],
    ['RAY', '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', 'GMrwFHibMxDtx4aPznekZ7RoJLZGzzLGRSWeNTf3XV2'],
];

describe('deriveMetadataPDA', () => {
    for (const [name, mint, expectedPDA] of PDA_TEST_VECTORS) {
        test(`${name}: ${mint.slice(0, 8)}… → ${expectedPDA.slice(0, 8)}…`, () => {
            expect(deriveMetadataPDA(mint)).toBe(expectedPDA);
        });
    }

    test('deterministic: same mint always produces same PDA', () => {
        const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        const first = deriveMetadataPDA(mint);
        const second = deriveMetadataPDA(mint);
        expect(first).toBe(second);
    });

    test('different mints produce different PDAs', () => {
        const pdas = PDA_TEST_VECTORS.map(([, mint]) => deriveMetadataPDA(mint));
        const unique = new Set(pdas);
        expect(unique.size).toBe(pdas.length);
    });

    test('result decodes to 32 bytes', () => {
        const pda = deriveMetadataPDA('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
        expect(bs58.decode(pda).length).toBe(32);
    });
});

// --- Metaplex binary parsing ---

/** Build a minimal Metaplex metadata buffer for testing. */
function buildMetaplexBuffer(name: string, symbol: string, padName = 32, padSymbol = 10): Buffer {
    const header = Buffer.alloc(1 + 32 + 32); // key + update_authority + mint
    header[0] = 4; // MetadataV1 key

    const nameBuf = Buffer.alloc(padName);
    nameBuf.write(name, 'utf8');
    const nameLen = Buffer.alloc(4);
    nameLen.writeUInt32LE(padName);

    const symbolBuf = Buffer.alloc(padSymbol);
    symbolBuf.write(symbol, 'utf8');
    const symbolLen = Buffer.alloc(4);
    symbolLen.writeUInt32LE(padSymbol);

    return Buffer.concat([header, nameLen, nameBuf, symbolLen, symbolBuf]);
}

describe('parseMetaplexMetadata', () => {
    test('parses USDC-like metadata', () => {
        const buf = buildMetaplexBuffer('USD Coin', 'USDC');
        const result = parseMetaplexMetadata(buf);
        expect(result).toEqual({ name: 'USD Coin', symbol: 'USDC' });
    });

    test('parses Wrapped SOL-like metadata', () => {
        const buf = buildMetaplexBuffer('Wrapped SOL', 'SOL');
        const result = parseMetaplexMetadata(buf);
        expect(result).toEqual({ name: 'Wrapped SOL', symbol: 'SOL' });
    });

    test('strips null padding from strings', () => {
        const buf = buildMetaplexBuffer('AB\0\0\0', 'CD\0', 5, 3);
        const result = parseMetaplexMetadata(buf);
        expect(result).toEqual({ name: 'AB', symbol: 'CD' });
    });

    test('handles name that fills entire padded length', () => {
        const buf = buildMetaplexBuffer('ExactlyThirtyTwoCharactersLong!!', 'SYM', 32, 10);
        const result = parseMetaplexMetadata(buf);
        expect(result?.name).toBe('ExactlyThirtyTwoCharactersLong!!');
    });

    test('returns null for empty buffer', () => {
        expect(parseMetaplexMetadata(Buffer.alloc(0))).toBeNull();
    });

    test('returns null for buffer too short for header', () => {
        expect(parseMetaplexMetadata(Buffer.alloc(60))).toBeNull();
    });

    test('returns null for truncated buffer (name length exceeds data)', () => {
        const buf = Buffer.alloc(1 + 32 + 32 + 4);
        buf.writeUInt32LE(999, 65); // name_len = 999, but buffer is only 69 bytes
        expect(parseMetaplexMetadata(buf)).toBeNull();
    });

    test('returns null for truncated buffer (symbol length exceeds data)', () => {
        const header = Buffer.alloc(1 + 32 + 32);
        const nameLen = Buffer.alloc(4);
        nameLen.writeUInt32LE(4);
        const nameBuf = Buffer.from('Test');
        const symbolLen = Buffer.alloc(4);
        symbolLen.writeUInt32LE(999); // exceeds remaining
        expect(parseMetaplexMetadata(Buffer.concat([header, nameLen, nameBuf, symbolLen]))).toBeNull();
    });

    test('returns empty strings for all-null name and symbol', () => {
        const buf = buildMetaplexBuffer('\0\0\0\0', '\0\0', 4, 2);
        const result = parseMetaplexMetadata(buf);
        expect(result).toEqual({ name: '', symbol: '' });
    });
});
