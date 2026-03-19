#!/usr/bin/env bun
/**
 * Fetch top tokens by market cap from CoinGecko and save to tokens.json.
 *
 * Strategy:
 * 1. GET /coins/list?include_platform=true → all coins with platform addresses
 * 2. GET /coins/markets?order=market_cap_desc → top N by market cap (no category filter)
 * 3. Cross-reference: extract platform addresses for our supported networks
 * 4. Output flat array of { network, contract, symbol, name, coingecko_id }
 *
 * Usage: COINGECKO_API_KEY=xxx bun scripts/fetch-tokens.ts [--pages 2]
 */

import { PLATFORM_TO_NETWORK } from '../src/registry.js';

const API_KEY = process.env.COINGECKO_API_KEY;
if (!API_KEY) {
    console.error('Error: COINGECKO_API_KEY environment variable is required.');
    process.exit(1);
}

const BASE = 'https://api.coingecko.com/api/v3';
const HEADERS = { 'x-cg-demo-api-key': API_KEY };
const PER_PAGE = 250;
const RATE_LIMIT_MS = 6500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch JSON with automatic retry on 429 rate-limit responses. */
async function fetchJSON<T>(url: string, retries = 2): Promise<T> {
    for (let attempt = 0; attempt <= retries; attempt++) {
        const res = await fetch(url, { headers: HEADERS });
        if (res.status === 429 && attempt < retries) {
            console.log(`  Rate limited, waiting 30s... (attempt ${attempt + 1})`);
            await sleep(30000);
            continue;
        }
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`${res.status}: ${body.slice(0, 200)}`);
        }
        return res.json() as Promise<T>;
    }
    throw new Error('Max retries exceeded');
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
    coingecko_id: string;
}

// Parse --pages argument (default: 2 = top 500 tokens)
const pagesArg = process.argv.indexOf('--pages');
const pages = pagesArg !== -1 ? Number(process.argv[pagesArg + 1]) : 2;

async function main() {
    console.log('Fetching full coins list with platforms...');
    const allCoins = await fetchJSON<CoinListEntry[]>(`${BASE}/coins/list?include_platform=true`);
    console.log(`  Total coins in CoinGecko: ${allCoins.length}`);

    const platformsById = new Map<string, Record<string, string>>();
    for (const coin of allCoins) {
        if (coin.platforms && Object.keys(coin.platforms).length > 0) {
            platformsById.set(coin.id, coin.platforms);
        }
    }

    await sleep(RATE_LIMIT_MS);

    console.log(`Fetching top tokens by market cap (${pages} pages)...`);
    const markets: CoinMarket[] = [];
    for (let page = 1; page <= pages; page++) {
        const url = `${BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${PER_PAGE}&page=${page}`;
        const coins = await fetchJSON<CoinMarket[]>(url);
        if (!coins.length) break;
        markets.push(...coins);
        console.log(`  Page ${page}: ${coins.length} coins`);
        if (coins.length < PER_PAGE) break;
        if (page < pages) await sleep(RATE_LIMIT_MS);
    }
    console.log(`  Total market entries: ${markets.length}`);

    const results: TokenOutput[] = [];
    const seen = new Set<string>();

    for (const market of markets) {
        const platforms = platformsById.get(market.id);
        if (!platforms) continue;

        for (const [platform, address] of Object.entries(platforms)) {
            const network = PLATFORM_TO_NETWORK[platform];
            if (!network || !address?.trim()) continue;

            const key = network === 'solana' ? `${network}:${address}` : `${network}:${address.toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);

            results.push({
                network,
                contract: address.trim(),
                symbol: market.symbol.toUpperCase(),
                name: market.name,
                coingecko_id: market.id,
            });
        }
    }

    results.sort((a, b) => a.network.localeCompare(b.network));

    const outPath = new URL('../tokens.json', import.meta.url).pathname;
    await Bun.write(outPath, JSON.stringify(results, null, 4));

    console.log(`\nWrote ${results.length} token references to ${outPath}`);

    const networkCounts = new Map<string, number>();
    for (const r of results) {
        networkCounts.set(r.network, (networkCounts.get(r.network) || 0) + 1);
    }
    const sorted = [...networkCounts.entries()].sort((a, b) => b[1] - a[1]);
    console.log('\nTokens per network:');
    for (const [network, count] of sorted) {
        console.log(`  ${network.padEnd(20)} ${count}`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
