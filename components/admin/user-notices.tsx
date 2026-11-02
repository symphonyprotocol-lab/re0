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

export function UserNotices({ t, locale, items, total }: { t: Messages; locale: Locale; items: NoticeRow[]; total: number }) {
  const s = t.consoleUsers.detail.summary;
  if (!items.length) return null;
  return (
    <section className="card min-w-0 p-5">
      <h2 className="text-[15px] font-bold">{s.notices}</h2>
      <p className="mt-1 text-[12px] text-muted">{s.noticesHint}</p>
      <ul className="mt-3 divide-y divide-line">
        {items.map((notice) => {
          const { line, reason } = noticeLine(t, locale, notice);
          return (
            <li key={notice.id} className="py-2.5 text-[13px]">
              <p className="break-words">
                {!notice.readAt && <span className="mr-1.5 inline-block size-1.5 rounded-full bg-red align-middle" title={s.unread} aria-label={s.unread} />}
                {line}
              </p>
              {reason && <p className="mt-0.5 text-[12px] break-words text-muted">{reason}</p>}
              <small className="mt-0.5 block text-[11px] text-muted">{formatDateTime(notice.createdAt, locale)}</small>
            </li>
          );
        })}
      </ul>
      {total > items.length && <p className="mt-2 text-[11px] text-muted">{fill(s.noticesMore, { total: formatNumber(total, locale), n: formatNumber(items.length, locale) })}</p>}
    </section>
  );
}
