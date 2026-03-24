#!/usr/bin/env bun
/**
 * Fetch top tokens by market cap from CoinGecko and save to tokens.json.
 *
 * 1. GET /coins/list?include_platform=true → all coins with platform addresses
 * 2. GET /coins/markets?order=market_cap_desc → top N by market cap
 * 3. Cross-reference: extract platform addresses for our supported networks
 * 4. RPC batch per network: check totalSupply + decimals on-chain
 * 5. Filter out dead deployments (totalSupply = 0) and add decimals
 * 6. Output flat array of { network, contract, symbol, name, decimals, coingecko_id }
 *
 * Requires .env with COINGECKO_API_KEY, PINAX_RPC_API_KEY, and DRPC_API_KEY (for Solana).
 *
 * Usage: bun scripts/fetch-tokens.ts [--pages 2] [--dry-run]
 *
 * --dry-run: runs all steps (including RPC checks) but skips writing tokens.json.
 */

import { type Address, createPublicClient, http } from 'viem';
import { config } from '../src/config.js';
import { erc20Abi } from '../src/providers/rpc.js';
import { DRPC_SOLANA_URL } from '../src/providers/solana-rpc.js';
import { getRpcUrl, PLATFORM_TO_NETWORK, syncRegistry } from '../src/registry.js';
import { withRetry } from '../src/utils/retry.js';

const API_KEY = process.env.COINGECKO_API_KEY;
if (!API_KEY) {
    console.error('Error: COINGECKO_API_KEY environment variable is required.');
    process.exit(1);
}

const CG_BASE = 'https://api.coingecko.com/api/v3';
const CG_HEADERS = { 'x-cg-demo-api-key': API_KEY };
const PER_PAGE = 250;
const CG_RATE_LIMIT_MS = 6500;

async function fetchCoinGecko<T>(path: string): Promise<T> {
    const url = `${CG_BASE}${path}`;
    return withRetry(
        async () => {
            const res = await fetch(url, { headers: CG_HEADERS });
            if (!res.ok) throw new Error(`CoinGecko ${res.status}: ${(await res.text()).slice(0, 200)}`);
            return res.json() as Promise<T>;
        },
        { maxAttempts: config.retryMaxAttempts, baseDelay: 30_000 },
        `coingecko:${path.split('?')[0]}`
    );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function normalizeContract(network: string, contract: string): string {
    return network === 'solana' ? contract : contract.toLowerCase();
}

function tokenKey(network: string, contract: string): string {
    return `${network}:${normalizeContract(network, contract)}`;
}

interface OnChainData {
    totalSupply: bigint | null;
    decimals: number | null;
}

async function checkEvmContracts(network: string, contracts: string[]): Promise<Map<string, OnChainData>> {
    const rpcUrl = getRpcUrl(network);
    if (!rpcUrl) return new Map();

    const client = createPublicClient({
        transport: http(rpcUrl, {
            batch: { wait: 0, batchSize: config.rpcBatchSize },
            retryCount: config.retryMaxAttempts - 1,
            retryDelay: config.retryBaseDelayMs,
        }),
    });

    const calls = contracts.flatMap((addr) => [
        client.readContract({ address: addr as Address, abi: erc20Abi, functionName: 'totalSupply' }),
        client.readContract({ address: addr as Address, abi: erc20Abi, functionName: 'decimals' }),
    ]);

    const results = await Promise.allSettled(calls);
    const out = new Map<string, OnChainData>();

    for (let i = 0; i < contracts.length; i++) {
        const supplyResult = results[i * 2];
        const decimalsResult = results[i * 2 + 1];
        const contract = contracts[i];
        if (!contract) continue;
        out.set(normalizeContract(network, contract), {
            totalSupply: supplyResult?.status === 'fulfilled' ? (supplyResult.value as bigint) : null,
            decimals: decimalsResult?.status === 'fulfilled' ? Number(decimalsResult.value) : null,
        });
    }
    return out;
}

async function checkSolanaContracts(mints: string[]): Promise<Map<string, OnChainData>> {
    if (!config.drpcApiKey) return new Map();

    const calls = mints.map((mint, i) => ({ jsonrpc: '2.0', id: i, method: 'getTokenSupply', params: [mint] }));

    const res = await withRetry(
        async () => {
            const r = await fetch(DRPC_SOLANA_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Drpc-Key': config.drpcApiKey as string },
                body: JSON.stringify(calls),
            });
            if (!r.ok) throw new Error(`Solana RPC ${r.status}: ${(await r.text()).slice(0, 200)}`);
            return r.json() as Promise<{ id: number; result?: { value: { amount: string; decimals: number } } }[]>;
        },
        { maxAttempts: config.retryMaxAttempts, baseDelay: config.retryBaseDelayMs },
        'rpc:solana'
    );

    const out = new Map<string, OnChainData>();
    for (const entry of res) {
        const mint = mints[entry.id];
        const value = entry.result?.value;
        if (mint && value) {
            out.set(mint, {
                totalSupply: BigInt(value.amount ?? '0'),
                decimals: typeof value.decimals === 'number' ? value.decimals : null,
            });
        }
    }
    return out;
}

interface CoinListEntry {
    id: string;
    symbol: string;
    name: string;
    platforms: Record<string, string>;
}

interface CoinMarket {
    id: string;
    symbol: string;
    name: string;
    market_cap: number | null;
}

