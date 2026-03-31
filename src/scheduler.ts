import { Cron } from 'croner';
import { config } from './config.js';
import { logger } from './logger.js';
import { isRunning, runValidation } from './validator.js';

let job: Cron | null = null;

export function startScheduler(lastRunAt: Date | null): void {
    job = new Cron(config.cronSchedule, async () => {
        if (isRunning()) {
            logger.warn('Scheduled run skipped: validation already in progress');
            return;
        }
        logger.info('Scheduled validation run starting');
        await runValidation('scheduled');
    });

    logger.info(`Scheduler started: ${config.cronSchedule}`);

    if (isRunOverdue(config.cronSchedule, lastRunAt)) {
        logger.info('Missed cron tick detected, triggering catch-up run');
        runValidation('scheduled').catch((err) => {
            logger.error('Catch-up run failed:', err);
        });
    }
}

export function isRunOverdue(schedule: string, lastRunAt: Date | null, now = new Date()): boolean {
    if (!lastRunAt) return true;
    const probe = new Cron(schedule);
    const nextAfterLastRun = probe.nextRun(lastRunAt);
    probe.stop();
    return nextAfterLastRun != null && nextAfterLastRun < now;
}

export function stopScheduler(): void {
    if (job) {
        job.stop();
        job = null;
        logger.info('Scheduler stopped');
    }
}
