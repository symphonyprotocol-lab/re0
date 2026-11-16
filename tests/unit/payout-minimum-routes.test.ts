import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ADMIN_SESSION_COOKIE } from '@/lib/http/cookies';
import * as site from '@/app/api/admin/payout-settings/route';
import * as user from '@/app/api/admin/users/[id]/payout-minimum/route';
import { saveSitePayoutMinimum, setUserPayoutMinimum, sitePayoutMinimum } from '@/lib/services/payout-minimum';
import { AdminInputError, resolveAdminSession } from '@/lib/services/admin';

const state = vi.hoisted(() => ({ admin: false }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (state.admin && name === ADMIN_SESSION_COOKIE ? { value: 'admin' } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock('@/lib/services/admin', async (original) => ({
  ...(await original<typeof import('@/lib/services/admin')>()),
  resolveAdminSession: vi.fn(),
}));
vi.mock('@/lib/services/payout-minimum', () => ({ sitePayoutMinimum: vi.fn(), saveSitePayoutMinimum: vi.fn(), setUserPayoutMinimum: vi.fn() }));

const USER = '6f9b0c1e-2d3a-4b5c-8d7e-0f1a2b3c4d5e';
function request(path: string, method: string, input: unknown = {}, origin = 'https://console.example.test') {
  return new NextRequest(`https://console.example.test${path}`, {
    method,
    headers: { origin, 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(input) }),
  });
}
const userContext = { params: Promise.resolve({ id: USER }) };

beforeEach(() => {
  vi.clearAllMocks();
  state.admin = false;
  vi.stubEnv('APP_BASE_URL', 'https://console.example.test');
  vi.mocked(resolveAdminSession).mockImplementation(async (token) => (token ? ({ id: 'admin-id' } as Awaited<ReturnType<typeof resolveAdminSession>>) : null));
});
afterEach(() => vi.unstubAllEnvs());

describe('payout minimum administrator API', () => {
  it('requires an administrator session, and refuses cross-origin writes', async () => {
    expect((await site.GET(request('/api/admin/payout-settings', 'GET'))).status).toBe(401);
    expect((await site.PUT(request('/api/admin/payout-settings', 'PUT', { credits: 1, revision: 'default' }))).status).toBe(401);
    expect((await user.PUT(request(`/api/admin/users/${USER}/payout-minimum`, 'PUT', { credits: 1 }), userContext)).status).toBe(401);
    state.admin = true;
    expect((await site.PUT(request('/api/admin/payout-settings', 'PUT', { credits: 1, revision: 'default' }, 'https://attacker.test'))).status).toBe(403);
    expect((await user.PUT(request(`/api/admin/users/${USER}/payout-minimum`, 'PUT', { credits: 1 }, 'https://attacker.test'), userContext)).status).toBe(403);
    expect(saveSitePayoutMinimum).not.toHaveBeenCalled();
    expect(setUserPayoutMinimum).not.toHaveBeenCalled();
  });

  it('reads and saves for an administrator, mapping conflicts and bad input', async () => {
    state.admin = true;
    vi.mocked(sitePayoutMinimum).mockResolvedValue({ credits: 500_000, revision: 'default' });
    expect(await (await site.GET(request('/api/admin/payout-settings', 'GET'))).json()).toEqual({ minimum: { credits: 500_000, revision: 'default' } });
    vi.mocked(saveSitePayoutMinimum).mockResolvedValue({ credits: 300_000, revision: 'r2' });
    const saved = await site.PUT(request('/api/admin/payout-settings', 'PUT', { credits: 300_000, revision: 'default' }));
    expect(await saved.json()).toEqual({ minimum: { credits: 300_000, revision: 'r2' } });
    expect(saveSitePayoutMinimum).toHaveBeenCalledWith('admin-id', { credits: 300_000, revision: 'default' });
    vi.mocked(saveSitePayoutMinimum).mockRejectedValueOnce(new AdminInputError('pricing_conflict'));
    expect((await site.PUT(request('/api/admin/payout-settings', 'PUT', { credits: 1, revision: 'old' }))).status).toBe(409);
    vi.mocked(saveSitePayoutMinimum).mockRejectedValueOnce(new AdminInputError('invalid_payout_minimum'));
    expect((await site.PUT(request('/api/admin/payout-settings', 'PUT', { credits: 0, revision: 'r2' }))).status).toBe(422);

    vi.mocked(setUserPayoutMinimum).mockResolvedValue({ credits: null });
    const cleared = await user.PUT(request(`/api/admin/users/${USER}/payout-minimum`, 'PUT', { credits: null }), userContext);
    expect(await cleared.json()).toEqual({ credits: null });
    expect(setUserPayoutMinimum).toHaveBeenCalledWith('admin-id', USER, { credits: null });
  });
});
