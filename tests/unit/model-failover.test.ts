/** Primary and backup models: what errors mean, how long a model cools, the order a request tries (lib/domain/model-failover.ts). */
import { APICallError } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  afterFailure,
  attemptOrder,
  classifyModelFailure,
  COOLING,
  HEALTHY,
  isCooling,
  planWithFree,
  retryAfterMs,
  sameEmbeddingSpace,
  successClears,
  switches,
  type Failure,
  type Health,
  type SwitchingClass,
} from '@/lib/domain/model-failover';

const api = (statusCode: number, body = '', headers: Record<string, string> = {}) =>
  new APICallError({ message: `HTTP ${statusCode}`, url: 'https://provider.test/v1/chat/completions', requestBodyValues: {}, statusCode, responseBody: body, responseHeaders: headers });
const named = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(name), { name, ...extra });
const now = new Date('2026-11-21T12:00:00Z');
const at = (ms: number) => new Date(now.getTime() + ms);
const fail = (kind: SwitchingClass, retry: number | null = null): Failure & { kind: SwitchingClass } => ({ kind, status: null, retryAfterMs: retry });

describe('classifyModelFailure', () => {
  it.each([
    ['402', api(402), 'quota'],
    ['429 insufficient_quota', api(429, '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}'), 'quota'],
    ['400 arrears', api(400, '{"code":"Arrearage","message":"Access denied, please make sure your account is in good standing."}'), 'quota'],
    ['403 balance', api(403, '{"error":"insufficient balance"}'), 'quota'],
    ['429', api(429, '{"error":"too many requests"}'), 'rate_limit'],
    ['gateway rate limit', named('GatewayRateLimitError', { statusCode: 429, type: 'rate_limit_exceeded' }), 'rate_limit'],
    ['500', api(500), 'server'],
    ['503', api(503), 'server'],
    ['529 overloaded', api(529, 'overloaded'), 'server'],
    ['connection reset', Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }) }), 'server'],
    ['unknown', new Error('something odd'), 'server'],
    ['401', api(401), 'auth'],
    ['403', api(403, 'forbidden'), 'auth'],
    ['gateway auth', named('GatewayAuthenticationError', { statusCode: 401 }), 'auth'],
    ['404', api(404), 'model_missing'],
    ['gateway model not found', named('GatewayModelNotFoundError', { statusCode: 404 }), 'model_missing'],
    ['408', api(408), 'timeout'],
    ['400 context length', api(400, '{"error":{"code":"context_length_exceeded"}}'), 'caller'],
    ['422', api(422), 'caller'],
    ['gateway invalid request', named('GatewayInvalidRequestError', { statusCode: 400 }), 'caller'],
  ])('%s → %s', (_, error, kind) => {
    expect(classifyModelFailure(error, {}, now.getTime()).kind).toBe(kind);
  });

  it('reads Retry-After in seconds, as a date and in milliseconds, capped at five minutes', () => {
    expect(classifyModelFailure(api(429, '', { 'retry-after': '12' }), {}, now.getTime()).retryAfterMs).toBe(12_000);
    expect(retryAfterMs({ 'retry-after': new Date(now.getTime() + 90_000).toUTCString() }, now.getTime())).toBe(90_000);
    expect(retryAfterMs({ 'retry-after-ms': '1500' })).toBe(1500);
    expect(retryAfterMs({ 'retry-after': '3600' })).toBe(COOLING.rateLimit.max);
    expect(retryAfterMs({})).toBeNull();
  });

  it('never switches on the caller giving up; switches on its own per-attempt timer', () => {
    const abort = named('AbortError');
    expect(classifyModelFailure(abort, { callerAborted: true }).kind).toBe('aborted');
    expect(classifyModelFailure(abort, { timedOut: true }).kind).toBe('timeout');
    expect(switches(classifyModelFailure(api(400)))).toBe(false);
    expect(switches(classifyModelFailure(abort, { callerAborted: true }))).toBe(false);
    expect(switches(classifyModelFailure(api(429)))).toBe(true);
  });
});

