#!/usr/bin/env bun
/**
 * Create or recreate ClickHouse validation tables.
 *
 * Usage:
 *   bun scripts/init-db.ts                    # create tables (180 day TTL)
 *   bun scripts/init-db.ts --ttl 90           # custom TTL in days
 *   bun scripts/init-db.ts --drop             # drop and recreate
 */

import 'dotenv/config';
import * as readline from 'node:readline/promises';
import { createClient } from '@clickhouse/client-web';

const url = process.env.CLICKHOUSE_URL;
const username = process.env.CLICKHOUSE_USERNAME;
const password = process.env.CLICKHOUSE_PASSWORD;
const database = process.env.CLICKHOUSE_DATABASE ?? 'validation';

if (!url || !username || !password) {
    console.error('Error: CLICKHOUSE_URL, CLICKHOUSE_USERNAME, CLICKHOUSE_PASSWORD are required.');
    process.exit(1);
}

const ttlArg = process.argv.indexOf('--ttl');
const ttlDays = ttlArg !== -1 ? Number(process.argv[ttlArg + 1]) : 180;
const dropFlag = process.argv.includes('--drop');

const client = createClient({
    application: 'token-api-validator-init',
    url,
    username,
    password,
    keep_alive: { enabled: false },
});

async function tableExists(db: string, table: string): Promise<boolean> {
    const result = await client.query({
        query: `SELECT 1 FROM system.tables WHERE database = '${db}' AND name = '${table}' LIMIT 1`,
        format: 'JSONEachRow',
    });
    const rows = await result.json<{ 1: number }>();
    return rows.length > 0;
}

async function confirm(message: string): Promise<boolean> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`${message} (y/N): `);
    rl.close();
    return answer.toLowerCase() === 'y';
}

async function main() {
    console.log(`ClickHouse: ${url}`);
    console.log(`Database:   ${database}`);
    console.log(`TTL:        ${ttlDays} days`);
    console.log();

    const tables = ['runs', 'comparisons'];

    for (const table of tables) {
        const exists = await tableExists(database, table);

        if (exists) {
            if (dropFlag) {
                const ok = await confirm(`Table '${database}.${table}' exists. Drop and recreate?`);
                if (!ok) {
                    console.log(`  Skipped ${table}.`);
                    continue;
                }
                await client.command({ query: `DROP TABLE ${database}.${table}` });
                console.log(`  Dropped ${database}.${table}.`);
            } else {
                console.log(`Table '${database}.${table}' already exists. Use --drop to recreate.`);
                continue;
            }
        }

        if (table === 'runs') {
            await client.command({
                query: `
					CREATE TABLE ${database}.runs (
						run_id         String    COMMENT 'Unique UUID for this validation run',
						started_at     DateTime  COMMENT 'When the run began',
						completed_at   Nullable(DateTime) COMMENT 'When the run finished (null if still running)',
						trigger        Enum('scheduled', 'manual') COMMENT 'What initiated the run',
						tokens_checked UInt32    COMMENT 'Number of tokens successfully validated',
						comparisons    UInt32    COMMENT 'Total per-field comparison records produced',
						matches        UInt32    COMMENT 'Comparisons where values matched within tolerance',
						mismatches     UInt32    COMMENT 'Comparisons where values differed beyond tolerance',
						nulls          UInt32    COMMENT 'Comparisons excluded from accuracy due to provider errors',
						errors         UInt32    COMMENT 'Tokens that failed to validate (fetch or compare error)',
						status         Enum('success', 'partial', 'failed') COMMENT 'Overall run outcome',
						error_detail   Nullable(String) COMMENT 'Error description when status is partial or failed'
					) ENGINE = ReplicatedMergeTree()
					ORDER BY started_at
					TTL started_at + INTERVAL ${ttlDays} DAY
				`,
            });
        } else {
            await client.command({
                query: `
					CREATE TABLE ${database}.comparisons (
						run_id               String              COMMENT 'References runs.run_id',
						run_at               DateTime            COMMENT 'When the parent run started',
						network              String              COMMENT 'Token API network ID (e.g. mainnet, bsc)',
						contract             String              COMMENT 'Token contract address',
						symbol               String              COMMENT 'Token symbol from tokens.json (for labeling)',
						field                String              COMMENT 'Metadata field compared (decimals, symbol, total_supply)',
						our_value            Nullable(String)    COMMENT 'Value from our Token API',
						reference_value      Nullable(String)    COMMENT 'Value from the reference provider',
						provider             String              COMMENT 'Reference source used (blockscout or etherscan)',
						relative_diff        Nullable(Float64)   COMMENT 'Relative difference for numeric fields (null for exact)',
						is_match             Bool                COMMENT 'Whether values matched within configured tolerance',
						tolerance            Float64             COMMENT 'Tolerance threshold applied (0 for exact, e.g. 0.01 for 1%)',
						our_fetched_at       DateTime            COMMENT 'When our API was queried',
						reference_fetched_at DateTime            COMMENT 'When the reference provider was queried',
						our_block_timestamp  Nullable(DateTime)  COMMENT 'Last indexed block timestamp from our API (for freshness)',
						our_url              String              COMMENT 'Full request URL used for our API query',
						reference_url        String              COMMENT 'Full request URL used for the reference query',
						our_null_reason      Nullable(String)    COMMENT 'Why our value is null (empty, timeout, not_found, etc.)',
						reference_null_reason Nullable(String)   COMMENT 'Why reference value is null (empty, paid_plan_required, etc.)'
					) ENGINE = ReplicatedMergeTree()
					ORDER BY (run_at, network, contract, field)
					TTL run_at + INTERVAL ${ttlDays} DAY
				`,
            });
        }

        console.log(`  Created ${database}.${table}.`);
    }

    console.log('\nDone.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
