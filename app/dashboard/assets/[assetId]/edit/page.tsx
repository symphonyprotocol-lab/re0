import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MarkdownEditor } from '@/components/creator/markdown-editor';
import { AudioUpload } from '@/components/creator/media-upload';
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
const PRIMARY = 'inline-flex h-9 items-center rounded-md bg-brand px-4 text-[12px] font-medium text-onbrand hover:bg-brand/90';
const SECONDARY = 'inline-flex h-9 items-center rounded-md border border-line bg-card px-3.5 text-[12px] font-medium text-steel hover:bg-subtle';
const LABEL = 'text-[11px] font-medium text-steel';

/** The `datetime-local` value of an instant, in UTC (the page says so). */
function localValue(date: Date | null): string {
  return date ? date.toISOString().slice(0, 16) : '';
}

/**
 * One article or episode in the editor (agent-first-proposal.md 6.5, 6.6),
 * a focused page without the workspace rail (components/dashboard/columns.tsx):
 * a header with the way back, where it lives and the two main buttons; a
 * strip with where it publishes, at what access and when; then the title
 * and the Markdown editor with its preview (components/creator/markdown-editor.tsx).
 * The whole page is one form, so every button posts the same fields.
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
    <form action={saveEditorialAction} className="flex flex-col gap-4">
      <input type="hidden" name="assetId" value={draft.asset.id} />
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-[5px]">
          <BackLink href="/dashboard/assets">{c.back}</BackLink>
          <h1 className="mt-1.5 truncate text-[22px] leading-[1.5] font-medium text-ink">{draft.title}</h1>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
            <span className="font-mono">{draft.asset.publicId}</span>
            <span>{version ? fill(c.live, { label: version.label }) : c.notLive}</span>
            {draft.publishAt ? <span className="text-brandink">{fill(c.scheduledFor, { date: `${date.format(draft.publishAt)} UTC` })}</span> : null}
            <Link href={`/assets${draft.asset.publicId}`} className="inline-flex items-center gap-1 text-brandink hover:underline">
              {c.view}
              <ArrowUpRightIcon size={12} />
            </Link>
          </p>
        </div>
        {canEdit ? (
          <div className="flex shrink-0 items-center gap-2">
            <button type="submit" name="intent" value="save" className={SECONDARY}>
              {c.save}
            </button>
            <button type="submit" name="intent" value="publish" className={PRIMARY}>
              {c.publish}
            </button>
          </div>
        ) : null}
      </header>
      {message ? (
        <p role="status" className={`text-[12.5px] ${good ? 'text-brandink' : 'text-rose'}`}>
          {message}
        </p>
      ) : null}

      <section className={`${PANEL} grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)]`}>
        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>{c.channelLabel}</span>
          <select name="channelId" defaultValue={draft.channelId ?? ''} className={`${FIELD} h-9`}>
            <option value="">{c.noChannel}</option>
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {selling.has(channel.id) ? `${channel.title} · ${c.sells}` : channel.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>{c.accessLabel}</span>
          <select name="access" defaultValue={draft.access} className={`${FIELD} h-9`}>
            <option value="free">{c.free}</option>
            {selling.size > 0 || draft.access === 'paid' ? <option value="paid">{c.paid}</option> : null}
          </select>
          <span className="text-[11px] text-muted">{c.paidHint}</span>
        </label>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="editor-publish-at" className={LABEL}>
            {c.scheduleLabel} (UTC)
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id="editor-publish-at"
              type="datetime-local"
              name="publishAt"
              defaultValue={localValue(draft.publishAt)}
              className="h-9 min-w-[180px] flex-1 rounded-md border border-line bg-field px-3 text-[13px] text-ink"
            />
            {canEdit ? (
              <button type="submit" name="intent" value="schedule" className={SECONDARY}>
                {c.schedule}
              </button>
            ) : null}
            {canEdit && draft.publishAt ? (
              <button type="submit" name="intent" value="unschedule" className={SECONDARY}>
                {c.unschedule}
              </button>
            ) : null}
          </div>
        </div>
      </section>

      {isAudio && canEdit ? (
        <section className={`${PANEL} flex flex-col gap-2 p-4`}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[13px] font-medium text-ink">{c.audio.title}</h2>
            <span className="text-[12px] text-steel">{draft.audio ? fill(c.audio.current, { size: formatBytes(draft.audio.bytes) }) : c.audio.none}</span>
          </div>
          <p className="text-[12px] leading-[1.5] text-muted">{c.audio.body}</p>
          <AudioUpload
            assetId={draft.asset.id}
            accept={Object.keys(AUDIO_TYPES).join(',')}
            prepare={prepareMediaAction}
            confirm={confirmMediaAction}
            labels={c.audio}
            errors={errors}
          />
        </section>
      ) : null}

      <section className={`${PANEL} overflow-hidden`}>
        <div className="flex flex-col gap-1 px-6 pt-5 pb-4">
          <input
            name="title"
            required
            maxLength={EDITORIAL_LIMITS.titleMax}
            defaultValue={draft.title}
            aria-label={c.titleLabel}
            placeholder={c.titleLabel}
            className="w-full bg-transparent text-[22px] leading-[1.4] font-medium text-ink outline-none placeholder:text-muted"
          />
          {!isAudio ? (
            <input
              name="summary"
              maxLength={EDITORIAL_LIMITS.summaryMax}
              defaultValue={draft.summary ?? ''}
              aria-label={c.summaryLabel}
              placeholder={c.summaryLabel}
              className="w-full bg-transparent text-[13.5px] leading-[1.6] text-steel outline-none placeholder:text-muted"
            />
          ) : (
            <input type="hidden" name="summary" value={draft.summary ?? ''} />
          )}
        </div>
        <MarkdownEditor
          name="body"
          label={isAudio ? c.notesLabel : c.bodyLabel}
          defaultValue={draft.body}
          maxLength={isAudio ? EDITORIAL_LIMITS.notesMax : EDITORIAL_LIMITS.bodyMax}
          tall={!isAudio}
          assetId={draft.asset.id}
          images={canEdit && !isAudio ? { accept: Object.keys(IMAGE_TYPES).join(','), prepare: prepareMediaAction, confirm: confirmMediaAction } : null}
          labels={c.markdown}
          errors={errors}
          hint={isAudio ? c.notesHint : fill(c.bodyHint, { size: formatBytes(EDITORIAL_LIMITS.imageMaxBytes) })}
        />
      </section>
    </form>
  );
}
