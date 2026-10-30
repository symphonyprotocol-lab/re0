import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache, type ReactNode } from 'react';
import {
  ConsoleButton,
  ConsolePageHeader,
  EmptyRow,
  Fact,
  Metric,
  Monogram,
  Panel,
  PanelHead,
  Pill,
  TableScroller,
  TD,
  TH,
} from '@/components/admin/ui';
import { UserRevokeControl } from '@/components/admin/user-revoke-dialog';
import { UserStatusControl } from '@/components/admin/user-status-dialog';
import { ChevronLeftIcon } from '@/components/ui/icons';
import { getConsoleUser } from '@/lib/application/administration';
import { currentAdminSession, requireAdminCapability } from '@/lib/http/admin';
import { fill } from '@/lib/i18n/format';
import { getMessages } from '@/lib/i18n/server';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { bytes, initialsOf, utcDate, utcStamp } from '../../list-params';
import { revokeUserApiKeyAction, revokeUserSessionAction, setUserStatusAction } from '../actions';

/**
 * The metadata and the page both need the account, and Next renders them as
 * two calls into this module. `cache` makes that one read per request rather
 * than seven queries run twice.
 */
const loadUser = cache(getConsoleUser);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ userId: string }>;
}): Promise<Metadata> {
  const [{ userId }, t, session] = await Promise.all([
    params,
    getMessages(),
    currentAdminSession(),
  ]);

  /*
   * Entitlement first, even here. Metadata runs alongside the page rather than
   * after its guard, so without this an unentitled request would still read
   * the account out of the database -- the redirect would keep the answer from
   * reaching anyone, but the read is one this route has no business making.
   */
  if (!session?.capabilities.includes('users')) return { title: t.admin.userDetail.title };

  const account = await loadUser(userId);
  return {
    title: account
      ? fill(t.admin.userDetail.metaTitle, { name: account.displayName })
      : t.admin.userDetail.title,
  };
}

/**
 * One registered account in full -- design source frame `DPlDO`.
 *
 * requirement.md 5.3 asks the console to inspect an account and enable or
 * suspend it. Everything on this page is read from the tables that own it, and
 * the panels are ordered by what a suspension decision needs: who they are,
 * what they publish, what still authenticates as them.
 */
