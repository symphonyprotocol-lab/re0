'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client/upload';
import { formatCentsUsd, formatCreditsUsd } from '@/lib/domain/payouts';
import type { Messages } from '@/i18n';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import type { Locale } from '@/i18n/locale';
import { Spinner, type IconName } from '@/components/ui/icons';
import { LinkPager } from '@/components/statistics/shared';
import { I } from '@/components/settings/icon';

export interface NoticeItem {
  id: string;
  kind: string;
  text: string;
  params: Record<string, string | number | null>;
  refId: string | null;
  readAt: string | null;
  createdAt: string;
}

const ROLES = ['normal', 'verified', 'official'] as const;
const roleName = (t: Messages, value: unknown) => ((ROLES as readonly unknown[]).includes(value) ? t.roles.roles[value as (typeof ROLES)[number]] : String(value ?? ''));

/** One notice in the reader's language, from its kind and params; the administrator's words follow it. */
function describe(t: Messages, locale: Locale, notice: NoticeItem): { line: string; icon: IconName; href: string | null; action: string | null; reason: string | null } {
  const l = t.notices.lines;
  const o = t.notices.open;
  const p = notice.params;
  const reason = notice.text ? fill(t.notices.reason, { text: notice.text }) : null;
  const reeId = typeof p.reeId === 'string' ? p.reeId : notice.refId;
  switch (notice.kind) {
    case 'takedown':
    case 'restore':
      return {
        line: fill(notice.kind === 'takedown' ? l.takedown : l.restore, { ree: String(p.ree ?? '') }),
        icon: notice.kind === 'takedown' ? 'lock' : 'globe',
        href: reeId ? `/rees/${reeId}/settings` : null,
        action: o.ree,
        reason,
      };
    case 'credits_adjust': {
      const delta = Number(p.delta) || 0;
      const bucket = p.bucket === 'plan' ? t.notices.buckets.plan : t.notices.buckets.pack;
      return {
        line: fill(delta >= 0 ? l.creditsAdd : l.creditsDeduct, { n: formatNumber(Math.abs(delta), locale), bucket }),
        icon: 'layers',
        href: '/settings?tab=balance',
        action: o.billing,
        reason,
      };
    }
    case 'verification': {
      const approved = p.decision === 'approved';
      return {
        line: approved ? l.approved : l.rejected,
        icon: 'shield',
        href: '/settings?tab=role',
        action: o.role,
        reason: notice.text ? fill(approved ? t.notices.note : t.notices.reason, { text: notice.text }) : null,
      };
    }
    case 'role':
      return { line: fill(l.role, { from: roleName(t, p.from), to: roleName(t, p.to) }), icon: 'shield', href: '/settings?tab=role', action: o.role, reason };
    case 'kyc': {
      /* Step 6: an identity decision or a re-verification request. */
      const k = t.payouts.notices;
      const line = p.decision === 'verified' ? k.verified : p.decision === 'rejected' ? k.rejected : p.decision === 'reset' ? k.reset : l.kyc;
      return { line, icon: 'shield', href: p.decision === 'verified' ? '/settings?tab=balance#payouts' : '/settings/identity', action: p.decision === 'verified' ? o.billing : k.identity, reason };
    }
    case 'payout': {
      /* Step 6: a payout approved, rejected, paid or failed. */
      const k = t.payouts.notices;
      const usd = formatCreditsUsd(Number(p.credits) || 0);
      const paid = formatCentsUsd(Number(p.paidCents) || 0);
      const line =
        p.status === 'approved'
          ? fill(k.approved, { usd })
          : p.status === 'rejected'
            ? fill(k.payoutRejected, { usd })
            : p.status === 'paid'
              ? fill(k.paid, { paid })
              : p.status === 'failed'
                ? fill(k.failed, { usd })
                : l.payout;
      return { line, icon: 'sparkle', href: '/settings?tab=balance#payouts', action: o.billing, reason };
    }
    default:
      return { line: l.other, icon: 'info', href: null, action: null, reason };
  }
}

/**
 * `/settings?tab=notices` (8.2 "通知"): newest first, 20 a page. Opening the
 * tab marks everything read and refreshes the page so the sidebar dot
 * clears; the dots of this visit stay on the rows that were new.
 */
export function NoticesTab({ items, total, page, size, unread }: { items: NoticeItem[]; total: number; page: number; size: number; unread: number }) {
  const { t, locale } = useI18n();
  const nt = t.notices;
  const router = useRouter();
  const [fresh, setFresh] = useState(() => new Set(items.filter((item) => !item.readAt).map((item) => item.id)));
  const [busy, setBusy] = useState(false);
  const marked = useRef(false);

  const markAll = async () => {
    setBusy(true);
    const result = await api('/api/account/notices', { method: 'POST', json: { all: true } }).catch(() => null);
    setBusy(false);
    if (result?.ok) router.refresh();
  };

  useEffect(() => {
    /* Once per visit: the refresh that follows brings `unread` down to 0. */
    if (marked.current || unread === 0) return;
    marked.current = true;
    api('/api/account/notices', { method: 'POST', json: { all: true } })
      .then((result) => result.ok && router.refresh())
      .catch(() => undefined);
  }, [unread, router]);

  useEffect(() => {
    /* A new page of the list: its unread rows are this visit's new ones. */
    setFresh((current) => {
      const next = new Set(current);
      for (const item of items) if (!item.readAt) next.add(item.id);
      return next;
    });
  }, [items]);

  return (
    <section className="card settings-card notices-card">
      <div className="between">
        <div className="min-w-0">
          <h2>{nt.title}</h2>
          <p className="muted small notices-lede">{nt.lede}</p>
        </div>
        <button
          type="button"
          className="btn secondary sm"
          disabled={busy || (unread === 0 && fresh.size === 0)}
          onClick={() => {
            setFresh(new Set());
            void markAll();
          }}
        >
          {busy ? <Spinner /> : <I name="check" />}
          {nt.markAll}
        </button>
      </div>
      {items.length === 0 ? (
        <div className="empty notices-empty">
          <I name="info" />
          <h3>{nt.empty}</h3>
          <p>{nt.emptyBody}</p>
        </div>
      ) : (
        <ul className="notice-list">
          {items.map((item) => {
            const notice = describe(t, locale, item);
            const isNew = fresh.has(item.id);
            return (
              <li key={item.id} className={`notice-row ${isNew ? 'is-new' : ''}`}>
                <span className="connection-icon">
                  <I name={notice.icon} />
                  {isNew && (
                    <span className="notice-dot">
                      <span className="sr-only">{nt.unread}</span>
                    </span>
                  )}
                </span>
                <div className="s-grow">
                  <h3>{notice.line}</h3>
                  {notice.reason && <p className="role-pre">{notice.reason}</p>}
                  <small>
                    <time dateTime={item.createdAt}>{formatDateTime(item.createdAt, locale)}</time>
                    {notice.href && notice.action && (
                      <Link href={notice.href} className="text-link">
                        {notice.action}
                        <I name="arrow" />
                      </Link>
                    )}
                  </small>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {total > size && (
        <div className="notices-pager">
          <LinkPager t={t} locale={locale} page={page} size={size} total={total} href={(next) => `/settings?tab=notices&page=${next}`} />
        </div>
      )}
    </section>
  );
}
