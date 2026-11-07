import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/http/cookies';
import { VISITOR_COOKIE } from '@/lib/http/share';
import { POST as VISIT } from '@/app/api/share/[slug]/visit/route';
import { POST as CONVERSION } from '@/app/api/share/[slug]/conversion/route';
import { recordShareConversion, recordShareVisit } from '@/lib/services/share';
import { resolveSession } from '@/lib/services/auth';

const state = vi.hoisted(() => ({ signedIn: false }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (state.signedIn && name === SESSION_COOKIE ? { value: 'session-token' } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock('@/lib/services/auth', async (original) => ({ ...(await original<typeof import('@/lib/services/auth')>()), resolveSession: vi.fn() }));
vi.mock('@/lib/services/share', async (original) => ({ ...(await original<typeof import('@/lib/services/share')>()), recordShareVisit: vi.fn(), recordShareConversion: vi.fn() }));

const ORIGIN = 'http://localhost:3000';
const visitorId = '6f1c3a52-6c55-4a8e-9d0e-2f6ad0c1a111';
const conversationId = '0c8f4f43-1f0a-4cf5-9f44-8a4c7bd5e222';
const context = { params: Promise.resolve({ slug: 'ree-abc' }) };

function request(path: string, options: { origin?: string | null; visitor?: string | null; body?: unknown } = {}) {
  const headers = new Headers({ 'content-type': 'application/json', 'x-real-ip': '203.0.113.9' });
  if (options.origin !== null) headers.set('origin', options.origin ?? ORIGIN);
  if (options.visitor) headers.set('cookie', `${VISITOR_COOKIE}=${options.visitor}`);
  return new NextRequest(`${ORIGIN}${path}`, { method: 'POST', headers, body: JSON.stringify(options.body ?? {}) });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.signedIn = false;
  vi.mocked(resolveSession).mockImplementation(async (token) => (token ? ({ id: 'user-1' } as Awaited<ReturnType<typeof resolveSession>>) : null));
});

describe('share visit beacon', () => {
  it('rejects another origin before touching the count', async () => {
    const response = await VISIT(request('/api/share/ree-abc/visit', { origin: 'https://attacker.test' }), context);
    expect(response.status).toBe(403);
    expect(recordShareVisit).not.toHaveBeenCalled();
  });

  it('gives a browser without a visitor cookie one, marked fresh', async () => {
    vi.mocked(recordShareVisit).mockResolvedValue('cookie');
    const response = await VISIT(request('/api/share/ree-abc/visit'), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: 'cookie' });
    const set = response.cookies.get(VISITOR_COOKIE);
    expect(set?.value).toMatch(/^[0-9a-f-]{36}$/);
    expect(set?.httpOnly).toBe(true);
    expect(recordShareVisit).toHaveBeenCalledWith(expect.objectContaining({ slug: 'ree-abc', visitorId: set?.value, freshVisitor: true, userId: null, ip: '203.0.113.9' }));
  });

  it('reuses the visitor cookie and passes the signed-in user', async () => {
    state.signedIn = true;
    vi.mocked(recordShareVisit).mockResolvedValue('recorded');
    const response = await VISIT(request('/api/share/ree-abc/visit', { visitor: visitorId }), context);
    expect(response.status).toBe(200);
    expect(response.cookies.get(VISITOR_COOKIE)).toBeUndefined();
    expect(recordShareVisit).toHaveBeenCalledWith(expect.objectContaining({ visitorId, freshVisitor: false, userId: 'user-1' }));
  });

  it('answers 404 for a private Ree and 429 past the limit', async () => {
    vi.mocked(recordShareVisit).mockResolvedValueOnce('not_found').mockResolvedValueOnce('limited');
    expect((await VISIT(request('/api/share/ree-abc/visit', { visitor: visitorId }), context)).status).toBe(404);
    expect((await VISIT(request('/api/share/ree-abc/visit', { visitor: visitorId }), context)).status).toBe(429);
  });
});

describe('share conversion', () => {
  it('needs a signed-in user from this origin', async () => {
    expect((await CONVERSION(request('/api/share/ree-abc/conversion', { visitor: visitorId, body: { conversationId } }), context)).status).toBe(401);
    state.signedIn = true;
    expect((await CONVERSION(request('/api/share/ree-abc/conversion', { origin: 'https://attacker.test', visitor: visitorId, body: { conversationId } }), context)).status).toBe(403);
    expect(recordShareConversion).not.toHaveBeenCalled();
  });

  it('attributes nothing to a browser without a visitor cookie', async () => {
    state.signedIn = true;
    const response = await CONVERSION(request('/api/share/ree-abc/conversion', { body: { conversationId } }), context);
    expect(await response.json()).toEqual({ result: 'unattributed' });
    expect(response.cookies.get(VISITOR_COOKIE)).toBeUndefined();
    expect(recordShareConversion).not.toHaveBeenCalled();
  });

  it('passes the visitor, the user and the conversation', async () => {
    state.signedIn = true;
    vi.mocked(recordShareConversion).mockResolvedValueOnce('recorded').mockResolvedValueOnce('not_found');
    const response = await CONVERSION(request('/api/share/ree-abc/conversion', { visitor: visitorId, body: { conversationId } }), context);
    expect(await response.json()).toEqual({ result: 'recorded' });
    expect(recordShareConversion).toHaveBeenCalledWith({ slug: 'ree-abc', visitorId, userId: 'user-1', conversationId });
    expect((await CONVERSION(request('/api/share/ree-abc/conversion', { visitor: visitorId, body: { conversationId } }), context)).status).toBe(404);
  });
});
