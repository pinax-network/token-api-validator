import { describe, expect, test } from 'bun:test';
import { isRunOverdue } from './scheduler.js';

const EVERY_6H = '0 */6 * * *';

describe('isRunOverdue', () => {
    test('returns true when no previous run exists', () => {
        expect(isRunOverdue(EVERY_6H, null)).toBe(true);
    });

    test('returns true when a cron tick was missed', () => {
        // Last run at 06:00, now is 13:00 — the 12:00 tick was missed
        const lastRun = new Date('2026-03-31T06:00:00Z');
        const now = new Date('2026-03-31T13:00:00Z');
        expect(isRunOverdue(EVERY_6H, lastRun, now)).toBe(true);
    });

    test('returns false when next tick is still in the future', () => {
        // Last run at 12:00, now is 14:00 — next tick is 18:00
        const lastRun = new Date('2026-03-31T12:00:00Z');
        const now = new Date('2026-03-31T14:00:00Z');
        expect(isRunOverdue(EVERY_6H, lastRun, now)).toBe(false);
    });

    test('returns false immediately after a run completes', () => {
        // Last run at 12:05, now is 12:10 — next tick is 18:00
        const lastRun = new Date('2026-03-31T12:05:00Z');
        const now = new Date('2026-03-31T12:10:00Z');
        expect(isRunOverdue(EVERY_6H, lastRun, now)).toBe(false);
    });

    test('returns true when pod restarts after OOM mid-run', () => {
        // Run started at 12:00, OOM at 12:43, pod restarts at 12:45
        // Last completed run was at 06:00, next tick after that was 12:00 which has passed
        const lastCompletedRun = new Date('2026-03-31T06:00:00Z');
        const now = new Date('2026-03-31T12:45:00Z');
        expect(isRunOverdue(EVERY_6H, lastCompletedRun, now)).toBe(true);
    });

    test('returns true when multiple ticks were missed', () => {
        // Last run 24 hours ago — missed 4 ticks
        const lastRun = new Date('2026-03-30T12:00:00Z');
        const now = new Date('2026-03-31T12:00:01Z');
        expect(isRunOverdue(EVERY_6H, lastRun, now)).toBe(true);
    });

    test('works with different cron schedules', () => {
        const EVERY_HOUR = '0 * * * *';
        // Last run at 14:00, now is 14:30 — next tick is 15:00
        const lastRun = new Date('2026-03-31T14:00:00Z');
        const now = new Date('2026-03-31T14:30:00Z');
        expect(isRunOverdue(EVERY_HOUR, lastRun, now)).toBe(false);

        // Last run at 14:00, now is 15:05 — the 15:00 tick was missed
        const later = new Date('2026-03-31T15:05:00Z');
        expect(isRunOverdue(EVERY_HOUR, lastRun, later)).toBe(true);
    });
});
