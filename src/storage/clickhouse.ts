import { createClient } from '@clickhouse/client-web';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { clickhouseWrites } from '../metrics.js';
import { withRetry } from '../utils/retry.js';

const client = createClient({
    application: 'token-api-validator',
    url: config.clickhouseUrl,
    database: config.clickhouseDatabase,
    username: config.clickhouseUsername,
    password: config.clickhousePassword,
    keep_alive: { enabled: false },
});

/** A single validation run's summary, stored in the `runs` table. */
export interface RunRecord {
    run_id: string;
    started_at: string;
    completed_at: string | null;
    trigger: 'scheduled' | 'manual';
    tokens_checked: number;
    comparisons: number;
    matches: number;
    mismatches: number;
    nulls: number;
    errors: number;
    status: 'success' | 'partial' | 'failed';
    error_detail: string | null;
}

/** A per-field comparison result for one token, stored in the `comparisons` table. */
export interface ComparisonRecord {
    run_id: string;
    run_at: string;
    network: string;
    contract: string;
    symbol: string;
    field: string;
    our_value: string | null;
    reference_value: string | null;
    provider: string;
    relative_diff: number | null;
    is_match: boolean;
    tolerance: number;
    our_fetched_at: string;
    reference_fetched_at: string;
    our_block_timestamp: string | null;
    our_url: string;
    reference_url: string;
    our_null_reason: string | null;
    reference_null_reason: string | null;
}

export async function ping(): Promise<boolean> {
    try {
        await client.query({ query: 'SELECT 1', format: 'JSONEachRow' });
        return true;
    } catch {
        return false;
    }
}

export async function insertRun(run: RunRecord): Promise<void> {
    try {
        await withRetry(
            async () => {
                await client.insert({
                    table: 'runs',
                    values: [run],
                    format: 'JSONEachRow',
                });
            },
            { maxAttempts: config.retryMaxAttempts, baseDelay: config.retryBaseDelayMs },
            'clickhouse:insertRun'
        );
        clickhouseWrites.inc({ status: 'success' });
        logger.info(`Inserted run ${run.run_id} (status=${run.status})`);
    } catch (error) {
        clickhouseWrites.inc({ status: 'error' });
        throw error;
    }
}

export async function insertComparisons(records: ComparisonRecord[]): Promise<void> {
    if (records.length === 0) return;

    try {
        await withRetry(
            async () => {
                await client.insert({
                    table: 'comparisons',
                    values: records,
                    format: 'JSONEachRow',
                });
            },
            { maxAttempts: config.retryMaxAttempts, baseDelay: config.retryBaseDelayMs },
            'clickhouse:insertComparisons'
        );
        clickhouseWrites.inc({ status: 'success' });
        logger.info(`Inserted ${records.length} comparison records`);
    } catch (error) {
        clickhouseWrites.inc({ status: 'error' });
        throw error;
    }
}

export async function getLatestRun(): Promise<RunRecord | null> {
    const result = await client.query({
        query: 'SELECT * FROM runs ORDER BY started_at DESC LIMIT 1',
        format: 'JSONEachRow',
    });

    const rows = await result.json<RunRecord>();
    return rows[0] ?? null;
}
