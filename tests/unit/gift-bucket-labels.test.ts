import { describe, expect, it } from 'vitest';
import { messages } from '@/i18n';
import { LOCALES } from '@/i18n/locale';

/*
 * The `welcome` grant bucket holds every gift: the sign-up gift, starter
 * tasks, daily check-ins and invitation rewards past the withdrawable limits.
 * Every label that names the bucket says so (or is plainly "gift"), in every
 * language, so none reads as sign-up credits only.
 */
describe('gift bucket labels', () => {
  it('name everything the bucket holds wherever they describe its contents', () => {
    for (const locale of LOCALES) {
      const t = messages(locale);
      const contents = [t.consoleUsers.detail.summary.welcome, t.consolePayouts.funding.sources.welcome, t.billing.total.welcome.note];
      const checkIns = locale === 'zh' ? '打卡' : 'check-ins';
      const invitations = locale === 'zh' ? '邀请奖励' : 'invitation rewards';
      for (const label of contents) {
        expect(label).toContain(checkIns);
        expect(label).toContain(invitations);
      }
      expect(t.billing.sources.welcome).toBe(locale === 'zh' ? '赠送' : 'Gift');
      expect(t.billing.total.welcome.label).toBe(locale === 'zh' ? '赠送' : 'Gift');
    }
  });
});
