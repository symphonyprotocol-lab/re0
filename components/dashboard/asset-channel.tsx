import Link from 'next/link';
import { PANEL, Badge } from '@/components/dashboard/ui';
import type { ChannelRef, WorkspaceChannel } from '@/lib/application/channels';
import { getMessages } from '@/lib/i18n/server';
import { fill } from '@/lib/i18n/format';

/**
 * Which channel an asset is in, and the form that moves it
 * (agent-first-proposal.md 6.1, 6.2). An asset is in no channel -- its
 * owner's alone -- or in exactly one; moving it into a public channel shows
 * it to everyone, and any move resets it to free. A plain form post, so the
 * outcome comes back on the URL (`notice`) and works without script.
 */
export async function AssetChannelPanel({
  libraryId,
  current,
  channels,
  canEdit,
  notice,
  action,
}: {
  libraryId: string;
  current: ChannelRef | null;
  channels: WorkspaceChannel[];
  canEdit: boolean;
  /** `moved`, or the refusal code the last move came back with. */
  notice: string | null;
  action: (form: FormData) => Promise<void>;
}) {
  const c = (await getMessages()).dashboard.libraryDetail.channel;
  const isPublic = current?.visibility === 'public' && current.status === 'active';
  const message =
    notice === null ? null : notice === 'moved' ? c.moved : ((c.errors as Record<string, string>)[notice] ?? c.errors.unavailable);

  return (
    <section id="channel" className={`${PANEL} flex flex-col gap-4 p-6`}>
      <div className="flex flex-col gap-1">
        <h2 className="text-[15px] font-medium text-ink">{c.title}</h2>
        <p className="text-[12px] leading-[1.5] text-muted">{c.description}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink">
        {current ? (
          <>
            <Link href={`/dashboard/channels/${current.id}`} className="font-medium hover:underline">
              {current.title}
            </Link>
            <Badge tone={isPublic ? 'public' : 'private'}>{isPublic ? c.public : c.private}</Badge>
            {isPublic ? (
              <Link href={`/channels/${current.slug}`} className="text-[12px] text-brandink hover:underline">
                {c.viewPublic}
              </Link>
            ) : null}
          </>
        ) : (
          <span className="text-muted">{c.none}</span>
        )}
      </div>

      {message ? (
        <p role="status" className={`text-[12px] ${notice === 'moved' ? 'text-brandink' : 'text-rose'}`}>
          {message}
        </p>
      ) : null}

      {canEdit ? (
        channels.length === 0 ? (
          <p className="text-[12px] text-muted">
            {c.noChannels}{' '}
            <Link href="/dashboard/channels" className="text-brandink hover:underline">
              {c.createChannel}
            </Link>
          </p>
        ) : (
          <form action={action} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="libraryId" value={libraryId} />
            <label className="flex min-w-[240px] flex-1 flex-col gap-1.5">
              <span className="text-[11px] font-medium text-steel">{c.moveLabel}</span>
              <select
                name="channelId"
                defaultValue={current?.id ?? ''}
                className="h-10 rounded-md border border-line bg-field px-3 text-[13px] text-ink"
              >
                <option value="">{c.noneOption}</option>
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id} disabled={channel.status === 'suspended'}>
                    {fill(channel.visibility === 'public' ? c.optionPublic : c.optionPrivate, { title: channel.title })}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="inline-flex h-10 items-center rounded-md bg-brand px-4 text-[12px] font-medium text-onbrand hover:bg-brand/90"
            >
              {c.move}
            </button>
            <p className="w-full text-[11px] leading-[1.5] text-muted">{c.moveNote}</p>
          </form>
        )
      ) : null}
    </section>
  );
}
