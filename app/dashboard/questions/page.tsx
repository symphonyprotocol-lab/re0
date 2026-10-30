import type { Metadata } from 'next';
import Link from 'next/link';
import { PANEL, PageHeader } from '@/components/dashboard/ui';
import { canManageAssets } from '@/lib/application/assets';
import { listQuestions, recentTwinAnswers } from '@/lib/application/questions';
import { AudioUpload } from '@/components/creator/media-upload';
import { AUDIO_TYPES, EDITORIAL_LIMITS } from '@/lib/domain/editorial';
import { confirmMediaAction, prepareMediaAction } from '../assets/[assetId]/edit/actions';
import { requireSession } from '@/lib/http/session';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';
import { answerQuestionAction, dismissQuestionAction, endorseAnswerAction } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).creator.dashboard.questions.metaTitle };
}

const FIELD = 'w-full rounded-md border border-line bg-field px-3 text-[13px] text-ink';
const SMALL = 'inline-flex h-9 items-center rounded-md border border-line bg-card px-3 text-[12px] font-medium text-steel hover:bg-subtle';
const PRIMARY = 'inline-flex h-9 items-center rounded-md bg-brand px-3.5 text-[12px] font-medium text-onbrand hover:bg-brand/90';

/**
 * 待答列表 (agent-first-proposal.md 6.7): what the twin could not answer,
 * what readers asked directly, and comments moved here. Below, the twin's
 * recent answers, each of which the creator may mark 作者确认.
 */
