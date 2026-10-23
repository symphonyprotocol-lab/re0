/**
 * The public status page's derivation. requirement.md 13.3: the figures come
 * from the platform's own rows, and an incident is a run of days the rows
 * say were bad -- so the arithmetic that turns rows into a verdict is what
 * gets checked here, without a database.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveIncidents,
  summarizeStatus,
  THRESHOLDS,
  windowDays,
  type ApiDay,
  type StatusFacts,
} from '@/lib/domain/status';

const now = new Date('2026-09-07T10:00:00Z');
const days = windowDays(now);
const today = days[days.length - 1]!;
const yesterday = days[days.length - 2]!;

const quiet: StatusFacts = {
  now,
  api: [],
  operations: [],
  refresh: { scheduled: 0, overdue: 0, open: 0, nextDueAt: null },
};

const component = (id: string, facts: StatusFacts) =>
  summarizeStatus(facts).components.find((entry) => entry.id === id)!;

describe('window', () => {
  it('is 90 UTC days ending today', () => {
    expect(days).toHaveLength(90);
    expect(today).toBe('2026-09-07');
    expect(days[0]).toBe('2026-06-10');
  });
});

describe('a platform with no rows', () => {
  it('knows nothing rather than claiming health', () => {
    const status = summarizeStatus(quiet);
    expect(status.components.map((entry) => entry.health)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(status.components[0]!.successBps).toBeNull();
    expect(status.components[0]!.strip.every((day) => day.health === null)).toBe(true);
    expect(status.incidents).toEqual([]);
    expect(status.checkedAt).toBe(now);
  });
});

describe('retrieval', () => {
  const day = (key: string, requests: number, failures: number, p95Ms = 120): ApiDay => ({
    day: key,
    requests,
    failures,
    p95Ms,
  });

  it('reads a day as degraded only above the failure threshold with enough traffic', () => {
    const retrieval = component('retrieval', {
      ...quiet,
      api: [day(yesterday, 1_000, 5), day(today, 3, 1)],
    });
    /* Yesterday: 0.5% 5xx, under the 1% line. Today: one failure in three is
       not a signal, so the day is fine. */
    expect(retrieval.strip[retrieval.strip.length - 2]!.health).toBe('ok');
    expect(retrieval.strip[retrieval.strip.length - 1]!.health).toBe('ok');
    expect(retrieval.health).toBe('ok');
    expect(retrieval.today).toEqual({ requests: 3, p95Ms: 120 });
  });

  it('carries success rate and p95 through, and the last known day decides health', () => {
    const retrieval = component('retrieval', {
      ...quiet,
      api: [day(yesterday, 200, 10, 450)],
    });
    expect(retrieval.successBps).toBe(9_500);
    expect(retrieval.health).toBe('degraded');
    /* Nothing today: the strip says so instead of inventing a healthy day. */
    expect(retrieval.strip[retrieval.strip.length - 1]!.health).toBeNull();
    expect(retrieval.today).toEqual({ requests: 0, p95Ms: null });
  });

  it('thresholds are the ones the console health panel uses', () => {
    expect(THRESHOLDS.apiFailureBps).toBe(100);
    expect(THRESHOLDS.apiMinRequests).toBeGreaterThan(1);
  });
});

describe('indexing', () => {
  it('a lone failed build is a degraded day; a failure among many is not', () => {
    const indexing = component('indexing', {
      ...quiet,
      operations: [
        { day: yesterday, finished: 1, failed: 1 },
        { day: today, finished: 10, failed: 1 },
      ],
    });
    expect(indexing.strip[indexing.strip.length - 2]!.health).toBe('degraded');
    expect(indexing.strip[indexing.strip.length - 1]!.health).toBe('ok');
    expect(indexing.health).toBe('ok');
    expect(indexing.successBps).toBe(10_000 - Math.round((2 / 11) * 10_000));
  });
});

describe('refresh', () => {
  it('an overdue timed source degrades refresh; nothing scheduled is unknown', () => {
    expect(
      component('refresh', {
        ...quiet,
        refresh: { scheduled: 4, overdue: 1, open: 0, nextDueAt: null },
      }).health,
    ).toBe('degraded');
    expect(
      component('refresh', {
        ...quiet,
        refresh: { scheduled: 4, overdue: 0, open: 2, nextDueAt: now },
      }).health,
    ).toBe('ok');
    expect(component('refresh', quiet).health).toBe('unknown');
  });
});

describe('incidents', () => {
  it('groups consecutive degraded days, keeps the peak, and marks a run reaching today ongoing', () => {
    const strip = days.map((day) => ({
      day,
      health:
        day === days[10] || day === days[11] || day === days[12] || day === today
          ? ('degraded' as const)
          : day === days[20]
            ? null
            : ('ok' as const),
    }));
    const bps = new Map([
      [days[10]!, 300],
      [days[11]!, 1_200],
      [days[12]!, 200],
      [today, 150],
    ]);
    const incidents = deriveIncidents('retrieval', strip, (day) => bps.get(day) ?? 0);
    expect(incidents).toEqual([
      {
        component: 'retrieval',
        from: today,
        to: today,
        days: 1,
        peakFailureBps: 150,
        ongoing: true,
      },
      {
        component: 'retrieval',
        from: days[10],
        to: days[12],
        days: 3,
        peakFailureBps: 1_200,
        ongoing: false,
      },
    ]);
  });

  it('are derived from the rows, newest first, across components', () => {
    const status = summarizeStatus({
      ...quiet,
      api: [{ day: days[5]!, requests: 500, failures: 100, p95Ms: 900 }],
      operations: [{ day: days[50]!, finished: 4, failed: 4 }],
    });
    expect(status.incidents.map((incident) => [incident.component, incident.from])).toEqual([
      ['indexing', days[50]],
      ['retrieval', days[5]],
    ]);
    expect(status.incidents[1]!.peakFailureBps).toBe(2_000);
    expect(status.incidents.every((incident) => !incident.ongoing)).toBe(true);
  });
});
