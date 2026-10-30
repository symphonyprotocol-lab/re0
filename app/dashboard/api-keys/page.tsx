import type { Metadata } from 'next';
import { ApiKeyCreate } from '@/components/dashboard/api-key-create';
import { ApiKeyRotate } from '@/components/dashboard/api-key-rotate';
import {
  ArrowLink,
  Badge,
  IconTile,
  ListHeader,
  Notice,
  PANEL,
  PageHeader,
  StatTile,
  StatusLabel,
} from '@/components/dashboard/ui';
import {
  BracesIcon,
  ClockIcon,
  KeyIcon,
  ShieldCheckIcon,
} from '@/components/ui/icons';
import { listApiKeys } from '@/lib/application/auth';
import { canManageApiKeys } from '@/lib/application/assets';
import { listRequests } from '@/lib/application/plans';
import { isApiKeyIdle } from '@/lib/domain/api-key';
import { workspaceUsage } from '@/lib/http/dashboard';
import { requireSession } from '@/lib/http/session';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';
import { createApiKeyAction, revokeApiKeyAction, rotateApiKeyAction } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.apiKeys.metaTitle };
}

const GRID = 'grid grid-cols-[minmax(0,1fr)_124px_150px_84px_56px] items-center gap-2.5';

function RevokeButton({ label, keyId }: { label: string; keyId: string }) {
  return (
    <form action={revokeApiKeyAction}>
      <input type="hidden" name="keyId" value={keyId} />
      <button
        type="submit"
        aria-label={label}
        className="inline-flex size-[26px] items-center justify-center rounded-md text-muted transition-colors hover:bg-mutedbg hover:text-rose"
      >
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          width={15}
          height={15}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 6h18" />
          <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        </svg>
      </button>
    </form>
  );
}

/**
 * Key management, on the real rows. architecture.md 5.1: the list shows what
 * the server keeps (prefix, last four, timestamps); creation shows the
 * plaintext once through the panel above the table; revocation is a
 * timestamp, scoped to the session's workspace.
 *
 * Minting, rotating and revoking are the owner's (requirement.md 3.3), which
 * is what `canManageApiKeys` says and what every one of those use cases
 * enforces. The page renders the controls to match: an admin or developer
 * reads the same list -- they may use a key, and the last-used column is how
 * they see it working -- but is not offered a button whose only outcome is a
 * refusal, and is told plainly why.
 */