describe('cooling', () => {
  it('cools quota for an hour, doubling to six', () => {
    let health: Health = HEALTHY;
    const periods: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const when = at(i * 60_000);
      health = afterFailure(health, fail('quota'), when);
      periods.push(health.coolingUntil!.getTime() - when.getTime());
    }
    expect(periods.slice(0, 3)).toEqual([COOLING.quota.base, COOLING.quota.base * 2, COOLING.quota.base * 4]);
    expect(Math.max(...periods)).toBe(COOLING.quota.max);
    expect(health.lastErrorCode).toBe('quota');
  });

  it('cools a rate limit by Retry-After, else 30 s doubling to five minutes', () => {
    expect(afterFailure(HEALTHY, fail('rate_limit', 12_000), now).coolingUntil).toEqual(at(12_000));
    const first = afterFailure(HEALTHY, fail('rate_limit'), now);
    expect(first.coolingUntil).toEqual(at(30_000));
    const second = afterFailure(first, fail('rate_limit'), at(31_000));
    expect(second.coolingUntil).toEqual(at(31_000 + 60_000));
  });

  it('cools server errors only on the second within a minute', () => {
    const first = afterFailure(HEALTHY, fail('server'), now);
    expect(first.state).toBe('ok');
    expect(first.consecutiveFailures).toBe(1);
    const second = afterFailure(first, fail('timeout'), at(20_000));
    expect(second.state).toBe('cooling');
    expect(second.coolingUntil).toEqual(at(20_000 + COOLING.transient.base));
    /* A minute and more apart: the streak starts over. */
    expect(afterFailure(first, fail('server'), at(61_000)).state).toBe('ok');
  });

  it('cools a bad key or a missing model for six hours', () => {
    expect(afterFailure(HEALTHY, fail('auth'), now).coolingUntil).toEqual(at(COOLING.config));
    expect(afterFailure(HEALTHY, fail('model_missing'), now).coolingUntil).toEqual(at(COOLING.config));
  });

  it('never shortens a longer cooldown', () => {
    const quota = afterFailure(HEALTHY, fail('quota'), now);
    const limited = afterFailure(quota, fail('rate_limit'), at(1000));
    expect(limited.coolingUntil).toEqual(quota.coolingUntil);
  });

  it('lets a request clear only what passes by itself, or what has run out', () => {
    const quota = afterFailure(HEALTHY, fail('quota'), now);
    expect(successClears(quota, at(1000), 'request')).toBe(false);
    expect(successClears(quota, at(COOLING.quota.base + 1), 'request')).toBe(true);
    expect(successClears(quota, at(1000), 'probe')).toBe(true);
    const limited = afterFailure(HEALTHY, fail('rate_limit'), now);
    expect(successClears(limited, at(1000), 'request')).toBe(true);
    expect(successClears(HEALTHY, now, 'request')).toBe(false);
    expect(successClears(afterFailure(HEALTHY, fail('server'), now), at(1000), 'request')).toBe(true);
  });
});

describe('attemptOrder', () => {
  const entries = ['a', 'b', 'c'].map((configId, position) => ({ configId, position, value: configId }));
  const cooling = (ms: number): Health => ({ ...HEALTHY, state: 'cooling', reason: 'quota', coolingUntil: at(ms) });

  it('tries by position, skipping cooling entries', () => {
    expect(attemptOrder(entries, new Map(), now).map((entry) => entry.value)).toEqual(['a', 'b', 'c']);
    expect(attemptOrder(entries, new Map([['a', cooling(60_000)]]), now).map((entry) => entry.value)).toEqual(['b', 'c']);
  });

  it('uses an entry again once its period is over (the primary first: traffic returns to it)', () => {
    const health = new Map([['a', cooling(60_000)]]);
    expect(isCooling(health.get('a'), at(60_001))).toBe(false);
    expect(attemptOrder(entries, health, at(60_001))[0]!.value).toBe('a');
  });

  it('with every entry cooling, still tries the two that recover soonest', () => {
    const health = new Map([['a', cooling(90_000)], ['b', cooling(30_000)], ['c', cooling(60_000)]]);
    expect(attemptOrder(entries, health, now).map((entry) => entry.value)).toEqual(['b', 'c']);
  });

  it('continues a Plan list with the Free entries it lacks', () => {
    const plan = [{ configId: 'p', position: 0, value: 'p' }, { configId: 'a', position: 1, value: 'a' }];
    expect(planWithFree(plan, entries).map((entry) => [entry.value, entry.position])).toEqual([['p', 0], ['a', 1], ['b', 3], ['c', 4]]);
  });
});

describe('embedding backups', () => {
  const vector = [0.1, 0.2, 0.3, 0.4];
  it('share a space only with the same model and the same vector', () => {
    expect(sameEmbeddingSpace({ model: 'openai/text-embedding-3-small', vector }, { model: 'text-embedding-3-small', vector: vector.map((v) => v * 1.000001) })).toBe(true);
    expect(sameEmbeddingSpace({ model: 'openai/text-embedding-3-small', vector }, { model: 'text-embedding-3-large', vector })).toBe(false);
    expect(sameEmbeddingSpace({ model: 'openai/text-embedding-3-small', vector }, { model: 'text-embedding-3-small', vector: [0.4, 0.3, 0.2, 0.1] })).toBe(false);
    expect(sameEmbeddingSpace({ model: 'openai/text-embedding-3-small', vector }, { model: 'text-embedding-3-small', vector: [...vector, 0] })).toBe(false);
  });
});
