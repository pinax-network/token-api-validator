import { Cron } from 'croner';
import { config } from './config.js';
import { logger } from './logger.js';
import { isRunning, runValidation } from './validator.js';

let job: Cron | null = null;

export function startScheduler(): void {
    job = new Cron(config.cronSchedule, async () => {
        if (isRunning()) {
            logger.warn('Scheduled run skipped: validation already in progress');
            return;
        }
        logger.info('Scheduled validation run starting');
        await runValidation('scheduled');
    });

    logger.info(`Scheduler started: ${config.cronSchedule}`);
}

export function stopScheduler(): void {
    if (job) {
        job.stop();
        job = null;
        logger.info('Scheduler stopped');
    }
}
