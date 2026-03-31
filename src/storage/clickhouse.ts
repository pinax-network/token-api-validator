import { createClient } from '@clickhouse/client-web';
import pkg from '../../package.json' with { type: 'json' };
import { config } from '../config.js';
import { logger } from '../logger.js';
import { clickhouseWrites } from '../metrics.js';
import { withRetry } from '../utils/retry.js';
import type { ComparisonRecord, RunRecord } from './types.js';

export type { ComparisonRecord, RunRecord } from './types.js';

const VERSION = `v${pkg.version}`;

const client = createClient({
    application: 'token-api-validator',
    url: config.clickhouseUrl,
    database: config.clickhouseDatabase,
    username: config.clickhouseUsername,
    password: config.clickhousePassword,
    keep_alive: { enabled: false },
});

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

export async function getLastRunTime(): Promise<Date | null> {
    const result = await withRetry(
        () =>
            client.query({
                query: 'SELECT max(started_at) AS last FROM runs',
                format: 'JSONEachRow',
            }),
        { maxAttempts: config.retryMaxAttempts, baseDelay: config.retryBaseDelayMs },
        'clickhouse:getLastRunTime'
    );
    const row = (await result.json<{ last: string }>())[0];
    // ClickHouse returns epoch zero for max() on empty table, not NULL
    if (!row?.last || row.last === '1970-01-01 00:00:00') return null;
    return new Date(`${row.last}Z`);
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

        if (run.status !== 'failed') {
            await materializeRegressions(run.started_at);
        }
    } catch (error) {
        clickhouseWrites.inc({ status: 'error' });
        throw error;
    }
}

async function materializeRegressions(runAt: string): Promise<void> {
    try {
        await withRetry(
            async () => {
                await client.command({
                    query: `INSERT INTO regression_materialized
                        SELECT * FROM regression_status
                        WHERE run_at = {runAt:DateTime}`,
                    query_params: { runAt },
                });
            },
            { maxAttempts: config.retryMaxAttempts, baseDelay: config.retryBaseDelayMs },
            'clickhouse:materializeRegressions'
        );
        logger.info(`Materialized regressions for run_at=${runAt}`);
    } catch (error) {
        logger.error('Failed to materialize regressions:', error);
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

async function getDomainReport(domain: string, runAt: string): Promise<DomainReport> {
    const params = { domain, runAt };

    const [metricsResult, regressionsResult, mismatchesResult] = await Promise.all([
        client.query({
            query: `SELECT * FROM run_metrics WHERE domain = {domain:String} AND run_at = {runAt:DateTime}`,
            query_params: params,
            format: 'JSONEachRow',
        }),
        client.query({
            query: `SELECT network, contract, symbol, field, entity, provider,
                        our_value, reference_value, relative_diff, tolerance,
                        our_url, reference_url
                    FROM regression_materialized
                    WHERE domain = {domain:String}
                        AND run_at = (SELECT max(run_at) FROM regression_materialized WHERE domain = {domain:String} AND run_at <= {runAt:DateTime})
                        AND is_regression
                    ORDER BY network, symbol, field, entity, provider`,
            query_params: params,
            format: 'JSONEachRow',
        }),
        client.query({
            query: `SELECT network, contract, symbol, field, entity, provider,
                        our_value, reference_value, relative_diff, tolerance,
                        our_null_reason, reference_null_reason
                    FROM comparison_enriched
                    WHERE domain = {domain:String}
                        AND run_at = {runAt:DateTime}
                        AND is_comparable AND NOT is_match
                    ORDER BY network, symbol, field, entity, provider`,
            query_params: params,
            format: 'JSONEachRow',
        }),
    ]);

    const [metrics, regressions, mismatches] = await Promise.all([
        metricsResult.json<DomainMetrics>().then((rows) => rows[0] ?? null),
        regressionsResult.json<RegressionRow>(),
        mismatchesResult.json<MismatchRow>(),
    ]);

    return { metrics, regressions, mismatches };
}

export async function getReport(): Promise<Report | null> {
    const runResult = await client.query({
        query: 'SELECT * FROM runs ORDER BY started_at DESC LIMIT 1',
        format: 'JSONEachRow',
    });
    const run = (await runResult.json<RunRecord>())[0];
    if (!run) return null;

    const [metadata, balance] = await Promise.all([
        getDomainReport('metadata', run.started_at),
        getDomainReport('balance', run.started_at),
    ]);

    return { run, metadata, balance };
}
