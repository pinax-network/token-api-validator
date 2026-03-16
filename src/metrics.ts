import { Counter, collectDefaultMetrics, Histogram, Registry } from 'prom-client';

export const register = new Registry();
collectDefaultMetrics({ register });

export const runsTotal = new Counter({
    name: 'validator_runs_total',
    help: 'Total validation runs completed',
    labelNames: ['trigger', 'status'] as const,
    registers: [register],
});

export const runDuration = new Histogram({
    name: 'validator_run_duration_seconds',
    help: 'Validation run duration in seconds',
    buckets: [10, 30, 60, 120, 300, 600],
    registers: [register],
});

export const tokensChecked = new Counter({
    name: 'validator_tokens_checked_total',
    help: 'Total tokens checked across all runs',
    labelNames: ['network'] as const,
    registers: [register],
});

export const providerRequests = new Counter({
    name: 'validator_provider_requests_total',
    help: 'Total provider API requests',
    labelNames: ['provider', 'network', 'endpoint', 'status'] as const,
    registers: [register],
});

export const providerDuration = new Histogram({
    name: 'validator_provider_request_duration_seconds',
    help: 'Provider API request duration in seconds',
    labelNames: ['provider', 'endpoint'] as const,
    buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [register],
});

export const batchRequests = new Counter({
    name: 'validator_provider_batch_requests_total',
    help: 'Total batch API requests',
    labelNames: ['provider', 'network', 'status'] as const,
    registers: [register],
});

export const batchFallbacks = new Counter({
    name: 'validator_provider_batch_fallbacks_total',
    help: 'Total batch requests that fell back to individual fetches',
    labelNames: ['provider', 'network'] as const,
    registers: [register],
});

export const batchSize = new Histogram({
    name: 'validator_provider_batch_size',
    help: 'Number of items per batch request',
    labelNames: ['provider', 'network'] as const,
    buckets: [2, 5, 10, 25, 50, 75, 100],
    registers: [register],
});

export const clickhouseWrites = new Counter({
    name: 'validator_clickhouse_writes_total',
    help: 'Total ClickHouse write operations',
    labelNames: ['status'] as const,
    registers: [register],
});
