import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CopyButton } from '@/components/dashboard/copy-button';
import { BackLink, Badge, PANEL, StatusLabel } from '@/components/dashboard/ui';
import { ArrowUpRightIcon, BotIcon } from '@/components/ui/icons';
import { ChannelCommercePanel } from '@/components/creator/channel-commerce-panel';
import { activeCommerceSettings } from '@/lib/application/administration/manage-commerce-config';
import { channelStream, ownedChannelView } from '@/lib/application/channels';
import { channelCommerce } from '@/lib/application/channels/subscriptions';
import { canManageAssets, listWorkspaceAssets } from '@/lib/application/assets';
import { CHANNEL_DESCRIPTION_MAX_LENGTH, CHANNEL_TITLE_MAX_LENGTH } from '@/lib/domain/channel';
import { requireSession } from '@/lib/http/session';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';
import { publicUrl } from '@/lib/site/origin';
import { addAssetAction, deleteChannelAction, editChannelAction, pinAssetAction, removeAssetAction } from '../actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.channels.metaTitle };
}

const FIELD = 'h-10 w-full rounded-md border border-line bg-field px-3 text-[13px] text-ink';
const SMALL_BUTTON =
  'inline-flex h-8 items-center rounded-md border border-line bg-card px-2.5 text-[11.5px] font-medium text-steel hover:bg-subtle';

/**
 * One channel, for its owner: edit it, see its card, manage the assets in
 * it, delete it (agent-first-proposal.md 6.1). Moving an asset in checks the
 * same things a move from the asset's own page does -- a public channel
 * needs a rights declaration that allows it and, for a website or
 * repository, proof of control. Selling it -- subscriptions, plans, paid
 * assets -- is the commerce panel (agent-first-proposal.md 6.9).
 */
