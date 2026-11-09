import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ADMIN_SESSION_COOKIE } from '@/lib/http/cookies';
import { GET, PUT } from '@/app/api/admin/pricing/route';
import { currentPricing, savePricing } from '@/lib/services/pricing';
import { welcomeCredits, saveWelcomeCredits } from '@/lib/services/signup-reward';
import { videoExportPrice, saveVideoExportPrice, videoScriptPrice, saveVideoScriptPrice } from '@/lib/services/video-pricing';
import { AdminInputError, resolveAdminSession } from '@/lib/services/admin';
import { infraCostRates, saveInfraCostRates } from '@/lib/services/infra-pricing';
import { defaultInfraCostRates } from '@/lib/domain/infra-cost';
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
vi.mock('@/lib/services/infra-pricing', () => ({ infraCostRates: vi.fn(), saveInfraCostRates: vi.fn() }));
vi.mock('@/lib/services/video-pricing', () => ({
  videoScriptPrice: vi.fn(), saveVideoScriptPrice: vi.fn(), videoExportPrice: vi.fn(), saveVideoExportPrice: vi.fn(),
}));
function request(method: string, origin = 'https://console.example.test', input = { kind: 'welcome', credits: 25000, revision: 'default' }) {
  return new NextRequest('https://console.example.test/api/admin/pricing', {
    method,
    headers: { origin, 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(input) }),
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
  it('reads the pricing settings and saves welcome credits without contacting Paddle', async () => {
    state.admin = true;
    const welcome = { credits: 25000, revision: 'updated' };
    vi.mocked(currentPricing).mockResolvedValue({ plan: defaultPrice('plan'), pack: defaultPrice('pack') });
    vi.mocked(welcomeCredits).mockResolvedValue(welcome);
    const videoScript = { credits: 5, revision: 'default' };
    const videoExport = { credits: 50, revision: 'default' };
    vi.mocked(videoScriptPrice).mockResolvedValue(videoScript);
    vi.mocked(videoExportPrice).mockResolvedValue(videoExport);
    vi.mocked(infraCostRates).mockResolvedValue(defaultInfraCostRates());
    expect(await (await GET(request('GET'))).json()).toMatchObject({
      plan: { priceMinor: 1000, credits: 50_000 }, pack: { priceMinor: 1000, credits: 100_000 }, welcome, videoScript, videoExport,
      infraCosts: { transferPerGb: '0.15', blobStoragePerGbMonth: '0.028', databaseStoragePerGbMonth: '0.55', databaseIndexFactor: '2', chunkRowBytes: 200, revision: 'default' },
    });
    vi.mocked(saveWelcomeCredits).mockResolvedValue(welcome);
    expect(await (await PUT(request('PUT'))).json()).toEqual({ welcome });
    expect(saveWelcomeCredits).toHaveBeenCalledWith('admin-id', { kind: 'welcome', credits: 25000, revision: 'default' });
    expect(savePricing).not.toHaveBeenCalled();
  });
  it('saves video script pricing through the authenticated pricing API', async () => {
    const input = { kind: 'video_script', credits: 8, revision: 'default' };
    expect((await PUT(request('PUT', undefined, input))).status).toBe(401);
    state.admin = true;
    expect((await PUT(request('PUT', 'https://attacker.test', input))).status).toBe(403);
    expect(saveVideoScriptPrice).not.toHaveBeenCalled();
    const videoScript = { credits: 8, revision: 'updated' };
    vi.mocked(saveVideoScriptPrice).mockResolvedValue(videoScript);
    expect(await (await PUT(request('PUT', undefined, input))).json()).toEqual({ videoScript });
    expect(saveVideoScriptPrice).toHaveBeenCalledWith('admin-id', input);
    expect(savePricing).not.toHaveBeenCalled();
  });
  it('reports stale and invalid welcome changes as 409 and 422', async () => {
    state.admin = true;
    vi.mocked(saveWelcomeCredits).mockRejectedValue(new AdminInputError('pricing_conflict'));
    expect((await PUT(request('PUT'))).status).toBe(409);
    vi.mocked(saveWelcomeCredits).mockRejectedValue(new AdminInputError('invalid_welcome_credits'));
    expect((await PUT(request('PUT'))).status).toBe(422);
  });
  it('saves video export pricing independently of script pricing and Paddle', async () => {
    const input = { kind: 'video_export', credits: 65, revision: 'default' };
    expect((await PUT(request('PUT', undefined, input))).status).toBe(401);
    state.admin = true;
    expect((await PUT(request('PUT', 'https://attacker.test', input))).status).toBe(403);
    expect(saveVideoExportPrice).not.toHaveBeenCalled();
    const videoExport = { credits: 65, revision: 'updated' };
    vi.mocked(saveVideoExportPrice).mockResolvedValue(videoExport);
    expect(await (await PUT(request('PUT', undefined, input))).json()).toEqual({ videoExport });
    expect(saveVideoExportPrice).toHaveBeenCalledWith('admin-id', input);
    expect(saveVideoScriptPrice).not.toHaveBeenCalled();
    expect(savePricing).not.toHaveBeenCalled();
  });
  it('saves infrastructure costs through the authenticated pricing API, and reports invalid rates as 422', async () => {
    const input = { kind: 'infra_costs', revision: 'default', transferPerGb: '0.2', blobStoragePerGbMonth: '0.03', databaseStoragePerGbMonth: '0.6', databaseIndexFactor: '2', chunkRowBytes: 200 };
    expect((await PUT(request('PUT', undefined, input as never))).status).toBe(401);
    state.admin = true;
    expect((await PUT(request('PUT', 'https://attacker.test', input as never))).status).toBe(403);
    expect(saveInfraCostRates).not.toHaveBeenCalled();
    const infraCosts = { ...input, revision: 'next', effectiveFrom: new Date().toISOString() };
    vi.mocked(saveInfraCostRates).mockResolvedValue(infraCosts as never);
    expect(await (await PUT(request('PUT', undefined, input as never))).json()).toEqual({ infraCosts });
    expect(saveInfraCostRates).toHaveBeenCalledWith('admin-id', input);
    vi.mocked(saveInfraCostRates).mockRejectedValue(new AdminInputError('invalid_infra_costs'));
    const refused = await PUT(request('PUT', undefined, { ...input, transferPerGb: '0' } as never));
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ error: 'invalid_infra_costs' });
    expect(savePricing).not.toHaveBeenCalled();
  });
});
