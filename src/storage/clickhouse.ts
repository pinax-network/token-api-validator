import { createClient } from '@clickhouse/client-web';
import pkg from '../../package.json' with { type: 'json' };
import { config } from '../config.js';
import { logger } from '../logger.js';
import { clickhouseWrites } from '../metrics.js';
import { withRetry } from '../utils/retry.js';

const VERSION = `v${pkg.version}`;

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

/** A single comparison result, stored in the unified `comparisons` table. */
export interface ComparisonRecord {
    run_id: string;
    run_at: string;
    domain: string;
    network: string;
    contract: string;
    symbol: string;
    field: string;
    entity: string;
    our_value: string | null;
    reference_value: string | null;
    provider: string;
    relative_diff: number | null;
    is_match: boolean;
    tolerance: number;
    our_fetched_at: string;
    reference_fetched_at: string;
    our_block_timestamp: string | null;
    reference_block_timestamp: string | null;
    our_url: string;
    reference_url: string;
    our_null_reason: string | null;
    reference_null_reason: string | null;
}

export async function ping(): Promise<boolean> {
    try {
        await withRetry(
            () => client.query({ query: 'SELECT 1', format: 'JSONEachRow' }),
            { maxAttempts: config.retryMaxAttempts, baseDelay: config.retryBaseDelayMs },
            'clickhouse:ping'
        );
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
                    values: [{ ...run, version: VERSION }],
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

/** Tally match/mismatch/null counts from comparison records. */
export function tallyCounts(records: ComparisonRecord[]): {
    comparisons: number;
    matches: number;
    mismatches: number;
    nulls: number;
} {
    let matches = 0;
    let mismatches = 0;
    let nulls = 0;
    for (const c of records) {
        if (isErrorNull(c.our_null_reason) || isErrorNull(c.reference_null_reason)) {
            nulls++;
        } else if (c.is_match) {
            matches++;
        } else {
            mismatches++;
        }
    }
    return { comparisons: records.length, matches, mismatches, nulls };
}

function isErrorNull(reason: string | null): boolean {
    return reason != null && reason !== 'empty';
}

interface DomainMetrics {
    run_at: string;
    domain: string;
    matches: number;
    mismatches: number;
    nulls: number;
    comparable: number;
    accuracy: number | null;
    adjusted_accuracy: number | null;
    coverage: number | null;
    total_comparisons: number;
}

interface RegressionRow {
    network: string;
    contract: string;
    symbol: string;
    field: string;
    entity: string;
    provider: string;
    our_value: string | null;
    reference_value: string | null;
    relative_diff: number | null;
    tolerance: number;
    our_url: string;
    reference_url: string;
}

interface MismatchRow {
    network: string;
    contract: string;
    symbol: string;
    field: string;
    entity: string;
    provider: string;
    our_value: string | null;
    reference_value: string | null;
    relative_diff: number | null;
    tolerance: number;
    our_null_reason: string | null;
    reference_null_reason: string | null;
}

interface DomainReport {
    metrics: DomainMetrics | null;
    regressions: RegressionRow[];
    mismatches: MismatchRow[];
}

export interface Report {
    run: RunRecord;
    metadata: DomainReport;
    balance: DomainReport;
}

async function getDomainReport(domain: string): Promise<DomainReport> {
    const metricsResult = await client.query({
        query: `SELECT * FROM run_metrics WHERE domain = '${domain}' AND run_at = (SELECT max(run_at) FROM run_metrics WHERE domain = '${domain}')`,
        format: 'JSONEachRow',
    });
    const metrics = (await metricsResult.json<DomainMetrics>())[0] ?? null;

    const regressionsResult = await client.query({
        query: `SELECT network, contract, symbol, field, entity, provider,
                    our_value, reference_value, relative_diff, tolerance,
                    our_url, reference_url
                FROM regression_status
                WHERE domain = '${domain}'
                    AND run_at = (SELECT max(run_at) FROM regression_status WHERE domain = '${domain}') AND is_regression
                ORDER BY network, symbol, field, entity, provider`,
        format: 'JSONEachRow',
    });
    const regressions = await regressionsResult.json<RegressionRow>();

    const mismatchesResult = await client.query({
        query: `SELECT network, contract, symbol, field, entity, provider,
                    our_value, reference_value, relative_diff, tolerance,
                    our_null_reason, reference_null_reason
                FROM comparison_enriched
                WHERE domain = '${domain}'
                    AND run_at = (SELECT max(run_at) FROM comparison_enriched WHERE domain = '${domain}')
                    AND is_comparable AND NOT is_match
                ORDER BY network, symbol, field, entity, provider`,
        format: 'JSONEachRow',
    });
    const mismatches = await mismatchesResult.json<MismatchRow>();

    return { metrics, regressions, mismatches };
}

export async function getReport(): Promise<Report | null> {
    const runResult = await client.query({
        query: 'SELECT * FROM runs ORDER BY started_at DESC LIMIT 1',
        format: 'JSONEachRow',
    });
    const run = (await runResult.json<RunRecord>())[0];
    if (!run) return null;

    const [metadata, balance] = await Promise.all([getDomainReport('metadata'), getDomainReport('balance')]);

    return { run, metadata, balance };
}