export default async function DashboardApiKeysPage() {
  const [session, { locale, t }] = await Promise.all([
    requireSession('/dashboard/api-keys'),
    translations(),
  ]);
  const k = t.dashboard.apiKeys;
  const workspaceId = session.workspace.id;

  const manages = canManageApiKeys(session.workspace.role);

  const [keys, overview, recent] = await Promise.all([
    listApiKeys(workspaceId),
    workspaceUsage(workspaceId),
    listRequests(workspaceId, 8),
  ]);

  const number = new Intl.NumberFormat(locale);
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  const lastUsed = keys
    .map((key) => key.lastUsedAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1);
  /* The security figure is a count, not a slogan: live keys nothing has used
     in thirty days are the ones worth revoking (requirement.md 5.2). */
  const now = new Date();
  const idle = new Set(keys.filter((key) => isApiKeyIdle(key, now)).map((key) => key.id));

  const stats = [
    { key: 'active', value: number.format(keys.length), label: k.stats.active, Icon: KeyIcon },
    {
      key: 'calls',
      value: number.format(overview.callsThisPeriod),
      label: k.stats.calls,
      Icon: BracesIcon,
    },
    {
      key: 'recent',
      value: lastUsed ? dateTime.format(new Date(lastUsed)) : '—',
      label: k.stats.recent,
      Icon: ClockIcon,
    },
    {
      key: 'security',
      value: number.format(idle.size),
      label: k.scoped.idleStat,
      Icon: ShieldCheckIcon,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader eyebrow={k.eyebrow} title={k.title} description={k.description} />

      <section className="grid grid-cols-2 gap-[9px] sm:grid-cols-4">
        {stats.map(({ key, value, label, Icon }) => (
          <StatTile key={key} icon={<Icon size={17} />} value={value} label={label} />
        ))}
      </section>

      <Notice
        tone="brand"
        icon={<ShieldCheckIcon size={18} />}
        title={k.noticeTitle}
        body={k.noticeBody}
      />

      {manages ? (
        <ApiKeyCreate action={createApiKeyAction} />
      ) : (
        <Notice
          tone="plain"
          icon={<ShieldCheckIcon size={18} />}
          title={k.scoped.ownerOnlyTitle}
          body={k.scoped.ownerOnlyBody}
        />
      )}

      {/* Key table -- design source frame `jLwpR`. */}
      <section className={`${PANEL} overflow-hidden p-0.5`}>
        <ListHeader title={k.listTitle} description={k.listDescription} />

        <div className="overflow-x-auto">
          <div className="min-w-[600px]">
            <div
              className={`${GRID} border-t border-line bg-subtle px-5 py-[11px] text-[11px] font-medium text-muted`}
            >
              {k.columns.map((column) => (
                <span key={column}>{column}</span>
              ))}
              <span />
            </div>

            {keys.map((key) => (
              <div key={key.id} className={`${GRID} border-t border-line px-5 py-5`}>
                <span className="flex min-w-0 items-center gap-2.5">
                  <IconTile>
                    <KeyIcon size={15} />
                  </IconTile>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="truncate text-[13px] text-ink">
                      {key.name}
                    </span>
                    <span className="truncate text-[10px] text-muted">
                      {key.environment} · {fill(k.createdAt, { date: date.format(new Date(key.createdAt)) })}
                    </span>
                  </span>
                </span>

                <code className="inline-flex w-fit items-center rounded-md bg-mutedbg px-[7px] py-[5px] font-mono text-[11px] text-steel">
                  {key.masked}
                </code>

                <span className="flex flex-wrap gap-1">
                  {key.scopes.map((scope) => (
                    <Badge key={scope} tone="public">
                      {scope}
                    </Badge>
                  ))}
                </span>

                <span className="flex flex-col gap-1">
                  <StatusLabel tone={idle.has(key.id) ? 'pending' : 'live'}>
                    {key.lastUsedAt ? dateTime.format(new Date(key.lastUsedAt)) : k.neverUsed}
                  </StatusLabel>
                  {idle.has(key.id) ? (
                    <span className="text-[10px] text-amber">
                      {k.scoped.idleBadge}
                    </span>
                  ) : null}
                </span>

                <span className="flex items-center gap-1">
                  {manages ? (
                    <>
                      <ApiKeyRotate keyId={key.id} name={key.name} action={rotateApiKeyAction} />
                      <RevokeButton label={fill(k.revoke, { name: key.name })} keyId={key.id} />
                    </>
                  ) : null}
                </span>
              </div>
            ))}

            {keys.length === 0 ? (
              <p className="border-t border-line px-5 py-10 text-center text-[13px] text-muted">
                {k.empty}
              </p>
            ) : null}
          </div>
        </div>

        {/*
          * Said where the environment is read, because the word "Test" invites
          * the opposite assumption. requirement.md 5.2 asks only that a key
          * name an environment; nothing in the spec or in architecture.md 5.1
          * makes a `mm_test_` key unmetered, and nothing in the quota or
          * metering path reads the column -- so the label is what it is, and
          * the page no longer lets the reader infer a sandbox that would
          * otherwise be a free hole through the plan's allowance.
          */}
        <p className="border-t border-line px-5 py-3 text-[10.5px] leading-[1.6] text-muted">
          {k.scoped.environmentNote}
        </p>
      </section>

      <section className="grid gap-3 lg:grid-cols-[1fr_217px]">
        <article className={`${PANEL} overflow-hidden p-0.5`}>
          <ListHeader
            title={k.activityTitle}
            description={k.activityDescription}
            aside={<ArrowLink href="/dashboard/requests">{k.activityLink}</ArrowLink>}
          />
          <ul className="px-5 pb-4">
            {recent.map((entry) => (
              <li
                key={entry.requestId}
                className="flex items-center gap-4 border-t border-line py-2.5"
              >
                <span
                  aria-hidden
                  className={`size-[7px] shrink-0 rounded-full ${entry.statusCode < 400 ? 'bg-brand' : 'bg-rose'}`}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  <span className="truncate text-[12px] font-medium text-ink">
                    {entry.assetPublicId ?? entry.operation}
                  </span>
                  <span className="truncate text-[10px] text-muted">
                    {entry.operation} · {entry.statusCode}
                  </span>
                </span>
                <span className="shrink-0 text-[10px] text-muted">
                  {dateTime.format(new Date(entry.createdAt))}
                </span>
              </li>
            ))}
            {recent.length === 0 ? (
              <li className="border-t border-line py-6 text-center text-[12px] text-muted">
                {k.activityEmpty}
              </li>
            ) : null}
          </ul>
        </article>

        <article className={`${PANEL} flex flex-col p-[22px]`}>
          <IconTile>
            <ShieldCheckIcon size={17} />
          </IconTile>
          <p className="mt-3 text-[15px] leading-[1.4] text-ink">
            {k.leastPrivilegeTitle}
          </p>
          <p className="mt-1.5 text-[11px] leading-[1.6] text-muted">
            {k.leastPrivilegeBody}
          </p>
        </article>
      </section>
    </div>
  );
}