export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const [, { userId }, t] = await Promise.all([
    requireAdminCapability('users'),
    params,
    getMessages(),
  ]);

  const account = await loadUser(userId);
  if (!account) notFound();

  const d = t.admin.userDetail;
  const workspace = account.workspaces[0];

  /** The panels below show the most recent rows only; this says so when it matters. */
  const truncation = (shown: number, total: number) =>
    shown < total ? (
      <p className="text-[11px] tracking-[-0.023em] text-muted">
        {fill(d.showingLatest, { shown, total: total.toLocaleString('en-US') })}
      </p>
    ) : undefined;

  return (
    <div className="flex flex-col gap-[18px]">
      <ConsolePageHeader
        eyebrow={d.eyebrow}
        title={account.displayName}
        description={`${account.email} · ${account.id}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ConsoleButton href="/admin/users">
              <ChevronLeftIcon size={14} />
              {d.back}
            </ConsoleButton>
            <UserStatusControl
              variant="button"
              action={setUserStatusAction}
              target={{
                id: account.id,
                displayName: account.displayName,
                email: account.email,
                initial: initialsOf(account.displayName),
                status: account.status,
                liveSessions: account.liveSessions,
                liveApiKeys: account.liveApiKeys,
                publishedAssets: account.publishedAssets,
              }}
            />
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label={d.metrics.plan}
          value={workspace?.planName ?? 'Free'}
          note={
            workspace?.renewal
              ? fill(
                  workspace.renewal.kind === 'cancels' ? d.metrics.planCancels : d.metrics.planRenews,
                  { date: utcDate(workspace.renewal.at) },
                )
              : workspace?.periodEnd
                ? fill(d.metrics.planNote, { date: utcDate(workspace.periodEnd) })
                : d.metrics.planNoteNone
          }
        />
        <Metric
          label={d.metrics.assets}
          value={account.assetTotal.toLocaleString('en-US')}
          note={fill(d.metrics.assetsNote, {
            public: account.publicAssets,
            private: account.assetTotal - account.publicAssets,
          })}
        />
        <Metric
          label={d.metrics.calls}
          value={account.callsThisMonth.toLocaleString('en-US')}
          note={
            workspace?.monthlyCalls
              ? fill(d.metrics.callsNote, {
                  quota: workspace.monthlyCalls.toLocaleString('en-US'),
                })
              : d.metrics.callsNoteNone
          }
        />
        <Metric
          label={d.metrics.sessions}
          value={account.liveSessions.toLocaleString('en-US')}
          note={fill(d.metrics.sessionsNote, { count: account.liveApiKeys })}
        />
      </div>

      <Panel>
        <PanelHead title={d.accountTitle} description={d.accountSubtitle} />
        <dl className="grid gap-x-6 px-[19px] py-2 sm:grid-cols-2">
          <Fact label={d.fields.id} value={account.id} />
          <Fact label={d.fields.email} value={account.email} />
          <Fact label={d.fields.displayName} value={account.displayName} />
          <Fact
            label={d.fields.identities}
            value={
              account.identities.length === 0
                ? d.identityNone
                : account.identities.map((row) => row.provider).join(' · ')
            }
          />
          <Fact
            label={d.fields.workspace}
            value={
              workspace
                ? fill(d.workspaceRole, { name: workspace.name, role: workspace.role })
                : d.workspaceNone
            }
          />
          <Fact label={d.fields.createdAt} value={`${utcStamp(account.createdAt)} UTC`} />
          <Fact label={d.fields.updatedAt} value={`${utcStamp(account.updatedAt)} UTC`} />
          <Fact
            label={d.fields.status}
            value={
              <Pill tone={account.status === 'active' ? 'ok' : 'danger'}>
                {account.status === 'active'
                  ? t.adminDemo.userStatus.active
                  : t.adminDemo.userStatus.suspended}
              </Pill>
            }
          />
        </dl>
      </Panel>

      <Panel>
        <PanelHead
          title={d.assetsTitle}
          description={d.assetsSubtitle}
          action={truncation(account.assets.length, account.assetTotal)}
        />
        <DetailTable columns={d.assetsColumns} empty={d.assetsEmpty} rows={account.assets.length}>
          {account.assets.map((asset) => (
            <tr key={asset.id} className="border-t-2 border-line">
              <td className={TD}>
                <span className="flex min-w-0 flex-col gap-[3px]">
                  <span className="truncate text-[12px] font-medium text-ink">{asset.title}</span>
                  <span className="truncate font-mono text-[11px] text-muted">
                    {asset.publicId}
                  </span>
                </span>
              </td>
              <td className={TD}>
                <Pill tone={asset.visibility === 'public' ? 'info' : 'neutral'}>
                  {visibilityLabel(d, asset.visibility)}
                </Pill>
              </td>
              <td className={TD}>
                <Pill tone={asset.lifecycleStatus === 'published' ? 'ok' : 'warn'}>
                  {lifecycleLabel(d, asset.lifecycleStatus)}
                </Pill>
              </td>
              <td className={TD}>{bytes(asset.storageBytes)}</td>
              <td className={`${TD} whitespace-nowrap`}>{utcDate(asset.createdAt)}</td>
            </tr>
          ))}
        </DetailTable>
      </Panel>

      <Panel>
        <PanelHead
          title={d.keysTitle}
          description={d.keysSubtitle}
          action={truncation(account.apiKeys.length, account.apiKeyTotal)}
        />
        <DetailTable columns={d.keysColumns} empty={d.keysEmpty} rows={account.apiKeys.length}>
          {account.apiKeys.map((key) => (
            <tr key={key.id} className="border-t-2 border-line">
              <td className={TD}>
                <span className="flex min-w-0 flex-col gap-[3px]">
                  <span className="truncate text-[12px] font-medium text-ink">{key.name}</span>
                  <span className="truncate font-mono text-[11px] text-muted">
                    {`${key.keyPrefix}…${key.lastFour}`}
                  </span>
                </span>
              </td>
              <td className={TD}>{key.environment}</td>
              <td className={`${TD} whitespace-nowrap`}>
                {key.lastUsedAt ? `${utcStamp(key.lastUsedAt)} UTC` : d.neverUsed}
              </td>
              <td className={`${TD} whitespace-nowrap`}>{utcDate(key.createdAt)}</td>
              <td className={TD}>
                <span className="flex items-center gap-2">
                  <Pill tone={key.revokedAt ? 'neutral' : 'ok'}>
                    {key.revokedAt ? d.keyRevoked : d.keyActive}
                  </Pill>
                  {key.revokedAt ? null : (
                    <UserRevokeControl
                      kind="key"
                      action={revokeUserApiKeyAction}
                      userId={account.id}
                      target={{
                        id: key.id,
                        title: key.name,
                        detail: `${key.keyPrefix}…${key.lastFour} · ${key.environment}`,
                      }}
                    />
                  )}
                </span>
              </td>
            </tr>
          ))}
        </DetailTable>
      </Panel>

      <Panel>
        <PanelHead
          title={d.sessionsTitle}
          description={d.sessionsSubtitle}
          action={truncation(account.sessions.length, account.sessionTotal)}
        />
        <DetailTable
          columns={d.sessionsColumns}
          empty={d.sessionsEmpty}
          rows={account.sessions.length}
        >
          {account.sessions.map((session) => {
            const live = session.revokedAt === null && session.expiresAt.getTime() > Date.now();
            return (
              <tr key={session.id} className="border-t-2 border-line">
                <td className={TD}>
                  <span className="flex min-w-0 flex-col gap-[3px]">
                    <span className="truncate text-[12px] font-medium text-ink">
                      {clientOf(session.clientSummary) ?? d.sessionUnknownClient}
                    </span>
                    <span className="truncate font-mono text-[11px] text-muted">{session.id}</span>
                  </span>
                </td>
                <td className={`${TD} whitespace-nowrap`}>{`${utcStamp(session.lastSeenAt)} UTC`}</td>
                <td className={`${TD} whitespace-nowrap`}>{`${utcStamp(session.expiresAt)} UTC`}</td>
                <td className={TD}>
                  <span className="flex items-center gap-2">
                    <Pill tone={live ? 'ok' : 'neutral'}>{live ? d.sessionLive : d.sessionEnded}</Pill>
                    {live ? (
                      <UserRevokeControl
                        kind="session"
                        action={revokeUserSessionAction}
                        userId={account.id}
                        target={{
                          id: session.id,
                          title: clientOf(session.clientSummary) ?? d.sessionUnknownClient,
                          detail: session.id,
                        }}
                      />
                    ) : null}
                  </span>
                </td>
              </tr>
            );
          })}
        </DetailTable>
      </Panel>

      <Panel>
        <PanelHead
          title={d.auditTitle}
          description={d.auditSubtitle}
          action={
            <span className="flex flex-wrap items-center gap-2.5">
              {truncation(account.audit.length, account.auditTotal)}
              <Link
                href="/admin/audit"
                className="text-[12px] font-medium tracking-[-0.023em] text-brand hover:underline"
              >
                {d.auditLink}
              </Link>
            </span>
          }
        />
        <DetailTable columns={d.auditColumns} empty={d.auditEmpty} rows={account.audit.length}>
          {account.audit.map((entry) => (
            <tr key={entry.id} className="border-t-2 border-line">
              <td className={`${TD} whitespace-nowrap`}>{`${utcStamp(entry.createdAt)} UTC`}</td>
              <td className={TD}>{entry.administrator ?? d.auditSystem}</td>
              <td className={TD}>
                <span className="font-mono text-[11px] text-steel">{entry.action}</span>
              </td>
              <td className={TD}>{entry.reason ?? '—'}</td>
            </tr>
          ))}
        </DetailTable>
      </Panel>
    </div>
  );
}

/** Shared table chrome for the detail panels: same head, same empty state. */
function DetailTable({
  columns,
  empty,
  rows,
  children,
}: {
  columns: readonly string[];
  empty: string;
  rows: number;
  children: ReactNode;
}) {
  return (
    <TableScroller>
      <table className="w-full min-w-[620px] border-collapse text-left">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col" className={TH}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows === 0 ? <EmptyRow columns={columns.length} message={empty} /> : null}
          {children}
        </tbody>
      </table>
    </TableScroller>
  );
}

type DetailMessages = Dictionary['admin']['userDetail'];

/*
 * The status columns are Postgres enums, so a value outside the map means the
 * schema grew a state the console has no word for. Falling back to the raw
 * value keeps the row readable instead of rendering an empty cell.
 */
function lifecycleLabel(d: DetailMessages, status: string): string {
  return (d.lifecycle as Record<string, string>)[status] ?? status;
}

function visibilityLabel(d: DetailMessages, visibility: string): string {
  return (d.visibility as Record<string, string>)[visibility] ?? visibility;
}

/** The coarse fingerprint a session stores; never an address (architecture.md 11.2). */
function clientOf(summary: Record<string, string>): string | null {
  const parts = [summary.browser, summary.platform].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : (summary.userAgent ?? null);
}
