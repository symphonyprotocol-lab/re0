import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, PANEL, PageHeader, StatusLabel } from '@/components/dashboard/ui';
import { ArrowUpRightIcon } from '@/components/ui/icons';
import { listWorkspaceChannels } from '@/lib/application/channels';
import { CHANNEL_DESCRIPTION_MAX_LENGTH, CHANNEL_TITLE_MAX_LENGTH } from '@/lib/domain/channel';
import { canManageLibraries } from '@/lib/application/libraries';
import { requireSession } from '@/lib/http/session';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';
import { createChannelAction } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.channels.metaTitle };
}

const FIELD = 'h-10 w-full rounded-md border border-line bg-field px-3 text-[13px] text-ink placeholder:text-ink/40';

/**
 * The workspace's channels and the form that opens one
 * (agent-first-proposal.md 6.1, 4.4). A channel is public by default; assets
 * are moved in from each channel's page or from an asset's own page.
 */
export default async function ChannelsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [session, { locale, t }, query] = await Promise.all([
    requireSession('/dashboard/channels'),
    translations(),
    searchParams,
  ]);
  const c = t.dashboard.channels;
  const channels = await listWorkspaceChannels(session.workspace.id);
  const canEdit = canManageLibraries(session.workspace.role);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const error = typeof query.error === 'string' ? query.error : null;
  const notice = typeof query.notice === 'string' ? query.notice : null;

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader eyebrow={session.workspace.name} title={c.title} description={c.description} />

      {notice === 'deleted' ? <p role="status" className="text-[12px] text-brandink">{c.notices.deleted}</p> : null}

      {canEdit ? (
        <form action={createChannelAction} className={`${PANEL} flex flex-col gap-4 p-6`}>
          <div className="flex flex-col gap-1">
            <h2 className="text-[15px] font-medium text-ink">{c.create.title}</h2>
            <p className="text-[12px] leading-[1.5] text-muted">{c.create.description}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-steel">{c.fields.title}</span>
              <input name="title" required maxLength={CHANNEL_TITLE_MAX_LENGTH} className={FIELD} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-steel">{c.fields.slug}</span>
              <span className="flex items-center gap-1 rounded-md border border-line bg-field pl-3">
                <span className="text-[12px] text-muted">/channels/</span>
                <input
                  name="slug"
                  required
                  minLength={3}
                  maxLength={48}
                  pattern="[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,47}"
                  className="h-10 min-w-0 flex-1 bg-transparent pr-3 text-[13px] text-ink focus:outline-none"
                />
              </span>
              <span className="text-[10.5px] text-muted">{c.fields.slugHint}</span>
            </label>
            <label className="flex flex-col gap-1.5 sm:col-span-2">
              <span className="text-[11px] font-medium text-steel">{c.fields.description}</span>
              <input name="description" maxLength={CHANNEL_DESCRIPTION_MAX_LENGTH} className={FIELD} />
            </label>
            <fieldset className="flex flex-col gap-2 sm:col-span-2">
              <legend className="pb-1.5 text-[11px] font-medium text-steel">{c.fields.visibility}</legend>
              <label className="flex items-start gap-2 text-[12.5px] text-ink">
                <input type="radio" name="visibility" value="public" defaultChecked className="mt-[3px]" />
                <span>
                  {c.public}
                  <span className="block text-[11px] text-muted">{c.fields.publicNote}</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-[12.5px] text-ink">
                <input type="radio" name="visibility" value="private" className="mt-[3px]" />
                <span>
                  {c.private}
                  <span className="block text-[11px] text-muted">{c.fields.privateNote}</span>
                </span>
              </label>
            </fieldset>
          </div>
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <span className="text-[12px] text-rose">
              {error ? ((c.errors as Record<string, string>)[error] ?? c.errors.unavailable) : null}
            </span>
            <button type="submit" className="inline-flex h-10 items-center rounded-md bg-brand px-4 text-[12px] font-medium text-onbrand hover:bg-brand/90">
              {c.create.submit}
            </button>
          </footer>
        </form>
      ) : null}

      <section className={`${PANEL} p-0.5`}>
        <div className="px-5 py-4">
          <h2 className="text-[15px] font-medium text-ink">{c.listTitle}</h2>
        </div>
        {channels.length === 0 ? (
          <p className="px-5 pb-6 text-[12.5px] text-muted">{c.empty}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line border-t border-line">
            {channels.map((channel) => {
              const isPublic = channel.visibility === 'public' && channel.status === 'active';
              return (
                <li key={channel.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                  <span className="flex min-w-0 flex-col gap-1">
                    <Link href={`/dashboard/channels/${channel.id}`} className="truncate text-[14px] font-medium text-ink hover:text-brandink">
                      {channel.title}
                    </Link>
                    <span className="truncate font-mono text-[11px] text-muted">/channels/{channel.slug}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-3 text-[11.5px] text-muted">
                    <Badge tone={channel.visibility === 'public' ? 'public' : 'private'}>
                      {channel.visibility === 'public' ? c.public : c.private}
                    </Badge>
                    {channel.status === 'suspended' ? <StatusLabel tone="blocked">{c.suspended}</StatusLabel> : null}
                    <span>{fill(c.assetCount, { count: String(channel.assetCount) })}</span>
                    <span>{date.format(new Date(channel.createdAt))}</span>
                    {isPublic ? (
                      <Link href={`/channels/${channel.slug}`} className="inline-flex items-center gap-1 text-brandink hover:underline">
                        {c.viewPublic}
                        <ArrowUpRightIcon size={12} />
                      </Link>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
