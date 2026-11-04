import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Page from '@/app/admin/(console)/model-calls/page';
import Detail from '@/app/admin/(console)/model-calls/[id]/page';
import { modelCallDetail, modelCallReport, type ModelCallDetail } from '@/lib/services/admin-model-calls';
import { I18nProvider } from '@/i18n/client';
import { messages } from '@/i18n';
import { providerRateSchema } from '@/lib/domain/provider-cost';

vi.mock('@/lib/http/admin', () => ({ requireAdministrator: vi.fn().mockResolvedValue({ id: 'admin' }) }));
vi.mock('@/lib/services/admin-model-calls', () => ({ modelCallDetail: vi.fn(), modelCallReport: vi.fn() }));
vi.mock('@/i18n/server', async () => ({ serverMessages: async () => ({ t: (await import('@/i18n')).messages('zh'), locale: 'zh' }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => '/admin/model-calls', useSearchParams: () => new URLSearchParams(), redirect: vi.fn(), notFound: () => { throw new Error('not_found'); } }));
const rate = providerRateSchema.parse({ service: 'generation', endpoint: 'https://provider.test/v1', model: 'test', unit: 'tokens', usdPerUnit: '0.000001', outputUsdPerUnit: '0.000002', source: 'Contract v1' });
const row: ModelCallDetail = { id: 'call-1', kind: 'generation', model: 'test', configId: null, configName: 'Plan config', userId: null, userName: null, userEmail: null, audience: 'plan', purpose: 'answer', status: 'succeeded', durationMs: 100, inputTokens: 100, outputTokens: 50, seconds: 0, usageKnown: true, endpoint: rate.endpoint, requestId: 'req-1', errorCode: null, costUsd: '0.0004420000076293945', costBasis: 'provider_reported', rate, priceRevision: 'v1', createdAt: new Date('2026-11-03T00:00:00Z') };
const summary = { calls: 1, succeeded: 1, failed: 0, aborted: 0, unknown: 0, inputTokens: 100, outputTokens: 50, averageMs: 100, knownCostUsd: row.costUsd!, estimatedCostUsd: '0', unpriced: 0 };
const render = (page: Awaited<ReturnType<typeof Page>>) => renderToStaticMarkup(createElement(I18nProvider, { locale: 'zh', t: messages('zh'), children: page }));
beforeEach(() => {
  vi.mocked(modelCallReport).mockResolvedValue({ items: [row], models: [{ ...summary, model: 'test', endpoint: rate.endpoint, audience: 'plan' }], summary, total: 1, page: 1, size: 20 });
  vi.mocked(modelCallDetail).mockResolvedValue(row);
});
describe('generation call report pages', () => {
  it('renders summaries, group filters, exact per-call cost and detail links', async () => {
    const html = render(await Page({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('生成模型调用'); expect(html).toContain('按模型与用户组汇总');
    expect(html).toContain('$0.0004420000076293945'); expect(html).toContain('供应商实际费用');
    expect(html).toContain('/admin/model-calls/call-1'); expect(html).toContain('name="audience"');
    expect(html).toContain('导出筛选结果');
  });
  it('renders snapshotted input/output unit prices alongside the actual bill', async () => {
    const html = render(await Detail({ params: Promise.resolve({ id: 'call-1' }), searchParams: Promise.resolve({}) }));
    expect(html).toContain('$0.0004420000076293945'); expect(html).toContain('$0.000001'); expect(html).toContain('$0.000002');
    expect(html).toContain('Contract v1'); expect(html).toContain('req-1'); expect(html).toContain('Plan 用户');
  });
  it('explains missing historical call prices instead of showing a blank price', async () => {
    const historical = { ...row, status: 'unknown' as const, costUsd: null, costBasis: 'unresolved' as const };
    vi.mocked(modelCallReport).mockResolvedValue({ items: [historical], models: [], summary: { ...summary, unpriced: 1 }, total: 1, page: 1, size: 20 });
    const html = render(await Page({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('费用未知');
    expect(html).toContain('历史记录未保存费用');
  });
  it('labels backfilled costs as estimates using prices at backfill time', async () => {
    const historical = { ...row, costBasis: 'estimated' as const, priceRevision: 'backfill:2026-11-03T00:00:00Z:v1' };
    vi.mocked(modelCallReport).mockResolvedValue({ items: [historical], models: [], summary, total: 1, page: 1, size: 20 });
    vi.mocked(modelCallDetail).mockResolvedValue(historical);
    expect(render(await Page({ searchParams: Promise.resolve({}) }))).toContain('按当前单价补算（估算）');
    expect(render(await Detail({ params: Promise.resolve({ id: 'call-1' }), searchParams: Promise.resolve({}) }))).toContain('并非历史实际扣费');
  });
});
