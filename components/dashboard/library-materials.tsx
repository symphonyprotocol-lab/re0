'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, useState } from 'react';
import { PRIMARY, ResultLine, SECONDARY } from '@/components/dashboard/library-manage';
import { EMPTY_RIGHTS, RightsFields, RightsHiddenFields, rightsComplete, type RightsAnswer } from '@/components/dashboard/rights-fields';
import { PANEL } from '@/components/dashboard/ui';
import { PlusIcon, SpinnerIcon, TrashIcon } from '@/components/ui/icons';
import type { MaterialsActionResult } from '@/app/dashboard/libraries/[libraryId]/actions';
import type { LibraryMaterials, OwnerEvalQuestions, OwnerEvalQuestionView } from '@/lib/application/libraries';
import type { Visibility } from '@/lib/domain';
import { EVAL_LIMITS } from '@/lib/domain/benchmark';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';

/**
 * The owner's declaration and question set (review-visibility-proposal.md
 * 5): the rights declaration a public library carries, and the self-check
 * questions an expert-library application is judged by. Neither holds a
 * library back from publishing -- public review before publication ended
 * on 2026-10-23. The questions are asked at every build so the owner sees
 * how theirs fare, but only the platform's own questions move the Benchmark.
 */

type MaterialsAction = (previous: MaterialsActionResult | null, form: FormData) => Promise<MaterialsActionResult>;

export interface MaterialsPanelActions {
  declare: MaterialsAction;
  add: MaterialsAction;
  remove: MaterialsAction;
}