export default async function QuestionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, { locale, t }, query] = await Promise.all([requireSession('/dashboard/questions'), translations(), searchParams]);
  const c = t.creator.dashboard.questions;
  const errors = t.creator.errors as Record<string, string>;
  const canEdit = canManageAssets(session.workspace.role);
  const [open, answered, twin] = await Promise.all([
    listQuestions(session.workspace.id, { state: 'open' }),
    listQuestions(session.workspace.id, { state: 'answered' }),
    recentTwinAnswers(session.workspace.id),
  ]);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const notice = typeof query.notice === 'string' ? query.notice : null;
  const good = notice !== null && notice in c.notices;
  const message = notice === null ? null : ((c.notices as Record<string, string>)[notice] ?? errors[notice] ?? errors.unavailable);

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader eyebrow={session.workspace.name} title={c.title} description={c.description} />
      {message ? (
        <p role="status" className={`text-[12.5px] ${good ? 'text-brandink' : 'text-rose'}`}>
          {message}
        </p>
      ) : null}

      {open.length === 0 ? (
        <p className={`${PANEL} px-6 py-10 text-center text-[12.5px] text-muted`}>{c.empty}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {open.map((question) => (
            <li key={question.id} className={`${PANEL} flex flex-col gap-3 p-5`}>
              <p className="flex flex-wrap gap-2 text-[11px] text-muted">
                <span className="rounded-full bg-mutedbg px-2 py-0.5 text-steel">{c.sources[question.source]}</span>
                <span>{question.channelTitle}</span>
                <span>{question.askerName ? fill(c.askedBy, { name: question.askerName }) : c.anonymous}</span>
                <span>{date.format(question.createdAt)}</span>
              </p>
              <p className="text-[14px] leading-[1.6] whitespace-pre-wrap text-ink">{question.question}</p>
              {canEdit ? (
                <div className="flex flex-col gap-2">
                  <form action={answerQuestionAction} className="flex flex-col gap-2">
                    <input type="hidden" name="questionId" value={question.id} />
                    {/* A comment is never published (proposal 6.8): the creator restates it; any other question starts as asked. */}
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] font-medium text-steel">{c.questionLabel}</span>
                      <input
                        name="question"
                        required
                        maxLength={EDITORIAL_LIMITS.questionMax}
                        defaultValue={question.source === 'comment' ? '' : question.question}
                        className={`${FIELD} h-9`}
                      />
                      {question.source === 'comment' ? <span className="text-[11px] text-muted">{c.questionHint}</span> : null}
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] font-medium text-steel">{c.answerLabel}</span>
                      <textarea name="answer" required rows={4} maxLength={EDITORIAL_LIMITS.answerMax} className={`${FIELD} py-2`} />
                    </label>
                    <span className="flex flex-wrap items-center gap-2">
                      <select name="access" defaultValue="free" className={`${FIELD} h-9 w-auto`} aria-label={c.accessLabel}>
                        <option value="free">{t.creator.dashboard.editor.free}</option>
                        <option value="paid">{t.creator.dashboard.editor.paid}</option>
                      </select>
                      <button type="submit" className={PRIMARY}>
                        {c.answer}
                      </button>
                    </span>
                  </form>
                  <form action={dismissQuestionAction}>
                    <input type="hidden" name="questionId" value={question.id} />
                    <button type="submit" className={SMALL}>
                      {c.dismiss}
                    </button>
                  </form>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {answered.length > 0 ? (
        <section className={`${PANEL} flex flex-col gap-2 p-5`}>
          <h2 className="text-[14px] font-medium text-ink">{c.answered}</h2>
          <ul className="flex flex-col divide-y divide-line text-[12.5px]">
            {answered.slice(0, 20).map((question) => (
              <li key={question.id} className="flex flex-col gap-2 py-3">
                <span className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-ink">{question.question}</span>
                  {question.answerAssetId ? (
                    <Link href={`/dashboard/assets/${question.answerAssetId}`} className="shrink-0 text-brandink hover:underline">
                      {c.viewAnswer}
                    </Link>
                  ) : null}
                </span>
                {canEdit && question.answerAssetId ? (
                  <details className="text-[12px] text-steel">
                    <summary className="cursor-pointer">{c.audioTitle}</summary>
                    <div className="pt-2">
                      <AudioUpload
                        assetId={question.answerAssetId}
                        accept={Object.keys(AUDIO_TYPES).join(',')}
                        prepare={prepareMediaAction}
                        confirm={confirmMediaAction}
                        labels={t.creator.dashboard.editor.audio}
                        errors={errors}
                      />
                    </div>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section id="twin" className={`${PANEL} flex flex-col gap-3 p-5`}>
        <div className="flex flex-col gap-1">
          <h2 className="text-[14px] font-medium text-ink">{c.twinTitle}</h2>
          <p className="text-[12px] leading-[1.5] text-muted">{c.twinBody}</p>
        </div>
        {twin.length === 0 ? (
          <p className="text-[12.5px] text-muted">{c.noTwin}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {twin.map((answer) => (
              <li key={answer.id} className="flex flex-col gap-2 py-3">
                <p className="text-[13px] font-medium text-ink">{answer.question}</p>
                <ul className="flex flex-col gap-1 text-[12.5px] leading-[1.6] text-steel">
                  {answer.claims.map((claim, at) => (
                    <li key={at}>{claim.claim}</li>
                  ))}
                </ul>
                <p className="flex flex-wrap items-center gap-3 text-[11px] text-muted">
                  {answer.versions.slice(0, 3).map((version) => (
                    <span key={version.versionId} className="font-mono">
                      {version.publicId}@{version.label}
                    </span>
                  ))}
                  {answer.endorsement ? (
                    <span className="text-brandink">
                      {fill(answer.endorsement.superseded ? c.endorsedOld : c.endorsedFor, { label: answer.endorsement.versionLabel ?? '' })}
                    </span>
                  ) : null}
                </p>
                {canEdit ? (
                  <form action={endorseAnswerAction}>
                    <input type="hidden" name="twinAnswerId" value={answer.id} />
                    <input type="hidden" name="endorse" value={answer.endorsement ? 'no' : 'yes'} />
                    <button type="submit" className={SMALL}>
                      {answer.endorsement ? c.unendorse : c.endorse}
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
