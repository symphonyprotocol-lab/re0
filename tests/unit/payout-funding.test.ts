import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { identityKey, summarizeFunding, type FundingPayerRow } from '@/lib/domain/payout-funding';
import { FundingSummaryLine, PayoutFundingCards } from '@/components/admin/payout-funding';
import { I18nProvider } from '@/i18n/client';
import { messages } from '@/i18n';
import { LOCALES } from '@/i18n/locale';
import { fill } from '@/i18n/format';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => '/admin/payouts', useSearchParams: () => new URLSearchParams() }));

const DAY = 86_400_000;
const now = new Date('2026-11-10T00:00:00Z');
const payer = (id: string, credits: number, extra: Partial<FundingPayerRow> = {}): FundingPayerRow => ({
  userId: id,
  name: `Asker ${id}`,
  email: `${id}@example.test`,
  paypalEmail: null,
  createdAt: new Date(now.getTime() - 200 * DAY),
  disabled: false,
  credits,
  questions: 2,
  maxFeeQuestions: 0,
  firstAskedAt: new Date(now.getTime() - 10 * DAY),
  activeElsewhere: true,
  ...extra,
});
const sources = { invite: 0, paid: 1_000, welcome: 0, redeemed: 0, console: 0, earnedFree: 0, refunded: 0 };

describe('payout funding signals (review H2)', () => {
  it('compares e-mails lower-cased with the +tag dropped', () => {
    expect(identityKey(' Mei.Lin+payouts@Example.COM ')).toBe('mei.lin@example.com');
    expect(identityKey('not-an-email')).toBeNull();
    expect(identityKey(null)).toBeNull();
  });

  it('flags a dominant, fresh, exclusive payer sharing the owner’s address; a spread raises nothing', () => {
    const dominant = payer('a', 800, {
      createdAt: new Date(now.getTime() - 11 * DAY),
      activeElsewhere: false,
      maxFeeQuestions: 2,
      paypalEmail: 'OWNER+x@example.com',
    });
    const s = summarizeFunding({ drawn: 1_000, payers: [payer('b', 100), dominant, payer('c', 100)], sources, drawnRefunded: 50, ownerEmails: ['owner@example.com', null] });
    expect(s.ranked.map((row) => row.userId)).toEqual(['a', 'b', 'c']);
    expect(s).toMatchObject({ payers: 3, traced: 1_000, topShare: 0.8, top3Share: 1, sharedIdentity: 1 });
    expect(s.flags).toEqual(['top_payer', 'fresh_payers', 'exclusive_payers', 'shared_identity', 'refunded']);
    const spread = summarizeFunding({ drawn: 1_000, payers: Array.from({ length: 10 }, (_, i) => payer(`p${i}`, 100)), sources, drawnRefunded: 0, ownerEmails: ['owner@example.com'] });
    expect(spread.flags).toEqual([]);
    expect(spread.topShare).toBeCloseTo(0.1);
    /* Invite-funded credits: flagged from PAYOUT_REVIEW_SIGNALS.inviteFundedShare (30%), not below it. */
    const invited = (drawnInvite: number) => summarizeFunding({ drawn: 1_000, payers: Array.from({ length: 10 }, (_, i) => payer(`p${i}`, 100)), sources, drawnRefunded: 0, drawnInvite, ownerInvited: 4, ownerEmails: [] });
    expect(invited(300)).toMatchObject({ drawnInvite: 300, ownerInvited: 4, flags: ['invite_funded'] });
    expect(invited(299).flags).toEqual([]);
  });

  it('renders the cards and the queue line in every locale', () => {
    const summary = summarizeFunding({ drawn: 1_000, payers: [payer('a', 900, { disabled: true }), payer('b', 50)], sources, drawnRefunded: 0, ownerEmails: [] });
    for (const locale of LOCALES) {
      const t = messages(locale);
      const html = renderToStaticMarkup(
        createElement(I18nProvider, {
          locale,
          t,
          children: createElement('div', null, [
            createElement(PayoutFundingCards, {
              key: 'cards',
              t,
              locale,
              now,
              back: 'x',
              pageHref: (page: number) => `/admin/payouts/p?payers=${page}`,
              data: {
                summary,
                payers: { items: summary.ranked, total: 41, page: 2, size: 20 },
                maturity: { withdrawable: 10, maturing: 30, schedule: [{ date: new Date('2026-12-01T00:00:00Z'), credits: 30 }], later: 0, locked: 5 },
              },
            }),
            createElement(FundingSummaryLine, { key: 'line', t, line: { payers: 2, topShare: 0.9, flags: summary.flags } }),
          ]),
        }),
      );
      const f = t.consolePayouts.funding;
      expect(html).toContain(f.title);
      expect(html).toContain('/admin/users/a?from=x');
      expect(html).toContain(f.tags.disabled);
      expect(html).toContain('90%');
      expect(html).toContain('/admin/payouts/p?payers=1');
      expect(html).toContain('/admin/payouts/p?payers=3');
      expect(html).toContain(f.flags.top_payer.split('{')[0]!);
      expect(html).toContain(fill(f.untraced, { credits: '50' }));
      expect(html).not.toContain('{');
    }
  });
});
