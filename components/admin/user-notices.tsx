/**
 * 账户提示 on the console's user summary (prototype suite.js `userDetail`):
 * the in-app notices this user was sent, newest first, worded as the user
 * reads them (a server-side twin of the settings notices tab's lines,
 * without its links).
 */
import { formatCentsUsd, formatCreditsUsd } from '@/lib/domain/payouts';
import type { NoticeRow } from '@/lib/services/notices';
import type { Locale, Messages } from '@/i18n';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';

const ROLES = ['normal', 'verified', 'official'] as const;

function roleName(t: Messages, value: unknown): string {
  return (ROLES as readonly unknown[]).includes(value) ? t.roles.roles[value as (typeof ROLES)[number]] : String(value ?? '');
}

function noticeLine(t: Messages, locale: Locale, notice: NoticeRow): { line: string; reason: string | null } {
  const l = t.notices.lines;
  const p = notice.params;
  const reason = notice.text ? fill(t.notices.reason, { text: notice.text }) : null;
  switch (notice.kind) {
    case 'takedown':
    case 'restore':
      return { line: fill(notice.kind === 'takedown' ? l.takedown : l.restore, { ree: String(p.ree ?? '') }), reason };
    case 'credits_adjust': {
      const delta = Number(p.delta) || 0;
      const bucket = p.bucket === 'plan' ? t.notices.buckets.plan : t.notices.buckets.pack;
      return { line: fill(delta >= 0 ? l.creditsAdd : l.creditsDeduct, { n: formatNumber(Math.abs(delta), locale), bucket }), reason };
    }
    case 'verification': {
      const approved = p.decision === 'approved';
      return { line: approved ? l.approved : l.rejected, reason: notice.text ? fill(approved ? t.notices.note : t.notices.reason, { text: notice.text }) : null };
    }
    case 'role':
      return { line: fill(l.role, { from: roleName(t, p.from), to: roleName(t, p.to) }), reason };
    case 'kyc': {
      const k = t.payouts.notices;
      return { line: p.decision === 'verified' ? k.verified : p.decision === 'rejected' ? k.rejected : p.decision === 'reset' ? k.reset : l.kyc, reason };
    }
    case 'payout': {
      const k = t.payouts.notices;
      const usd = formatCreditsUsd(Number(p.credits) || 0);
      const line =
        p.status === 'approved'
          ? fill(k.approved, { usd })
          : p.status === 'rejected'
            ? fill(k.payoutRejected, { usd })
            : p.status === 'paid'
              ? fill(k.paid, { paid: formatCentsUsd(Number(p.paidCents) || 0) })
              : p.status === 'failed'
                ? fill(k.failed, { usd })
                : l.payout;
      return { line, reason };
    }
    default:
      return { line: l.other, reason };
  }
}

/** 账户提示 (prototype `userDetail`): one form hint per notice, with its reason, time and whether it is unread. */
export function UserNotices({ t, locale, items, total }: { t: Messages; locale: Locale; items: NoticeRow[]; total: number }) {
  const s = t.consoleUsers.detail.summary;
  if (!items.length) return null;
  return (
    <section className="card settings-card mt24">
      <h2>{s.notices}</h2>
      {items.map((notice) => {
        const { line, reason } = noticeLine(t, locale, notice);
        return (
          <p key={notice.id} className="form-hint mt16">
            {[line, reason, formatDateTime(notice.createdAt, locale), notice.readAt ? null : s.unread].filter(Boolean).join(' · ')}
          </p>
        );
      })}
      {total > items.length && <p className="form-hint mt16">{fill(s.noticesMore, { total: formatNumber(total, locale), n: formatNumber(items.length, locale) })}</p>}
    </section>
  );
}
