import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { GET, PUT } from '@/app/api/admin/provider-pricing/route';
import { apiAdministrator } from '@/lib/http/admin';
import { providerPrices, saveProviderPrices } from '@/lib/services/provider-pricing';
import { AdminInputError } from '@/lib/services/admin';

vi.mock('@/lib/http/admin', () => ({ apiAdministrator: vi.fn() }));
vi.mock('@/lib/services/provider-pricing', () => ({ providerPrices: vi.fn(), saveProviderPrices: vi.fn(), providerPricingMigrationMissing: () => false }));
const request = () => new NextRequest('https://console.example.test/api/admin/provider-pricing', { method: 'PUT', body: JSON.stringify({ revision: 'r', rates: [] }), headers: { 'content-type': 'application/json' } });
beforeEach(() => { vi.clearAllMocks(); });
describe('supplier pricing access checks', () => {
  it('requires an administrator for reads and updates', async () => {
    vi.mocked(apiAdministrator).mockResolvedValue(new NextResponse(null, { status: 401 }));
    expect((await GET(request())).status).toBe(401);
    expect((await PUT(request())).status).toBe(401);
    expect(providerPrices).not.toHaveBeenCalled();
    expect(saveProviderPrices).not.toHaveBeenCalled();
  });
  it('saves only after the shared administrator and origin gate, and reports revision conflicts', async () => {
    vi.mocked(apiAdministrator).mockResolvedValue({ id: 'admin' } as Awaited<ReturnType<typeof apiAdministrator>>);
    vi.mocked(saveProviderPrices).mockResolvedValue({ revision: 'next', rates: [] });
    expect(await (await PUT(request())).json()).toEqual({ revision: 'next', rates: [] });
    expect(saveProviderPrices).toHaveBeenCalledWith('admin', { revision: 'r', rates: [] });
    vi.mocked(saveProviderPrices).mockRejectedValue(new AdminInputError('pricing_conflict'));
    expect((await PUT(request())).status).toBe(409);
    vi.mocked(saveProviderPrices).mockRejectedValue(new AdminInputError('invalid_provider_pricing'));
    expect((await PUT(request())).status).toBe(422);
  });
});
