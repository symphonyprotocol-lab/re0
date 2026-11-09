import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { codeState } from '@/lib/domain/redeem';
import { csvHref, listHref, REDEEM_BATCH_DEFAULTS, redeemBatchView } from '@/lib/domain/admin-lists';
import { getBatch, listCodes, listRedemptions } from '@/lib/services/admin-redeem';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { CI } from '@/components/admin/console-icon';
import { ListFilters } from '@/components/admin/list-client';
import { DetailSection, Fields, LinkPager, PageHead, Person, RecordSection, RecordsTable, ResultsLine, Tag } from '@/components/admin/list-kit';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { BatchActions, CodeToggle, RevealCode } from '@/components/admin/redeem-codes';
import { batchTarget, PHASE_TONES } from '@/components/admin/redeem-kit';

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.redeemAdmin.detail.title };
}

const CODE_TONES = { available: 'green', used_up: 'grey', disabled: 'red' } as const;

/**
 * `/admin/redeem-codes/[id]` (docs/design/redeem-codes.md 6.1): the batch,
 * its edits and switch, then its codes (masked until revealed, exported in
 * plaintext with an audit row) or its redemptions.
 */
export default async function RedeemBatchPage({ params, searchParams }: Props) {
  const { id } = await params;
  const batch = await getBatch(id);
  if (!batch) notFound();
  const { t, locale } = await serverMessages();
  const r = t.redeemAdmin;
  const d = r.detail;
  const l = t.console.list;
  const view = redeemBatchView(await searchParams);
  const base = `/admin/redeem-codes/${batch.id}`;
  const codes = view.tab === 'codes' ? await listCodes(batch.id, view) : null;
  const redemptions = view.tab === 'redemptions' ? await listRedemptions(batch.id, view) : null;
  const list = codes ?? redemptions!;
  const current = { ...view, page: list.page };
  const href = (changes: Record<string, string | number | null>) => listHref(base, current, changes, REDEEM_BATCH_DEFAULTS);
  if (list.page !== view.page) redirect(href({}));
  const n = (value: number) => formatNumber(value, locale);
  const time = (value: Date | null) => (value ? formatDateTime(value, locale) : '—');
  const filtered = Boolean(view.q) || view.status !== 'all';
  const tabHref = (tab: 'codes' | 'redemptions') => listHref(base, { tab, size: view.size }, {}, REDEEM_BATCH_DEFAULTS);

  return (
    <ConsolePage>
      <ConsoleTopbar
        crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: r.title, href: '/admin/redeem-codes' }, { label: batch.name }]}
        tabs={(['codes', 'redemptions'] as const).map((tab) => ({ label: d.tabs[tab], href: tabHref(tab), active: view.tab === tab }))}
        tabsLabel={d.title}
      />
      <div className="admin-record-detail">
        <PageHead
          title={batch.name}
          lede={d.title}
          actions={<BatchActions batch={{ id: batch.id, name: batch.name, note: batch.note, status: batch.status, expiresAt: batch.expiresAt?.toISOString() ?? null }} />}
        />
        <div className="info-strip mb16">
          <CI name="info" />
          <span>{d.info}</span>
        </div>
        <DetailSection title={d.title}>
          <Fields
            items={[
              [d.fields.status, <Tag key="status" tone={PHASE_TONES[batch.phase]}>{r.phases[batch.phase]}</Tag>],
              [d.fields.target, batchTarget(t, locale, batch)],
              [d.fields.codes, n(batch.codeCount)],
              [d.fields.perCode, batch.maxRedemptions === null ? r.unlimited : n(batch.maxRedemptions)],
              [d.fields.perUser, n(batch.perUserLimit)],
              [d.fields.redemptions, batch.capacity === null ? n(batch.redemptionCount) : fill(r.usedOf, { used: n(batch.redemptionCount), total: n(batch.capacity) })],
              [d.fields.users, n(batch.stats.users)],
              [d.fields.usedUp, n(batch.stats.usedUp)],
              [d.fields.disabledCodes, n(batch.stats.disabled)],
              [d.fields.startsAt, time(batch.startsAt)],
              [d.fields.expiresAt, batch.expiresAt ? time(batch.expiresAt) : r.noExpiry],
              [d.fields.prefix, batch.codePrefix ?? '—'],
              [d.fields.createdBy, batch.createdByName ?? '—'],
              [d.fields.created, time(batch.createdAt)],
              [d.fields.note, batch.note ?? '—'],
            ]}
          />
        </DetailSection>

        <RecordSection className="mt24">
          <ListFilters
            q={view.q}
            placeholder={codes ? d.codeSearch : d.redemptionSearch}
            defaults={{ tab: view.tab, status: 'all', size: '20' }}
            resetHref={tabHref(view.tab)}
            filtered={filtered}
            selects={[
              ...(codes ? [{ name: 'status', label: d.codeColumns.status, value: view.status, options: (['all', 'available', 'used_up', 'disabled'] as const).map((state) => [state, d.codeStates[state]] as [string, string]) }] : []),
              { name: 'size', label: l.perPage, value: String(view.size), options: [20, 50, 100].map((size) => [String(size), fill(l.rows, { n: size })] as [string, string]) },
            ]}
          />
          <ResultsLine
            t={t}
            total={list.total}
            page={list.page}
            size={list.size}
            exportHref={csvHref(`/api/admin/redeem-batches/${batch.id}/${view.tab}`, { q: view.q, status: codes ? view.status : 'all' })}
            note={codes ? d.exportNote : undefined}
          />
          {codes ? (
            <RecordsTable
              label={l.tableRegion}
              empty={l.empty}
              head={[d.codeColumns.code, d.codeColumns.uses, d.codeColumns.status, d.codeColumns.last, d.codeColumns.actions]}
              rows={codes.items.map((code) => {
                const state = codeState(code);
                return [
                  <RevealCode key="code" id={code.id} last4={code.last4} />,
                  <span key="uses" className="mono">{fill(r.usedOf, { used: n(code.redemptionCount), total: code.maxRedemptions === null ? r.unlimited : n(code.maxRedemptions) })}</span>,
                  <Tag key="status" tone={CODE_TONES[state]}>{d.codeStates[state]}</Tag>,
                  time(code.lastRedeemedAt),
                  <CodeToggle key="toggle" id={code.id} status={code.status} />,
                ];
              })}
            />
          ) : (
            <RecordsTable
              label={l.tableRegion}
              empty={l.empty}
              head={[d.redemptionColumns.time, d.redemptionColumns.user, d.redemptionColumns.code, d.redemptionColumns.credits, d.redemptionColumns.plan]}
              rows={redemptions!.items.map((row) => [
                time(row.createdAt),
                <Person key="user" name={row.name} email={row.email} href={`/admin/users/${row.userId}`} />,
                <span key="code" className="mono">{`····${row.last4}`}</span>,
                <span key="credits" className="mono">{row.kind === 'plan' ? fill(d.creditsPlan, { credits: n(row.credits), months: row.planMonths ?? 0 }) : n(row.credits)}</span>,
                row.planStartsAt ? fill(d.planRange, { start: time(row.planStartsAt), end: time(row.planEndsAt) }) : '—',
              ])}
            />
          )}
          <LinkPager t={t} page={list.page} total={list.total} size={list.size} href={(page) => href({ page })} />
        </RecordSection>
      </div>
    </ConsolePage>
  );
}
