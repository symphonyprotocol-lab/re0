'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client/upload';
import type { Messages } from '@/i18n';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import type { Locale } from '@/i18n/locale';
import { Icon, Spinner, type IconName } from '@/components/ui/icons';
import { EmptyState, LinkPager } from '@/components/statistics/shared';

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
        href: '/settings?tab=billing',
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
      return { line, icon: 'shield', href: p.decision === 'verified' ? '/settings?tab=billing#payouts' : '/settings/identity', action: p.decision === 'verified' ? o.billing : k.identity, reason };
    }
    case 'payout': {
      /* Step 6: a payout approved, rejected, paid or failed. */
      const k = t.payouts.notices;
      const usd = `$${((Number(p.credits) || 0) / 10_000).toFixed(2)}`;
      const paid = `$${((Number(p.paidCents) || 0) / 100).toFixed(2)}`;
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
      return { line, icon: 'sparkle', href: '/settings?tab=billing#payouts', action: o.billing, reason };
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[17px] font-bold">{nt.title}</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">{nt.lede}</p>
        </div>
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={busy || (unread === 0 && fresh.size === 0)}
          onClick={() => {
            setFresh(new Set());
            void markAll();
          }}
        >
          {busy ? <Spinner className="size-3.5" /> : <Icon name="check" className="size-3.5" />}
          {nt.markAll}
        </button>
      </div>
      <section className="card min-w-0 overflow-hidden">
        {items.length === 0 ? (
          <div className="px-4 py-12">
            <EmptyState icon="info" title={nt.empty} body={nt.emptyBody} />
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((item) => {
              const notice = describe(t, locale, item);
              const isNew = fresh.has(item.id);
              return (
                <li key={item.id} className={`flex gap-3 px-4 py-4 md:px-5 ${isNew ? 'bg-[#f8fbff]' : ''}`}>
                  <span className="relative mt-0.5 inline-flex size-8 flex-none items-center justify-center rounded-lg bg-soft text-blue">
                    <Icon name={notice.icon} className="size-4" />
                    {isNew && (
                      <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-white bg-red">
                        <span className="sr-only">{nt.unread}</span>
                      </span>
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={`text-[13px] leading-relaxed break-words ${isNew ? 'font-semibold' : ''}`}>{notice.line}</p>
                    {notice.reason && <p className="mt-1 text-[12px] leading-relaxed break-words whitespace-pre-wrap text-muted">{notice.reason}</p>}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                      <time dateTime={item.createdAt}>{formatDateTime(item.createdAt, locale)}</time>
                      {notice.href && notice.action && (
                        <Link href={notice.href} className="text-link text-[11px]">
                          {notice.action}
                          <Icon name="arrow" className="size-3" />
                        </Link>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {total > size && <LinkPager t={t} locale={locale} page={page} size={size} total={total} href={(next) => `/settings?tab=notices&page=${next}`} />}
      </section>
    </div>
  );
}
