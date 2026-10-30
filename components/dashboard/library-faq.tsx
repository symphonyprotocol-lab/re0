'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';
import { submitOn } from '@/components/admin/platform-library-shared';
import { AREA, FIELD, Field, PRIMARY, ResultLine, SECONDARY } from '@/components/dashboard/library-manage';
import { Badge, PANEL } from '@/components/dashboard/ui';
import { PencilIcon, PlusIcon, TrashIcon } from '@/components/ui/icons';
import type { FaqActionResult } from '@/app/dashboard/assets/[libraryId]/actions';
import type { FaqEntryView, FaqGroupView } from '@/lib/application/embed';
import { FAQ_LIMITS } from '@/lib/domain/faq';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';

/**
 * The FAQ loop on a library's page (lib/domain/faq.ts): what visitors keep
 * asking, grouped; the entries the owner wrote from them; and the forms
 * that turn one into the other. Saving or removing an entry queues a
 * rebuild, which the action starts -- the panel says so, because a FAQ
 * entry only answers once the build that holds it has published.
 */

type FaqAction = (previous: FaqActionResult | null, form: FormData) => Promise<FaqActionResult>;

const GROUPS_SHOWN = 12;

function errorText(errors: Record<string, string>, error: FaqActionResult['error']): string {
  return (error && errors[error]) || errors.unavailable || '';
}