interface TokenOutput {
    network: string;
    contract: string;
    symbol: string;
    name: string;
    decimals: number | null;
    coingecko_id: string;
}

const pagesArg = process.argv.indexOf('--pages');
const pages = pagesArg !== -1 ? Number(process.argv[pagesArg + 1]) : 2;
const dryRun = process.argv.includes('--dry-run');

async function main() {
    console.log('Syncing network registry...');
    await syncRegistry();

    console.log('Fetching full coins list with platforms...');
    const allCoins = await fetchCoinGecko<CoinListEntry[]>('/coins/list?include_platform=true');
    console.log(`  Total coins in CoinGecko: ${allCoins.length}`);

    const platformsById = new Map<string, Record<string, string>>();
    for (const coin of allCoins) {
        if (coin.platforms && Object.keys(coin.platforms).length > 0) {
            platformsById.set(coin.id, coin.platforms);
        }
    }

    await sleep(CG_RATE_LIMIT_MS);

    console.log(`Fetching top tokens by market cap (${pages} pages)...`);
    const markets: CoinMarket[] = [];
    for (let page = 1; page <= pages; page++) {
        const coins = await fetchCoinGecko<CoinMarket[]>(
            `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${PER_PAGE}&page=${page}`
        );
        if (!coins.length) break;
        markets.push(...coins);
        console.log(`  Page ${page}: ${coins.length} coins`);
        if (coins.length < PER_PAGE) break;
        if (page < pages) await sleep(CG_RATE_LIMIT_MS);
    }
    console.log(`  Total market entries: ${markets.length}`);

    const candidates: TokenOutput[] = [];
    const seen = new Set<string>();

    for (const market of markets) {
        const platforms = platformsById.get(market.id);
        if (!platforms) continue;

        for (const [platform, rawAddress] of Object.entries(platforms)) {
            const network = PLATFORM_TO_NETWORK[platform];
            const address = rawAddress?.trim();
            if (!network || !address) continue;

            const key = tokenKey(network, address);
            if (seen.has(key)) continue;
            seen.add(key);

            candidates.push({
                network,
                contract: address,
                symbol: market.symbol.toUpperCase(),
                name: market.name,
                decimals: null,
                coingecko_id: market.id,
            });
        }
    }
    console.log(`\nCandidates: ${candidates.length} token-network pairs`);

    console.log('\nChecking on-chain supply and decimals...');
    const byNetwork = new Map<string, TokenOutput[]>();
    for (const t of candidates) {
        const list = byNetwork.get(t.network) ?? [];
        list.push(t);
        byNetwork.set(t.network, list);
    }

    const deadKeys = new Set<string>();
    const decimalsMap = new Map<string, number>();

    for (const [network, tokens] of [...byNetwork.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const contracts = tokens.map((t) => t.contract);
        const onChain =
            network === 'solana' ? await checkSolanaContracts(contracts) : await checkEvmContracts(network, contracts);

        if (onChain.size === 0) {
            console.log(`  ${network.padEnd(15)} ${tokens.length} tokens, skipped (no RPC)`);
            continue;
        }

        let deadCount = 0;
        let failedCount = 0;
        for (const token of tokens) {
            const data = onChain.get(normalizeContract(network, token.contract));
            if (!data || data.totalSupply === null) {
                failedCount++;
                continue;
            }
            const key = tokenKey(network, token.contract);
            if (data.totalSupply === 0n) {
                deadKeys.add(key);
                deadCount++;
            } else if (data.decimals !== null) {
                decimalsMap.set(key, data.decimals);
            }
        }
        const status = [`${onChain.size} checked`, `${deadCount} dead`];
        if (failedCount > 0) status.push(`${failedCount} failed`);
        console.log(`  ${network.padEnd(15)} ${tokens.length} tokens, ${status.join(', ')}`);
    }

    const results = candidates
        .filter((t) => !deadKeys.has(tokenKey(t.network, t.contract)))
        .map((t) => ({ ...t, decimals: decimalsMap.get(tokenKey(t.network, t.contract)) ?? null }))
        .sort((a, b) => a.network.localeCompare(b.network));

    if (deadKeys.size > 0) {
        console.log(`\nRemoved ${deadKeys.size} dead deployments (totalSupply=0):`);
        for (const t of candidates.filter((c) => deadKeys.has(tokenKey(c.network, c.contract)))) {
            console.log(`  ${t.symbol.padEnd(8)} ${t.network.padEnd(15)} ${t.contract}`);
        }
    }

    const outPath = new URL('../tokens.json', import.meta.url).pathname;
    if (dryRun) {
        console.log(`\n--dry-run: would write ${results.length} token references to ${outPath}`);
    } else {
        await Bun.write(outPath, `${JSON.stringify(results, null, 4)}\n`);
        console.log(`\nWrote ${results.length} token references to ${outPath}`);
    }

    const networkCounts = new Map<string, number>();
    for (const r of results) networkCounts.set(r.network, (networkCounts.get(r.network) || 0) + 1);
    console.log('\nTokens per network:');
    for (const [network, count] of [...networkCounts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${network.padEnd(20)} ${count}`);
    }

    const withDecimals = results.filter((r) => r.decimals !== null).length;
    console.log(`\nDecimals: ${withDecimals}/${results.length} tokens have on-chain decimals`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
