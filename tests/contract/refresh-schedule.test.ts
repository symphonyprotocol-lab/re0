import { describe, expect, it } from 'vitest';
import { en } from '@/lib/i18n/messages/en';
import { zh } from '@/lib/i18n/messages/zh';
import { isOperationTrigger, OPERATION_TRIGGERS } from '@/lib/domain/ingestion';
import { REFRESH_INTERVALS_MS, refreshDueAt } from '@/lib/domain/asset';

const checked = new Date('2026-09-06T10:00:00Z');

describe('refreshDueAt', () => {
  it('is one interval after the last check for the timed cadences', () => {
    expect(refreshDueAt('daily', checked)).toEqual(new Date('2026-09-07T10:00:00Z'));
    expect(refreshDueAt('weekly', checked)).toEqual(new Date('2026-09-13T10:00:00Z'));
    expect(REFRESH_INTERVALS_MS.weekly).toBe(7 * REFRESH_INTERVALS_MS.daily);
  });

  it('is due at once for a timed source that was never checked', () => {
    const due = refreshDueAt('daily', null);
    expect(due).not.toBeNull();
    expect(due!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('never falls due by itself for a manual or unreadable policy', () => {
    expect(refreshDueAt('manual', checked)).toBeNull();
    expect(refreshDueAt('manual', null)).toBeNull();
    expect(refreshDueAt('unknown', null)).toBeNull();
  });
});

describe('operation trigger', () => {
  it('names the three ways an operation is asked for, with a label in each language', () => {
    expect(OPERATION_TRIGGERS).toEqual(['manual', 'scheduled', 'platform']);
    for (const trigger of OPERATION_TRIGGERS) {
      expect(isOperationTrigger(trigger)).toBe(true);
      expect(en.admin.refreshQueue.triggers[trigger]).toBeTruthy();
      expect(zh.admin.refreshQueue.triggers[trigger]).toBeTruthy();
    }
    expect(isOperationTrigger('cron')).toBe(false);
  });
});