function EntryForm({
  libraryId,
  initial,
  pages,
  action,
  onDone,
  onCancel,
}: {
  libraryId: string;
  initial: { entryId?: string; question: string; answer: string; pageUrl: string };
  /** Pages the visitor's answers cited, offered for the entry's page. */
  pages: { url: string; title: string }[];
  action: FaqAction;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const f = t.dashboard.libraryDetail.faq;
  const [state, dispatch, pending] = useActionState(action, null);
  const [pageUrl, setPageUrl] = useState(initial.pageUrl);

  useEffect(() => {
    if (state?.ok) onDone();
  }, [state, onDone]);

  return (
    <form onSubmit={submitOn(dispatch)} className="flex flex-col gap-3 rounded-md border border-line bg-subtle/60 p-4">
      <input type="hidden" name="libraryId" value={libraryId} />
      {initial.entryId ? <input type="hidden" name="entryId" value={initial.entryId} /> : null}
      <Field label={f.form.question}>
        <input name="question" required maxLength={FAQ_LIMITS.questionChars} defaultValue={initial.question} className={FIELD} />
      </Field>
      <Field label={f.form.answer} hint={f.form.answerHint}>
        <textarea name="answer" required maxLength={FAQ_LIMITS.answerChars} defaultValue={initial.answer} rows={5} className={AREA} />
      </Field>
      <Field label={f.form.page} hint={f.form.pageHint}>
        {pages.length > 0 ? (
          <select
            value={pages.some((page) => page.url === pageUrl) ? pageUrl : ''}
            onChange={(event) => setPageUrl(event.target.value)}
            className={`${FIELD} mb-2`}
          >
            <option value="">{f.form.pageOther}</option>
            {pages.map((page) => (
              <option key={page.url} value={page.url}>
                {page.title} · {page.url}
              </option>
            ))}
          </select>
        ) : null}
        <input
          name="pageUrl"
          required
          type="url"
          value={pageUrl}
          onChange={(event) => setPageUrl(event.target.value)}
          placeholder="https://www.example.com/pricing"
          className={FIELD}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={PRIMARY}>
          {f.form.save}
        </button>
        <button type="button" onClick={onCancel} className={SECONDARY}>
          {f.form.cancel}
        </button>
        {state && !state.ok ? <ResultLine ok={false}>{errorText(f.errors, state.error)}</ResultLine> : null}
      </div>
    </form>
  );
}

export function LibraryFaqPanel({
  libraryId,
  groups,
  entries,
  canEdit,
  saveAction,
  deleteAction,
}: {
  libraryId: string;
  groups: FaqGroupView[];
  entries: FaqEntryView[];
  canEdit: boolean;
  saveAction: FaqAction;
  deleteAction: FaqAction;
}) {
  const { t, locale } = useI18n();
  const f = t.dashboard.libraryDetail.faq;
  const router = useRouter();
  const number = new Intl.NumberFormat(locale);
  /** Which group's form is open, by its representative question; or 'new'; or an entry id. */
  const [editing, setEditing] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [removed, removeDispatch, removing] = useActionState(deleteAction, null);

  useEffect(() => {
    if (removed?.ok) router.refresh();
  }, [removed, router]);

  const done = () => {
    setEditing(null);
    setSaved(true);
    router.refresh();
  };

  return (
    <section id="faq" className={`${PANEL} flex scroll-mt-4 flex-col gap-4 p-6`}>
      <div className="flex flex-col gap-1">
        <h2 className="text-[15px] font-medium text-ink">{f.title}</h2>
        <p className="text-[11px] leading-[1.6] text-muted">{f.description}</p>
      </div>

      {saved ? <ResultLine ok>{f.saved}</ResultLine> : null}

      {/* What visitors keep asking. */}
      <div className="flex flex-col gap-2">
        <p className="text-[12px] font-medium text-steel">{f.groupsTitle}</p>
        {groups.length === 0 ? (
          <p className="text-[12px] text-muted">{f.groupsEmpty}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
            {groups.slice(0, GROUPS_SHOWN).map((group) => (
              <li key={group.question} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="text-[13px] text-ink">{group.question}</p>
                    <p className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                      <span>{fill(f.asked, { n: number.format(group.count) })}</span>
                      {group.unanswered > 0 ? (
                        <span className="text-amber">{fill(f.unanswered, { n: number.format(group.unanswered) })}</span>
                      ) : null}
                      {group.pages[0] ? (
                        <a href={group.pages[0].url} target="_blank" rel="noreferrer" className="truncate text-brandink">
                          {group.pages[0].title}
                        </a>
                      ) : null}
                      {group.covered ? <Badge tone="brand">{f.covered}</Badge> : null}
                    </p>
                  </div>
                  {canEdit && editing !== group.question ? (
                    <button type="button" className={SECONDARY} onClick={() => setEditing(group.question)}>
                      <PlusIcon size={13} />
                      {f.makeEntry}
                    </button>
                  ) : null}
                </div>
                {editing === group.question ? (
                  <EntryForm
                    libraryId={libraryId}
                    initial={{
                      question: group.question,
                      answer: group.sampleAnswer ?? '',
                      pageUrl: group.pages[0]?.url ?? '',
                    }}
                    pages={group.pages}
                    action={saveAction}
                    onDone={done}
                    onCancel={() => setEditing(null)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* The entries the owner wrote. */}
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[12px] font-medium text-steel">
            {fill(f.entriesTitle, { n: number.format(entries.length), max: number.format(FAQ_LIMITS.maxEntries) })}
          </p>
          {canEdit && editing !== 'new' && entries.length < FAQ_LIMITS.maxEntries ? (
            <button type="button" className={SECONDARY} onClick={() => setEditing('new')}>
              <PlusIcon size={13} />
              {f.addEntry}
            </button>
          ) : null}
        </div>
        {editing === 'new' ? (
          <EntryForm
            libraryId={libraryId}
            initial={{ question: '', answer: '', pageUrl: '' }}
            pages={[]}
            action={saveAction}
            onDone={done}
            onCancel={() => setEditing(null)}
          />
        ) : null}
        {entries.length === 0 && editing !== 'new' ? (
          <p className="text-[12px] text-muted">{f.entriesEmpty}</p>
        ) : null}
        {entries.map((entry) => (
          <article key={entry.id} className="flex flex-col gap-2 rounded-md border border-line bg-subtle/60 p-4">
            {editing === entry.id ? (
              <EntryForm
                libraryId={libraryId}
                initial={{ entryId: entry.id, question: entry.question, answer: entry.answer, pageUrl: entry.pageUrl }}
                pages={[]}
                action={saveAction}
                onDone={done}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="text-[13px] font-medium text-ink">{entry.question}</p>
                    <p className="whitespace-pre-wrap text-[12px] leading-[1.6] text-steel">{entry.answer}</p>
                    <a href={entry.pageUrl} target="_blank" rel="noreferrer" className="break-all text-[11px] text-brandink">
                      {entry.pageUrl}
                    </a>
                  </div>
                  {canEdit ? (
                    <div className="flex items-center gap-2">
                      <button type="button" className={SECONDARY} onClick={() => setEditing(entry.id)}>
                        <PencilIcon size={13} />
                        {f.edit}
                      </button>
                      <form
                        onSubmit={(event) => {
                          if (!window.confirm(f.removeConfirm)) {
                            event.preventDefault();
                            return;
                          }
                          submitOn(removeDispatch)(event);
                        }}
                      >
                        <input type="hidden" name="libraryId" value={libraryId} />
                        <input type="hidden" name="entryId" value={entry.id} />
                        <button type="submit" disabled={removing} className={`${SECONDARY} text-rose`}>
                          <TrashIcon size={13} />
                          {f.remove}
                        </button>
                      </form>
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </article>
        ))}
        {removed && !removed.ok ? <ResultLine ok={false}>{errorText(f.errors, removed.error)}</ResultLine> : null}
      </div>

      <p className="text-[11px] leading-[1.6] text-muted">{f.rebuildNote}</p>
    </section>
  );
}
