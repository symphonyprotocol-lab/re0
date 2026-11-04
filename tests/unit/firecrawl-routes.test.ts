import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ADMIN_SESSION_COOKIE } from '@/lib/http/cookies';
import { GET, POST } from '@/app/api/admin/firecrawl/keys/route';
import { PUT, DELETE } from '@/app/api/admin/firecrawl/keys/[id]/route';
import { PUT as PUT_PRICING } from '@/app/api/admin/firecrawl/pricing/route';
import { listFirecrawlKeys, saveFirecrawlKey, deleteFirecrawlKey, saveFirecrawlDefaultPricing } from '@/lib/services/firecrawl-keys';
import { AdminInputError, resolveAdminSession } from '@/lib/services/admin';

const state = vi.hoisted(() => ({ adminCookie: false }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => state.adminCookie && name === ADMIN_SESSION_COOKIE ? { value: 'administrator-token' } : undefined }),
  headers: async () => new Headers(),
}));
vi.mock('@/lib/services/admin', async (original) => ({ ...await original<typeof import('@/lib/services/admin')>(), resolveAdminSession: vi.fn() }));
vi.mock('@/lib/services/firecrawl-keys', () => ({ listFirecrawlKeys: vi.fn(), saveFirecrawlKey: vi.fn(), deleteFirecrawlKey: vi.fn(), saveFirecrawlDefaultPricing: vi.fn() }));

const id = 'b025ebd8-16e3-4b2a-9178-7e68263a43fb';
const context = { params: Promise.resolve({ id }) };
function request(method: string, origin = 'https://console.example.test') {
  return new NextRequest('https://console.example.test/api/admin/firecrawl/keys', {
    method, headers: { origin, 'content-type': 'application/json' },
    ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify({ name: 'Primary', apiKey: 'fc-secret', enabled: true }) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks(); state.adminCookie = false;
  vi.stubEnv('APP_BASE_URL', 'https://console.example.test');
  vi.mocked(resolveAdminSession).mockImplementation(async (token) => token ? { id: 'admin' } as Awaited<ReturnType<typeof resolveAdminSession>> : null);
});
afterEach(() => vi.unstubAllEnvs());

describe('Firecrawl administrator API authority', () => {
  it('requires a separate administrator session for every operation', async () => {
    const responses = await Promise.all([GET(request('GET')), POST(request('POST')), PUT(request('PUT'), context), DELETE(request('DELETE'), context), PUT_PRICING(request('PUT'))]);
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401]);
    expect(saveFirecrawlDefaultPricing).not.toHaveBeenCalled();
    expect(listFirecrawlKeys).not.toHaveBeenCalled(); expect(saveFirecrawlKey).not.toHaveBeenCalled(); expect(deleteFirecrawlKey).not.toHaveBeenCalled();
  });

  it('rejects writes from another origin even with an administrator session', async () => {
    state.adminCookie = true;
    const responses = await Promise.all([POST(request('POST', 'https://attacker.test')), PUT(request('PUT', 'https://attacker.test'), context), DELETE(request('DELETE', 'https://attacker.test'), context), PUT_PRICING(request('PUT', 'https://attacker.test'))]);
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403]);
    expect(saveFirecrawlDefaultPricing).not.toHaveBeenCalled();
    expect(saveFirecrawlKey).not.toHaveBeenCalled(); expect(deleteFirecrawlKey).not.toHaveBeenCalled();
  });

  it('returns safe service views and makes writes attributable to the signed-in administrator', async () => {
    state.adminCookie = true;
    vi.mocked(listFirecrawlKeys).mockResolvedValue({ keys: [], defaultPricing: null, baseUrl: 'https://api.firecrawl.dev', environmentConfigured: false });
    expect((await GET(request('GET'))).status).toBe(200);
    vi.mocked(saveFirecrawlKey).mockResolvedValue({ id, name: 'Primary', apiKeyTail: 'cret' } as Awaited<ReturnType<typeof saveFirecrawlKey>>);
    expect((await POST(request('POST'))).status).toBe(201);
    expect(saveFirecrawlKey).toHaveBeenLastCalledWith('admin', null, { name: 'Primary', apiKey: 'fc-secret', enabled: true });
    expect((await PUT(request('PUT'), context)).status).toBe(200);
    expect(saveFirecrawlKey).toHaveBeenLastCalledWith('admin', id, { name: 'Primary', apiKey: 'fc-secret', enabled: true });
    expect((await DELETE(request('DELETE'), context)).status).toBe(200);
    expect(deleteFirecrawlKey).toHaveBeenLastCalledWith('admin', id);
  });

  it('maps duplicate and missing records to 409 and 404', async () => {
    state.adminCookie = true;
    vi.mocked(saveFirecrawlKey).mockRejectedValue(new AdminInputError('duplicate'));
    expect((await POST(request('POST'))).status).toBe(409);
    vi.mocked(saveFirecrawlKey).mockRejectedValue(new AdminInputError('not_found'));
    expect((await PUT(request('PUT'), context)).status).toBe(404);
  });
});