export default async function ChannelDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ channelId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ channelId }, query] = await Promise.all([params, searchParams]);
  const [session, { locale, t }] = await Promise.all([
    requireSession(`/dashboard/channels/${channelId}`),
    translations(),
  ]);
  const channel = await ownedChannelView(session.workspace.id, channelId);
  if (!channel) notFound();
  const c = t.dashboard.channels;
  const kinds = t.channels.kinds as Record<string, string>;
  const canEdit = canManageAssets(session.workspace.role);
  const [stream, assets, commerce, commerceSettings] = await Promise.all([
    channelStream(channel),
    listWorkspaceAssets(session.workspace.id),
    channelCommerce(channel.id),
    activeCommerceSettings(),
  ]);
  const candidates = assets.filter((asset) => asset.channel?.id !== channel.id && asset.lifecycleStatus !== 'archived');
  const notice = typeof query.notice === 'string' ? query.notice : null;
  const good = notice !== null && ['created', 'saved', 'added', 'removed', 'pinned', 'unpinned'].includes(notice);
  const message =
    notice === null
      ? null
      : ((c.notices as Record<string, string>)[notice] ?? (c.errors as Record<string, string>)[notice] ?? c.errors.unavailable);
  const cardUrl = publicUrl(`/a2a/channels/${channel.slug}/agent-card.json`);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-[5px]">
        <BackLink href="/dashboard/channels">{c.back}</BackLink>
        <h1 className="mt-1.5 truncate text-[25px] leading-[1.5] font-medium text-ink">{channel.title}</h1>
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
          <span className="font-mono">/channels/{channel.slug}</span>
          <Badge tone={channel.visibility === 'public' ? 'public' : 'private'}>
            {channel.visibility === 'public' ? c.public : c.private}
          </Badge>
          {channel.status === 'suspended' ? <StatusLabel tone="blocked">{c.suspended}</StatusLabel> : null}
          <Link href={`/channels/${channel.slug}`} className="inline-flex items-center gap-1 text-[12px] text-brandink hover:underline">
            {c.viewPublic}
            <ArrowUpRightIcon size={12} />
          </Link>
        </p>
      </header>

      {message ? (
        <p role="status" className={`text-[12.5px] ${good ? 'text-brandink' : 'text-rose'}`}>
          {message}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-4">
          <section id="assets" className={`${PANEL} flex flex-col gap-4 p-6`}>
            <div className="flex flex-col gap-1">
              <h2 className="text-[15px] font-medium text-ink">{c.assets.title}</h2>
              <p className="text-[12px] leading-[1.5] text-muted">{c.assets.description}</p>
            </div>
            {stream.length === 0 ? (
              <p className="text-[12.5px] text-muted">{c.assets.empty}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
                {stream.map((item) => (
                  <li key={item.assetId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <Link href={`/dashboard/assets/${item.assetId}`} className="truncate text-[13px] font-medium text-ink hover:text-brandink">
                        {item.title}
                      </Link>
                      <span className="flex flex-wrap gap-2 text-[11px] text-muted">
                        <span className="font-mono">{item.publicId}</span>
                        <span>{kinds[item.kind] ?? item.kind}</span>
                        <span>{item.access === 'paid' ? c.assets.paid : c.assets.free}</span>
                        {item.pinned ? <span className="text-brandink">{c.assets.pinned}</span> : null}
                        {!item.live ? <span>{c.assets.notLive}</span> : null}
                        <span>{fill(c.assets.added, { date: date.format(new Date(item.publishedAt)) })}</span>
                      </span>
                    </span>
                    {canEdit ? (
                      <span className="flex items-center gap-2">
                        <form action={pinAssetAction}>
                          <input type="hidden" name="channelId" value={channel.id} />
                          <input type="hidden" name="assetId" value={item.assetId} />
                          <input type="hidden" name="pinned" value={item.pinned ? 'no' : 'yes'} />
                          <button type="submit" className={SMALL_BUTTON}>
                            {item.pinned ? c.assets.unpin : c.assets.pin}
                          </button>
                        </form>
                        <form action={removeAssetAction}>
                          <input type="hidden" name="channelId" value={channel.id} />
                          <input type="hidden" name="assetId" value={item.assetId} />
                          <button type="submit" className={SMALL_BUTTON}>
                            {c.assets.remove}
                          </button>
                        </form>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {canEdit && channel.status === 'active' ? (
              candidates.length === 0 ? (
                <p className="text-[12px] text-muted">
                  {c.assets.noCandidates}{' '}
                  <Link href="/dashboard/assets/new" className="text-brandink hover:underline">
                    {c.assets.createAsset}
                  </Link>
                </p>
              ) : (
                <form action={addAssetAction} className="flex flex-wrap items-end gap-3 border-t border-line pt-4">
                  <input type="hidden" name="channelId" value={channel.id} />
                  <label className="flex min-w-[240px] flex-1 flex-col gap-1.5">
                    <span className="text-[11px] font-medium text-steel">{c.assets.addLabel}</span>
                    <select name="assetId" required className={FIELD} defaultValue="">
                      <option value="" disabled>
                        {c.assets.choose}
                      </option>
                      {candidates.map((asset) => (
                        <option key={asset.id} value={asset.id}>
                          {asset.channel ? fill(c.assets.fromChannel, { title: asset.title, channel: asset.channel.title }) : asset.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="submit" className="inline-flex h-10 items-center rounded-md bg-brand px-4 text-[12px] font-medium text-onbrand hover:bg-brand/90">
                    {c.assets.add}
                  </button>
                  <p className="w-full text-[11px] leading-[1.5] text-muted">
                    {channel.visibility === 'public' ? c.assets.publicNote : c.assets.privateNote}
                  </p>
                </form>
              )
            ) : null}
          </section>

          {canEdit && channel.workspaceId ? (
            <ChannelCommercePanel
              channelId={channel.id}
              commerce={commerce}
              stream={stream}
              settings={commerceSettings}
              notice={typeof query.commerce === 'string' ? query.commerce : null}
              t={t}
              locale={locale}
            />
          ) : null}

          {canEdit ? (
            <form action={editChannelAction} className={`${PANEL} flex flex-col gap-4 p-6`}>
              <input type="hidden" name="channelId" value={channel.id} />
              <h2 className="text-[15px] font-medium text-ink">{c.edit.title}</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-medium text-steel">{c.fields.title}</span>
                  <input name="title" required maxLength={CHANNEL_TITLE_MAX_LENGTH} defaultValue={channel.title} className={FIELD} />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-medium text-steel">{c.fields.visibility}</span>
                  <select name="visibility" defaultValue={channel.visibility} className={FIELD}>
                    <option value="public">{c.public}</option>
                    <option value="private">{c.private}</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1.5 sm:col-span-2">
                  <span className="text-[11px] font-medium text-steel">{c.fields.description}</span>
                  <input
                    name="description"
                    maxLength={CHANNEL_DESCRIPTION_MAX_LENGTH}
                    defaultValue={channel.description ?? ''}
                    className={FIELD}
                  />
                </label>
              </div>
              <p className="text-[11px] leading-[1.5] text-muted">{c.edit.visibilityNote}</p>
              <footer className="flex justify-end border-t border-line pt-4">
                <button type="submit" className="inline-flex h-10 items-center rounded-md bg-brand px-4 text-[12px] font-medium text-onbrand hover:bg-brand/90">
                  {c.edit.submit}
                </button>
              </footer>
            </form>
          ) : null}
        </div>

        <aside className="flex flex-col gap-4">
          <section className={`${PANEL} flex flex-col gap-3 p-5`}>
            <h2 className="flex items-center gap-2 text-[14px] font-medium text-ink">
              <BotIcon size={15} className="text-brandink" />
              {c.card.title}
            </h2>
            {channel.isPublic ? (
              <>
                <p className="text-[12px] leading-[1.5] text-muted">{c.card.body}</p>
                <span className="flex items-center gap-2 rounded-md border border-line bg-subtle py-1 pr-1 pl-3">
                  <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">{cardUrl}</code>
                  <CopyButton value={cardUrl} label={c.card.title} className="text-steel hover:bg-card" />
                </span>
              </>
            ) : (
              <p className="text-[12px] leading-[1.5] text-muted">{c.card.none}</p>
            )}
          </section>

          {canEdit ? (
            <form id="delete" action={deleteChannelAction} className={`${PANEL} flex flex-col gap-3 p-5`}>
              <input type="hidden" name="channelId" value={channel.id} />
              <h2 className="text-[14px] font-medium text-ink">{c.delete.title}</h2>
              <p className="text-[12px] leading-[1.5] text-muted">{c.delete.body}</p>
              <label className="flex items-center gap-2 text-[12px] text-ink">
                <input type="checkbox" name="confirm" value="yes" required />
                {c.delete.confirm}
              </label>
              <button type="submit" className="inline-flex h-9 w-fit items-center rounded-md border border-rose/40 px-3 text-[12px] font-medium text-rose hover:bg-rose/5">
                {c.delete.submit}
              </button>
            </form>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
