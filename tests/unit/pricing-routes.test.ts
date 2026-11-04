import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ADMIN_SESSION_COOKIE } from '@/lib/http/cookies';
import { GET, PUT } from '@/app/api/admin/pricing/route';
import { currentPricing, savePricing } from '@/lib/services/pricing';
import { welcomeCredits, saveWelcomeCredits } from '@/lib/services/signup-reward';
import { AdminInputError, resolveAdminSession } from '@/lib/services/admin';
import { defaultPrice } from '@/lib/domain/pricing';
const state = vi.hoisted(() => ({ admin: false }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (state.admin && name === ADMIN_SESSION_COOKIE ? { value: 'admin' } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock('@/lib/services/admin', async (original) => ({
  ...(await original<typeof import('@/lib/services/admin')>()),
  resolveAdminSession: vi.fn(),
}));
vi.mock('@/lib/services/pricing', () => ({ currentPricing: vi.fn(), savePricing: vi.fn() }));
vi.mock('@/lib/services/signup-reward', () => ({ welcomeCredits: vi.fn(), saveWelcomeCredits: vi.fn() }));
function request(method: string, origin = 'https://console.example.test') {
  return new NextRequest('https://console.example.test/api/admin/pricing', {
    method,
    headers: { origin, 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify({ kind: 'welcome', credits: 25000, revision: 'default' }) }),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  state.admin = false;
  vi.stubEnv('APP_BASE_URL', 'https://console.example.test');
  vi.mocked(resolveAdminSession).mockImplementation(async (token) =>
    token ? ({ id: 'admin-id' } as Awaited<ReturnType<typeof resolveAdminSession>>) : null,
  );
});
afterEach(() => vi.unstubAllEnvs());
describe('unified pricing administrator API', () => {
  it('requires an administrator session for reads and writes', async () => {
    expect((await GET(request('GET'))).status).toBe(401);
    expect((await PUT(request('PUT'))).status).toBe(401);
    expect(saveWelcomeCredits).not.toHaveBeenCalled();
  });
  it('rejects cross-origin changes', async () => {
    state.admin = true;
    expect((await PUT(request('PUT', 'https://attacker.test'))).status).toBe(403);
    expect(saveWelcomeCredits).not.toHaveBeenCalled();
  });
  it('reads all three settings and saves welcome credits without contacting Paddle', async () => {
    state.admin = true;
    const welcome = { credits: 25000, revision: 'updated' };
    vi.mocked(currentPricing).mockResolvedValue({ plan: defaultPrice('plan'), pack: defaultPrice('pack') });
    vi.mocked(welcomeCredits).mockResolvedValue(welcome);
    expect(await (await GET(request('GET'))).json()).toMatchObject({ plan: { priceMinor: 1000 }, pack: { priceMinor: 1000 }, welcome });
    vi.mocked(saveWelcomeCredits).mockResolvedValue(welcome);
    expect(await (await PUT(request('PUT'))).json()).toEqual({ welcome });
    expect(saveWelcomeCredits).toHaveBeenCalledWith('admin-id', { kind: 'welcome', credits: 25000, revision: 'default' });
    expect(savePricing).not.toHaveBeenCalled();
  });
  it('reports stale and invalid welcome changes as 409 and 422', async () => {
    state.admin = true;
    vi.mocked(saveWelcomeCredits).mockRejectedValue(new AdminInputError('pricing_conflict'));
    expect((await PUT(request('PUT'))).status).toBe(409);
    vi.mocked(saveWelcomeCredits).mockRejectedValue(new AdminInputError('invalid_welcome_credits'));
    expect((await PUT(request('PUT'))).status).toBe(422);
  });
});
