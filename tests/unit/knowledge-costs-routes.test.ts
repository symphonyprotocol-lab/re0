import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { GET } from '@/app/api/admin/knowledge-costs/route';
import { GET as DETAIL } from '@/app/api/admin/knowledge-costs/[id]/route';
import { apiAdministrator } from '@/lib/http/admin';
import { recordExport } from '@/lib/services/admin';
import { CSV_MAX_ROWS } from '@/lib/http/admin-lists';
import { knowledgeCostDetail, knowledgeCostReport } from '@/lib/services/admin-knowledge-costs';
import { costUsd, knowledgeCostsView } from '@/lib/domain/knowledge-costs';
vi.mock('@/lib/http/admin', () => ({ apiAdministrator: vi.fn() }));
vi.mock('@/lib/services/admin', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/services/admin')>()), recordExport: vi.fn() }));
vi.mock('@/lib/services/admin-knowledge-costs', () => ({ knowledgeCostDetail: vi.fn(), knowledgeCostReport: vi.fn() }));
const req = (query = '') => new NextRequest(`https://example.test/api/admin/knowledge-costs${query}`);
beforeEach(() => vi.clearAllMocks());
describe('knowledge cost report access and exports', () => {
  it('rejects non-administrators before reading costs or exporting receipts', async () => {
    vi.mocked(apiAdministrator).mockResolvedValue(new NextResponse(null, { status: 401 }));
    expect((await GET(req('?format=csv'))).status).toBe(401);
    expect((await DETAIL(req(), { params: Promise.resolve({ id: 'id' }) })).status).toBe(401);
    expect(knowledgeCostReport).not.toHaveBeenCalled();
    expect(knowledgeCostDetail).not.toHaveBeenCalled();
  });
  it('exports all matching rows with exact USD and marks missing detail as 404', async () => {
    vi.mocked(apiAdministrator).mockResolvedValue({ id: 'admin' } as Awaited<ReturnType<typeof apiAdministrator>>);
    vi.mocked(knowledgeCostReport).mockResolvedValue({ items: [{ id: 'record', title: 'source', charges: [], knownCostUsd: '0.0004420000076293945', costUsd: null, createdAt: new Date('2026-01-01Z'), closedAt: null }], total: 1, page: 1, size: 20, summary: {}, providers: [] } as unknown as Awaited<ReturnType<typeof knowledgeCostReport>>);
    const response = await GET(req('?format=csv&status=failed&kind=audio&page=2'));
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(await response.text()).toContain('0.0004420000076293945');
    expect(knowledgeCostReport).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', kind: 'audio', page: 2 }), { all: true });
    expect(recordExport).toHaveBeenCalledWith('admin', 'knowledge-costs', 1, { status: 'failed', kind: 'audio', page: '2' });
    vi.mocked(knowledgeCostReport).mockClear();
    vi.mocked(knowledgeCostReport).mockResolvedValue({ items: [], total: CSV_MAX_ROWS + 1, page: 1, size: 20, summary: {}, providers: [] } as unknown as Awaited<ReturnType<typeof knowledgeCostReport>>);
    expect((await GET(req('?format=csv'))).status).toBe(413);
    expect(knowledgeCostReport).not.toHaveBeenCalledWith(expect.anything(), { all: true });
    vi.mocked(knowledgeCostDetail).mockResolvedValue(null);
    expect((await DETAIL(req(), { params: Promise.resolve({ id: 'missing' }) })).status).toBe(404);
  });
  it('normalizes invalid filters and displays tiny exact costs without a false zero', () => {
    expect(knowledgeCostsView({ status: 'bogus', kind: 'bogus', size: '9999', page: '-1', sort: 'bogus' })).toMatchObject({ status: 'all', kind: 'all', size: 20, page: 1, sort: 'newest' });
    expect(costUsd('0.000000000000000001')).toBe('$0.000000000000000001');
    expect(costUsd('0.0004420000076293945')).toBe('$0.0004420000076293945');
    expect(costUsd('0.000000000000')).toBe('$0');
    expect(costUsd(null)).toBe('—');
  });
});
