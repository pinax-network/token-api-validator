import { Hono } from 'hono';
import { config } from './config.js';
import { logger } from './logger.js';
import { register } from './metrics.js';
import { syncRegistry } from './registry.js';
import { startScheduler } from './scheduler.js';
import { getLastRunTime, getReport, ping as pingClickHouse } from './storage/clickhouse.js';
import { getProgress, isRunning, runValidation } from './validator.js';

const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));

app.get('/metrics', async (c) => {
    c.header('Content-Type', register.contentType);
    return c.text(await register.metrics());
});

app.post('/trigger', async (c) => {
    if (isRunning()) {
        return c.json({ error: 'Validation run already in progress' }, 409);
    }

    const runId = crypto.randomUUID();
    logger.info(`Manual trigger received, starting run ${runId}`);

    runValidation('manual', runId).catch((err) => {
        logger.error(`Manual run ${runId} failed:`, err);
    });

    return c.json({ run_id: runId, status: 'started' }, 202);
});

app.get('/status', (c) => {
    return c.json(getProgress());
});

app.get('/report', async (c) => {
    try {
        const report = await getReport();
        if (!report) return c.json({ error: 'No completed runs found' }, 404);
        return c.json(report);
    } catch (error) {
        logger.error('Failed to generate report:', error);
        return c.json({ error: 'Failed to query ClickHouse' }, 500);
    }
});

app.notFound((c) => c.json({ error: `Not found: ${c.req.method} ${c.req.path}` }, 404));

if (await pingClickHouse()) {
    logger.info('ClickHouse connection OK');
} else {
    logger.error(`ClickHouse is not reachable at ${config.clickhouseUrl}, exiting`);
    process.exit(1);
}

logger.info('Syncing network registry...');
const [, lastRunAt] = await Promise.all([syncRegistry(), getLastRunTime()]);

logger.info('Starting scheduler...');
startScheduler(lastRunAt);

logger.info(`Starting HTTP server on 0.0.0.0:${config.port}`);

export default {
    ...app,
    port: config.port,
    hostname: '0.0.0.0',
};
