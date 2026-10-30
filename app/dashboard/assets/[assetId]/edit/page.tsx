import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MediaUpload } from '@/components/creator/media-upload';
import { formatBytes } from '@/components/creator/format';
import { BackLink, PANEL } from '@/components/dashboard/ui';
import { ArrowUpRightIcon } from '@/components/ui/icons';
import { listWorkspaceChannels } from '@/lib/application/channels';
import { readEditorialDraft } from '@/lib/application/editorial';
import { canManageAssets } from '@/lib/application/assets';
import { AUDIO_TYPES, EDITORIAL_LIMITS, EditorialRefused, IMAGE_TYPES } from '@/lib/domain/editorial';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { requireSession } from '@/lib/http/session';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';
import { and, eq, isNotNull } from 'drizzle-orm';
import { confirmMediaAction, prepareMediaAction, saveEditorialAction } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).creator.dashboard.editor.metaTitle };
}

const FIELD = 'w-full rounded-md border border-line bg-field px-3 text-[13px] text-ink';
const PRIMARY = 'inline-flex h-10 items-center rounded-md bg-brand px-4 text-[12px] font-medium text-onbrand hover:bg-brand/90';
const SECONDARY = 'inline-flex h-10 items-center rounded-md border border-line bg-card px-4 text-[12px] font-medium text-steel hover:bg-subtle';

/** The `datetime-local` value of an instant, in UTC (the page says so). */
function localValue(date: Date | null): string {
  return date ? date.toISOString().slice(0, 16) : '';
}

/**
 * One article or episode in the editor (agent-first-proposal.md 6.5, 6.6):
 * the draft, where it publishes and at what access, the images or the
 * episode file, and the three ways to leave -- save, publish now, schedule.
 * Publishing is this click; the Agent cannot do it (proposal 5.1). Reached
 * from the asset list, from the wizard that created the draft, and from the
 * asset detail page, which sends these two kinds here.
 */
