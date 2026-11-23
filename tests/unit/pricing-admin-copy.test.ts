import { describe, expect, it } from 'vitest';
import { messages } from '@/i18n';

/*
 * The console's Pricing & promotions page (`/admin/pricing`, components/admin/pricing-board.tsx)
 * renders, in order: welcome credits, the video script and export prices, infrastructure costs,
 * Earned conversion and deductions, then Plan and Pack. Its description names each of them.
 */
describe('pricing console copy', () => {
  it('describes every settings form the page renders, Earned included', () => {
    const zh = messages('zh').pricingAdmin;
    const en = messages('en').pricingAdmin;
    for (const part of ['注册赠送', '视频脚本', '基础设施成本', '收入（Earned）', 'Plan 和 Pack']) expect(zh.description).toContain(part);
    for (const part of ['welcome credits', 'video script', 'infrastructure costs', 'Earned credits', 'Plan and Pack']) expect(en.description).toContain(part);
  });
});
