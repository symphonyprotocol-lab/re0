import { describe, expect, it } from 'vitest';
import {
  parseDay,
  parseRequestFilter,
  REQUEST_MAX_PAGE,
  requestFilterParams,
} from '@/lib/domain/request-log';
import { csvCell } from '@/lib/application/administration/csv';
import { calendarMonth, periodLastDay } from '@/lib/application/plans/billing';

/**
 * The request-log screen's state lives in the URL (requirement.md 5.2:
 * time, status, entrypoint and asset filters, CSV export), so every field
 * arrives as an unvalidated string and must fall back rather than throw.
 */
describe('parseRequestFilter', () => {
  it('reads an empty query as the unfiltered first page', () => {
    expect(parseRequestFilter({})).toEqual({
      from: undefined,
      to: undefined,
      status: undefined,
      entrypoint: undefined,
      asset: undefined,
      query: undefined,
      page: 1,
    });
  });

  it('reads every supported filter', () => {
    const filter = parseRequestFilter({
      from: '2026-09-01',
      to: '2026-09-07',
      status: 'error',
      entrypoint: 'mcp',
      asset: '/vercel/next.js',
      q: '  abc  ',
      page: '3',
    });
    expect(filter.from?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    /* `to` is the day after the one typed: the range is inclusive on screen. */
    expect(filter.to?.toISOString()).toBe('2026-09-08T00:00:00.000Z');
    expect(filter.status).toBe('error');
    expect(filter.entrypoint).toBe('mcp');
    expect(filter.asset).toBe('/vercel/next.js');
    expect(filter.query).toBe('abc');
    expect(filter.page).toBe(3);
  });

  it('drops values the screen does not support instead of failing', () => {
    const filter = parseRequestFilter({
      from: '2026-13-01',
      to: 'yesterday',
      status: '4xx',
      entrypoint: 'sdk',
      asset: '   ',
      q: '',
      page: 'abc',
    });
    expect(filter).toEqual({
      from: undefined,
      to: undefined,
      status: undefined,
      entrypoint: undefined,
      asset: undefined,
      query: undefined,
      page: 1,
    });
  });

  it('bounds the page and ignores repeated parameters', () => {
    expect(parseRequestFilter({ page: '0' }).page).toBe(1);
    expect(parseRequestFilter({ page: '-2' }).page).toBe(1);
    expect(parseRequestFilter({ page: '99999999' }).page).toBe(REQUEST_MAX_PAGE);
    expect(parseRequestFilter({ status: ['ok', 'error'] }).status).toBeUndefined();
  });

  it('caps free text and the asset id at what the query will take', () => {
    expect(parseRequestFilter({ q: 'x'.repeat(500) }).query).toHaveLength(200);
    expect(parseRequestFilter({ asset: 'y'.repeat(500) }).asset).toHaveLength(200);
  });
});

describe('parseDay', () => {
  it('refuses a day the calendar does not have', () => {
    expect(parseDay('2026-02-31')).toBeUndefined();
    expect(parseDay('2026-02-28')?.toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });

  /*
   * The exclusive end is the typed day plus one, and the typed day still has
   * to exist. The rollover check used to be skipped whenever a day was going
   * to have one added to it, so `to` accepted every impossible date and
   * silently became a different one: 2026-02-31 read as 4 March, 2026-13-45
   * as 15 February 2027, 2026-00-00 as 1 December 2025 -- an empty log with
   * no explanation, and a URL the screen then echoed back rewritten.
   */
  it('refuses an impossible day just as firmly when it is an exclusive end', () => {
    for (const day of ['2026-02-31', '2026-13-45', '2026-00-00', '2026-04-31', '2027-02-29']) {
      expect(parseDay(day, true), day).toBeUndefined();
      expect(parseDay(day), day).toBeUndefined();
    }
  });

  it('still admits a real day as the day after it', () => {
    expect(parseDay('2026-02-28', true)?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    /* A leap day, and a year boundary. */
    expect(parseDay('2028-02-29', true)?.toISOString()).toBe('2028-03-01T00:00:00.000Z');
    expect(parseDay('2026-12-31', true)?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

/**
 * The screen, its pagination links and the CSV export all read the same
 * filter, so a `to` the parser accepted has to survive the round trip back
 * into the query string unchanged. A rewritten date is the screen telling the
 * reader they asked for something they did not.
 */
describe('an impossible `to` never reaches the screen', () => {
  it('drops it rather than rewriting it', () => {
    for (const to of ['2026-02-31', '2026-13-45', '2026-00-00']) {
      const filter = parseRequestFilter({ to });
      expect(filter.to, to).toBeUndefined();
      expect(requestFilterParams(filter).has('to'), to).toBe(false);
    }
  });

  it('echoes a real one back exactly as typed', () => {
    const filter = parseRequestFilter({ to: '2026-02-28' });
    expect(requestFilterParams(filter).get('to')).toBe('2026-02-28');
  });
});

/** Pagination links and the export carry the filter back out unchanged. */
describe('requestFilterParams', () => {
  it('round-trips through the query string', () => {
    const params = {
      from: '2026-09-01',
      to: '2026-09-07',
      status: 'ok',
      entrypoint: 'rest',
      asset: '/a/b',
      q: 'req',
      page: '2',
    };
    const back = Object.fromEntries(requestFilterParams(parseRequestFilter(params)).entries());
    expect(back).toEqual(params);
  });

  it('omits page one and empty fields', () => {
    expect(requestFilterParams(parseRequestFilter({}), 1).toString()).toBe('');
    expect(requestFilterParams(parseRequestFilter({ q: 'a' }), 4).toString()).toBe('q=a&page=4');
  });
});

/**
 * The request export writes its cells with the console's `csvCell`. There is
 * one implementation of these rules, not one per export: a second copy lived
 * in `lib/domain/request-log.ts` and had drifted from it, missing the leading
 * tab and carriage return that Excel reads the same way as `=`, and
 * stringifying a `Date` through the locale-dependent `String()`.
 */
describe('csvCell', () => {
  it('quotes what needs quoting and defuses formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(null)).toBe('');
    expect(csvCell(12)).toBe('12');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=1+1')).toBe("'=1+1");
  });

  it('guards every prefix a spreadsheet reads as a formula, not just `=`', () => {
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    /* A leading tab or carriage return walks a naive prefix check past the
       payload; both are guarded, and the CR is then quoted as well. */
    expect(csvCell('\t=1+1')).toBe("'\t=1+1");
    expect(csvCell('\r=1+1')).toBe('"\'\r=1+1"');
  });

  it('writes a timestamp as ISO rather than through the server locale', () => {
    expect(csvCell(new Date('2026-09-07T12:34:56.000Z'))).toBe('2026-09-07T12:34:56.000Z');
  });
});

/**
 * The billing period's printed end.
 *
 * The window is half-open and stored in UTC, so `periodEnd` is the first
 * instant after the period and the last day inside it is one day back. The
 * overview and the settings screen both print that day and had each invented
 * their own arithmetic -- one subtracted a millisecond, the other a day --
 * which agreed only when the server ran in UTC. One rule now, and both
 * callers format it with a UTC formatter.
 */
describe('periodLastDay', () => {
  it('is the last day inside a calendar-month period', () => {
    expect(periodLastDay(new Date('2026-10-01T00:00:00.000Z')).toISOString()).toBe(
      '2026-09-30T00:00:00.000Z',
    );
    expect(periodLastDay(new Date('2027-01-01T00:00:00.000Z')).toISOString()).toBe(
      '2026-12-31T00:00:00.000Z',
    );
  });

  it('lands on the right day across a leap February', () => {
    expect(periodLastDay(new Date('2028-03-01T00:00:00.000Z')).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });

  it('agrees with the window `calendarMonth` builds', () => {
    const { periodStart, periodEnd } = calendarMonth(new Date('2026-09-08T11:22:33.000Z'));
    expect(periodStart.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    /* The printed range is "1 - 30 Sep", never "1 Sep - 1 Oct". */
    expect(periodLastDay(periodEnd).toISOString().slice(0, 10)).toBe('2026-09-30');
  });
});