export function LibraryMaterialsPanel({
  libraryId,
  visibility,
  canEdit,
  materials,
  questions,
  actions,
}: {
  libraryId: string;
  visibility: Visibility;
  canEdit: boolean;
  materials: LibraryMaterials;
  questions: OwnerEvalQuestions;
  actions: MaterialsPanelActions;
}) {
  const { t } = useI18n();
  const m = t.dashboard.libraryDetail.materials;
  const r = t.dashboard.libraries.rights;
  const router = useRouter();
  const [declared, declareDispatch, declaring] = useActionState(actions.declare, null);
  const [rights, setRights] = useState<RightsAnswer>(EMPTY_RIGHTS);
  const [editingRights, setEditingRights] = useState(false);
  useEffect(() => {
    if (declared?.ok) {
      setEditingRights(false);
      router.refresh();
    }
  }, [declared, router]);

  const showRightsForm = canEdit && (materials.rights === null || editingRights);

  return (
    <section id="materials" className={`${PANEL} flex scroll-mt-4 flex-col gap-5 p-6`}>
      <div className="flex flex-col gap-1">
        <h2 className="text-[15px] font-medium text-ink">{m.title}</h2>
        <p className="text-[11px] leading-[1.6] text-muted">{visibility === 'public' ? m.descriptionPublic : m.descriptionPrivate}</p>
      </div>

      {/* The rights declaration. */}
      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <h3 className="text-[13px] font-medium text-ink">{m.rightsTitle}</h3>
            <p className="text-[11px] leading-[1.5] text-muted">{m.rightsHint}</p>
          </div>
          {canEdit && materials.rights && !editingRights ? (
            <button
              type="button"
              onClick={() => {
                setRights({ ...materials.rights!, note: materials.rights!.note });
                setEditingRights(true);
              }}
              className={SECONDARY}
            >
              {m.rightsEdit}
            </button>
          ) : null}
        </div>
        {materials.rights && !editingRights ? (
          <dl className="grid gap-x-6 gap-y-1.5 text-[12px] sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="text-muted">{r.labels.origin}</dt>
            <dd className="text-ink">{r.origins[materials.rights.origin]}</dd>
            <dt className="text-muted">{r.labels.license}</dt>
            <dd className="text-ink">{r.licenses[materials.rights.license]}</dd>
            <dt className="text-muted">{r.labels.generation}</dt>
            <dd className="text-ink">{r.generations[materials.rights.generation]}</dd>
            {materials.rights.note ? (
              <>
                <dt className="text-muted">{r.noteLabel}</dt>
                <dd className="whitespace-pre-wrap text-ink">{materials.rights.note}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
        {showRightsForm ? (
          <form action={declareDispatch} className="flex flex-col gap-3">
            <input type="hidden" name="libraryId" value={libraryId} />
            <RightsHiddenFields value={rights} />
            <RightsFields value={rights} onChange={setRights} compact />
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={declaring || !rightsComplete(rights) || (visibility === 'public' && rights.generation === 'generated')}
                className={PRIMARY}
              >
                {declaring ? <SpinnerIcon size={14} className="motion-safe:animate-spin" /> : null}
                {m.rightsSubmit}
              </button>
              {editingRights ? (
                <button type="button" onClick={() => setEditingRights(false)} className={SECONDARY}>
                  {m.cancel}
                </button>
              ) : null}
              {declared && !declared.ok ? <ResultLine ok={false}>{m.errors[declared.error ?? 'unavailable']}</ResultLine> : null}
            </div>
          </form>
        ) : null}
        {!canEdit && !materials.rights ? <p className="text-[12px] text-muted">{m.rightsNone}</p> : null}
      </div>

      {/* The question set. */}
      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-[13px] font-medium text-ink">{m.questionsTitle}</h3>
          <p className="text-[11px] leading-[1.5] text-muted">
            {fill(m.questionsHint, { max: questions.limits.max })}
          </p>
        </div>
        {questions.questions.length === 0 ? (
          <p className="text-[12px] text-muted">{m.questionsEmpty}</p>
        ) : (
          <ul className="flex flex-col">
            {questions.questions.map((question) => (
              <QuestionRow key={question.id} libraryId={libraryId} question={question} canEdit={canEdit} action={actions.remove} />
            ))}
          </ul>
        )}
        {canEdit && questions.questions.length < questions.limits.max ? (
          <AddQuestionForm libraryId={libraryId} action={actions.add} />
        ) : null}
      </div>
    </section>
  );
}

function QuestionRow({
  libraryId,
  question,
  canEdit,
  action,
}: {
  libraryId: string;
  question: OwnerEvalQuestionView;
  canEdit: boolean;
  action: MaterialsAction;
}) {
  const { t } = useI18n();
  const m = t.dashboard.libraryDetail.materials;
  const router = useRouter();
  const [state, remove, pending] = useActionState(action, null);
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  const result =
    question.lastEvaluatedAt === null
      ? { label: m.lastNever, tone: 'text-muted' }
      : !question.lastRunIsCurrent
        ? { label: m.lastStale, tone: 'text-muted' }
        : question.lastRank === null
          ? { label: m.lastMiss, tone: 'text-rose' }
          : { label: fill(m.lastHit, { rank: question.lastRank }), tone: 'text-brandink' };

  return (
    <li className="flex flex-col gap-1 border-b border-line/70 py-2.5 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[12.5px] leading-[1.5] text-ink">{question.question}</p>
        <div className="flex shrink-0 items-center gap-2 text-[11px]">
          <span className={result.tone}>{result.label}</span>
          <span className="rounded-full border border-line px-2 py-0.5 text-muted">
            {question.author === 'admin' ? m.authorAdmin : m.authorOwner}
          </span>
          {canEdit && question.author === 'owner' ? (
            <form action={remove}>
              <input type="hidden" name="libraryId" value={libraryId} />
              <input type="hidden" name="questionId" value={question.id} />
              <button type="submit" disabled={pending} aria-label={m.remove} className="text-muted hover:text-rose">
                <TrashIcon size={13} />
              </button>
            </form>
          ) : null}
        </div>
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[10.5px] text-muted">
        {question.expectedSource ? <span>{m.expectedSource}: {question.expectedSource}</span> : null}
        {question.expectedText ? <span>{m.expectedText}: {question.expectedText}</span> : null}
      </p>
      {state && !state.ok ? <ResultLine ok={false}>{m.errors[state.error ?? 'unavailable']}</ResultLine> : null}
    </li>
  );
}

function AddQuestionForm({ libraryId, action }: { libraryId: string; action: MaterialsAction }) {
  const { t } = useI18n();
  const m = t.dashboard.libraryDetail.materials;
  const router = useRouter();
  const [state, add, pending] = useActionState(action, null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) {
      form.current?.reset();
      router.refresh();
    }
  }, [state, router]);
  const field = 'h-9 rounded-md border border-line bg-card px-3 text-[12px] text-ink';
  return (
    <form ref={form} action={add} className="flex flex-col gap-2 rounded-md border border-line bg-subtle p-3">
      <input type="hidden" name="libraryId" value={libraryId} />
      <input name="question" required maxLength={EVAL_LIMITS.question} placeholder={m.questionPlaceholder} aria-label={m.questionPlaceholder} className={field} />
      <div className="grid gap-2 sm:grid-cols-2">
        <input name="expectedSource" maxLength={EVAL_LIMITS.expectation} placeholder={m.expectedSourcePlaceholder} aria-label={m.expectedSource} className={field} />
        <input name="expectedText" maxLength={EVAL_LIMITS.expectation} placeholder={m.expectedTextPlaceholder} aria-label={m.expectedText} className={field} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={SECONDARY}>
          {pending ? <SpinnerIcon size={14} className="motion-safe:animate-spin" /> : <PlusIcon size={14} />}
          {m.add}
        </button>
        <span className="text-[10.5px] text-muted">{m.expectationHint}</span>
        {state && !state.ok ? <ResultLine ok={false}>{m.errors[state.error ?? 'unavailable']}</ResultLine> : null}
      </div>
    </form>
  );
}
