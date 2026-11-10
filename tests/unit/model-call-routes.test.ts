import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { GET } from '@/app/api/admin/model-calls/route';
import { GET as detail } from '@/app/api/admin/model-calls/[id]/route';
import { apiAdministrator } from '@/lib/http/admin';
import { recordExport } from '@/lib/services/admin';
import { CSV_MAX_ROWS } from '@/lib/http/admin-lists';
import { modelCallDetail, modelCallReport } from '@/lib/services/admin-model-calls';
vi.mock('@/lib/http/admin', () => ({ apiAdministrator: vi.fn() }));
vi.mock('@/lib/services/admin', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/services/admin')>()), recordExport: vi.fn() }));
vi.mock('@/lib/services/admin-model-calls', () => ({ modelCallDetail: vi.fn(), modelCallReport: vi.fn() }));
const request = (query = '') => new NextRequest(`https://console.test/api/admin/model-calls?${query}`);
const context = { params: Promise.resolve({ id: '00000000-0000-4000-8000-0000000000aa' }) };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiAdministrator).mockResolvedValue({ id: 'admin' } as Awaited<ReturnType<typeof apiAdministrator>>);
  vi.mocked(modelCallReport).mockResolvedValue({ items: [], models: [], summary: {}, total: 0, page: 1, size: 20 } as unknown as Awaited<ReturnType<typeof modelCallReport>>);
});
describe('generation call report access', () => {
  it('protects both reports and details with the shared administrator gate', async () => {
    vi.mocked(apiAdministrator).mockResolvedValue(new NextResponse(null, { status: 401 }));
    expect((await GET(request())).status).toBe(401);
    expect((await detail(request(), context)).status).toBe(401);
    expect(modelCallReport).not.toHaveBeenCalled(); expect(modelCallDetail).not.toHaveBeenCalled();
  });
  it('passes matching filters to JSON and full CSV exports', async () => {
    await GET(request('audience=plan&status=failed'));
    expect(modelCallReport).toHaveBeenLastCalledWith(expect.objectContaining({ audience: 'plan', status: 'failed' }), { all: false });
    const response = await GET(request('audience=plan&format=csv'));
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(modelCallReport).toHaveBeenLastCalledWith(expect.objectContaining({ audience: 'plan' }), { all: true });
    expect(await response.text()).toContain('Cost USD');
    expect(recordExport).toHaveBeenCalledWith('admin', 'model-calls', 0, { audience: 'plan' });
    /* Past the cap: refused after the count, never loaded in full. */
    vi.mocked(modelCallReport).mockClear();
    vi.mocked(modelCallReport).mockResolvedValue({ items: [], models: [], summary: {}, total: CSV_MAX_ROWS + 1, page: 1, size: 20 } as unknown as Awaited<ReturnType<typeof modelCallReport>>);
    expect((await GET(request('format=csv'))).status).toBe(413);
    expect(modelCallReport).not.toHaveBeenCalledWith(expect.anything(), { all: true });
  });
  it('returns 404 for missing details', async () => {
    vi.mocked(modelCallDetail).mockResolvedValue(null);
    expect((await detail(request(), context)).status).toBe(404);
    expect(modelCallDetail).toHaveBeenCalledWith('00000000-0000-4000-8000-0000000000aa');
    vi.mocked(modelCallDetail).mockClear();
    expect((await detail(request(), { params: Promise.resolve({ id: 'not-a-uuid' }) })).status).toBe(404);
    expect(modelCallDetail).not.toHaveBeenCalled();
  });
});