export default async function EditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ assetId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ assetId }, query] = await Promise.all([params, searchParams]);
  const [session, { locale, t }] = await Promise.all([requireSession(`/dashboard/assets/${assetId}/edit`), translations()]);
  const draft = await readEditorialDraft(session.workspace.id, assetId).catch((error: unknown) => {
    if (error instanceof EditorialRefused && error.code === 'not_found') return null;
    throw error;
  });
  if (!draft) notFound();
  const c = t.creator.dashboard.editor;
  const errors = t.creator.errors as Record<string, string>;
  const [channels, sellingRows] = await Promise.all([
    listWorkspaceChannels(session.workspace.id),
    db()
      .select({ id: schema.channel.id })
      .from(schema.channel)
      .where(and(eq(schema.channel.workspaceId, session.workspace.id), isNotNull(schema.channel.subscriptionsEnabledAt))),
  ]);
  /* `paid` is offered only where it can hold: a channel that sells (proposal 6.2); saving and publishing refuse it elsewhere. */
  const selling = new Set(sellingRows.map((row) => row.id));
  const canEdit = canManageAssets(session.workspace.role);
  const isAudio = draft.asset.kind === 'audio';
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  const [version] = draft.asset.currentVersionId
    ? await db().select({ label: schema.assetVersion.label }).from(schema.assetVersion).where(eq(schema.assetVersion.id, draft.asset.currentVersionId))
    : [];
  const notice = typeof query.notice === 'string' ? query.notice : null;
  const good = notice !== null && notice in c.notices;
  const message = notice === null ? null : ((c.notices as Record<string, string>)[notice] ?? errors[notice] ?? errors.unavailable);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-[5px]">
        <BackLink href="/dashboard/assets">{c.back}</BackLink>
        <h1 className="mt-1.5 truncate text-[25px] leading-[1.5] font-medium text-ink">{draft.title}</h1>
        <p className="flex flex-wrap items-center gap-3 text-[12.5px] text-muted">
          <span className="font-mono">{draft.asset.publicId}</span>
          <span>{version ? fill(c.live, { label: version.label }) : c.notLive}</span>
          {draft.publishAt ? <span className="text-brandink">{fill(c.scheduledFor, { date: `${date.format(draft.publishAt)} UTC` })}</span> : null}
          <Link href={`/assets${draft.asset.publicId}`} className="inline-flex items-center gap-1 text-brandink hover:underline">
            {c.view}
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
        <form action={saveEditorialAction} className={`${PANEL} flex flex-col gap-4 p-6`}>
          <input type="hidden" name="assetId" value={draft.asset.id} />
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-steel">{c.titleLabel}</span>
            <input name="title" required maxLength={EDITORIAL_LIMITS.titleMax} defaultValue={draft.title} className={`${FIELD} h-10`} />
          </label>
          {!isAudio ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-steel">{c.summaryLabel}</span>
              <input name="summary" maxLength={EDITORIAL_LIMITS.summaryMax} defaultValue={draft.summary ?? ''} className={`${FIELD} h-10`} />
            </label>
          ) : (
            <input type="hidden" name="summary" value={draft.summary ?? ''} />
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-steel">{isAudio ? c.notesLabel : c.bodyLabel}</span>
            <textarea
              id="editor-body"
              name="body"
              rows={isAudio ? 10 : 22}
              maxLength={isAudio ? EDITORIAL_LIMITS.notesMax : EDITORIAL_LIMITS.bodyMax}
              defaultValue={draft.body}
              className={`${FIELD} py-2.5 font-mono leading-[1.6]`}
            />
            <span className="text-[11px] text-muted">{isAudio ? c.notesHint : c.bodyHint}</span>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-steel">{c.channelLabel}</span>
              <select name="channelId" defaultValue={draft.channelId ?? ''} className={`${FIELD} h-10`}>
                <option value="">{c.noChannel}</option>
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {selling.has(channel.id) ? `${channel.title} · ${c.sells}` : channel.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-steel">{c.accessLabel}</span>
              <select name="access" defaultValue={draft.access} className={`${FIELD} h-10`}>
                <option value="free">{c.free}</option>
                {selling.size > 0 || draft.access === 'paid' ? <option value="paid">{c.paid}</option> : null}
              </select>
              <span className="text-[11px] text-muted">{c.paidHint}</span>
            </label>
          </div>
          {canEdit ? (
            <footer className="flex flex-wrap items-end gap-3 border-t border-line pt-4">
              <button type="submit" name="intent" value="save" className={SECONDARY}>
                {c.save}
              </button>
              <button type="submit" name="intent" value="publish" className={PRIMARY}>
                {c.publish}
              </button>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-steel">{c.scheduleLabel} (UTC)</span>
                <input type="datetime-local" name="publishAt" defaultValue={localValue(draft.publishAt)} className={`${FIELD} h-10`} />
              </label>
              <button type="submit" name="intent" value="schedule" className={SECONDARY}>
                {c.schedule}
              </button>
              {draft.publishAt ? (
                <button type="submit" name="intent" value="unschedule" className={SECONDARY}>
                  {c.unschedule}
                </button>
              ) : null}
            </footer>
          ) : null}
        </form>

        <aside className="flex flex-col gap-4">
          {canEdit ? (
            <section className={`${PANEL} flex flex-col gap-3 p-5`}>
              <h2 className="text-[14px] font-medium text-ink">{isAudio ? c.audio.title : c.images.title}</h2>
              <p className="text-[12px] leading-[1.5] text-muted">{isAudio ? c.audio.body : c.images.body}</p>
              {isAudio ? (
                <p className="text-[12px] text-steel">{draft.audio ? fill(c.audio.current, { size: formatBytes(draft.audio.bytes) }) : c.audio.none}</p>
              ) : null}
              <MediaUpload
                assetId={draft.asset.id}
                kind={isAudio ? 'audio' : 'image'}
                accept={Object.keys(isAudio ? AUDIO_TYPES : IMAGE_TYPES).join(',')}
                targetId="editor-body"
                prepare={prepareMediaAction}
                confirm={confirmMediaAction}
                labels={isAudio ? c.audio : c.images}
                errors={errors}
              />
              {!isAudio && draft.images.length > 0 ? (
                <ul className="flex flex-col gap-1.5 border-t border-line pt-3 text-[11.5px] text-steel">
                  {draft.images.map((image) => (
                    <li key={image.id} className="flex flex-col">
                      <code className="font-mono text-[10.5px] break-all text-muted">![{image.caption ?? ''}](media:{image.id})</code>
                      <span>{formatBytes(image.bytes)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
