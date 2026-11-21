/** The console's model page with lists (components/admin/model-chain.tsx): positions, health, banners and recent switches, in both languages. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/client';
import { messages } from '@/i18n';
import { ModelsBoard } from '@/components/admin/models-board';
import type { ChainBoard } from '@/components/admin/model-chain';
import type { ModelConfigView } from '@/lib/services/models';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => '/admin/models', useSearchParams: () => new URLSearchParams() }));

const config = (id: string, name: string, model: string, extra: Partial<ModelConfigView> = {}): ModelConfigView => ({
  id, name, kind: 'generation', transport: 'openai_compatible', baseUrl: 'https://provider.test/v1', model, apiKeyTail: '1234', hasKey: true,
  timeoutMs: 60_000, enabled: false, enabledPlan: false, embeddingSpace: null, lastProbeAt: null, lastProbeOk: null, updatedBy: null,
  updatedAt: new Date('2026-11-21T00:00:00Z'), costPricing: null, generationPricing: { source: 'unknown' }, ...extra,
});
const later = new Date(Date.now() + 3_600_000).toISOString();
const board = {
  configs: [
    config('a', 'Gateway default', 'gpt-5.1-mini', { enabled: true }),
    config('b', 'DeepSeek', 'deepseek-chat'),
    config('c', 'Qwen', 'qwen-plus'),
  ],
  fallbacks: { generation: { model: 'env-gen', transport: 'gateway' }, embedding: { model: 'env-embed', transport: 'gateway' }, transcription: { model: 'env-asr', transport: 'gateway' }, speech: { model: 'env-tts', transport: 'gateway' } },
  chains: {
    'generation:free': [{ configId: 'a', position: 0, active: true }, { configId: 'b', position: 1, active: true }, { configId: 'c', position: 2, active: false }],
    'generation:plan': [], embedding: [], transcription: [], speech: [],
  },
  health: { a: { state: 'cooling', reason: 'quota', coolingUntil: later, consecutiveFailures: 1, lastFailureAt: new Date().toISOString(), lastSuccessAt: null, lastErrorCode: 'quota:429' } },
  today: { a: { calls: 1284, failed: 37 }, b: { calls: 506, failed: 0 } },
  events: [{ id: 'e', configId: 'a', name: 'Gateway default', event: 'cooling', reason: 'quota', coolingUntil: later, createdAt: new Date().toISOString() }],
} satisfies ChainBoard;

const render = (locale: 'zh' | 'en') => renderToStaticMarkup(createElement(I18nProvider, { locale, t: messages(locale), children: createElement(ModelsBoard, { initial: board, initialJob: null }) }));

describe('model lists on the console', () => {
  it('shows the order, health, today’s calls, the banner and recent switches', () => {
    const html = render('zh');
    expect(html).toContain('主模型「Gateway default」冷却中（额度用完）');
    expect(html).toMatch(/model-chain-pos primary">主</);
    expect(html).toContain('备 1');
    expect(html).toContain('冷却中 · 额度用完');
    expect(html).toContain('今日 1,284 次 · 失败 37');
    expect(html).toContain('已停用');
    expect(html).toContain('解除冷却');
    expect(html).toContain('最近切换');
    expect(html).toContain('进入冷却 · 额度用完');
    /* An empty list says what answers instead. */
    expect(html).toContain('列表为空，使用环境变量：env-embed');
  });

  it('reads the same in English', () => {
    const html = render('en');
    expect(html).toContain('Backup 1');
    expect(html).toContain('Cooling down · out of quota');
    expect(html).toContain('Recent switches');
  });
});
