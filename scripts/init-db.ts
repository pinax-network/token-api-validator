#!/usr/bin/env bun
/**
 * Create ClickHouse validation tables and views.
 *
 * Executes all .sql files from schema/ in lexicographic order.
 * Tables use CREATE IF NOT EXISTS, views use CREATE OR REPLACE — safe to run repeatedly.
 *
 * Usage: bun scripts/init-db.ts
 */

import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@clickhouse/client-web';

const url = process.env.CLICKHOUSE_URL;
const username = process.env.CLICKHOUSE_USERNAME;
const password = process.env.CLICKHOUSE_PASSWORD;
const database = process.env.CLICKHOUSE_DATABASE ?? 'validation';

if (!url || !username || !password) {
    console.error('Error: CLICKHOUSE_URL, CLICKHOUSE_USERNAME, CLICKHOUSE_PASSWORD are required.');
    process.exit(1);
}

const client = createClient({
    application: 'token-api-validator-init',
    url,
    username,
    password,
    keep_alive: { enabled: false },
});

const schemaDir = join(import.meta.dir, '..', 'schema');
const files = readdirSync(schemaDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

console.log(`ClickHouse: ${url}`);
console.log(`Database:   ${database}\n`);

for (const file of files) {
    const sql = readFileSync(join(schemaDir, file), 'utf-8').replace(/validation\./g, `${database}.`);
    await client.command({ query: sql });
    console.log(`  ${file}`);
}

console.log('\nDone.');
