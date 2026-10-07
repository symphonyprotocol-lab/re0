'use client';

import { useActionState, useEffect, useRef } from 'react';
import { FIELD, Field } from '@/components/admin/form-fields';
import { ConsoleButton, Fact, Panel, PanelHead, Pill } from '@/components/admin/ui';
import { PlusIcon, SparklesIcon, SpinnerIcon, TrashIcon } from '@/components/ui/icons';
import type { EvalQuestionView, LibraryBenchmarkView } from '@/lib/application/administration';
import { EVAL_LIMITS } from '@/lib/domain/benchmark';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';
import { Refusal, submitOn, type PlatformAction } from './platform-library-shared';

/**
 * A library's retrieval test set, on its console detail page.
 *
 * The Benchmark used to be a number with nothing behind it an operator could
 * inspect or change. This panel is what is behind it now (requirement.md 6.3):
 * the questions, which of them the current version answers, and the score
 * with and without them -- so a low Benchmark points at the questions that
 * miss rather than at nothing.
 */
export function PlatformBenchmarkPanel({
  libraryId,
  view,
  canEvaluate,
  addAction,
  removeAction,
  runAction,
}: {
  libraryId: string;
  view: LibraryBenchmarkView;
  /** False before the first build: there is no version to ask. */
  canEvaluate: boolean;
  addAction: PlatformAction;
  removeAction: PlatformAction;
  runAction: PlatformAction;
}) {
  const { t } = useI18n();
  const b = t.admin.platformLibraryDetail.benchmark;
  const [ran, run, running] = useActionState(runAction, null);
  const { questions, limits, score } = view;
  const missing = Math.max(0, limits.min - questions.length);

  return (
    <Panel className="overflow-hidden">
      <PanelHead
        title={b.title}
        description={fill(b.description, { topK: limits.topK })}
        action={
          <form onSubmit={submitOn(run)}>
            <input type="hidden" name="libraryId" value={libraryId} />
            <ConsoleButton
              type="submit"
              disabled={running || !canEvaluate || questions.length === 0}
            >
              {running ? (
                <SpinnerIcon size={14} className="motion-safe:animate-spin" />
              ) : (
                <SparklesIcon size={14} />
              )}
              {running ? b.running : b.run}
            </ConsoleButton>
          </form>
        }
      />

      {score ? (
        <dl className="grid grid-cols-1 gap-x-6 px-[19px] py-1.5 sm:grid-cols-2">
          <Fact label={b.score} value={score.benchmarkScore} />
          <Fact label={b.structural} value={score.structural} />
          <Fact
            label={b.hitRate}
            value={
              score.evaluation ? (
                fill(b.hitRateValue, {
                  hits: score.evaluation.hits,
                  questions: score.evaluation.questions,
                  rate: score.evaluation.hitRate,
                })
              ) : (
                <Pill>{b.notEvaluated}</Pill>
              )
            }
          />
        </dl>
      ) : null}

      <div className="flex flex-col gap-2 border-t-2 border-line px-[19px] py-3">
        <Refusal state={ran} />
        {ran?.ok && ran.evaluated ? (
          <p role="status" className="text-[12px] tracking-[-0.023em] text-pubink">
            {fill(b.done, {
              questions: ran.evaluated.questions,
              hits: ran.evaluated.hits,
              before: ran.evaluated.previousBenchmarkScore,
              after: ran.evaluated.benchmarkScore,
            })}
          </p>
        ) : null}
        {questions.length > 0 && missing > 0 ? (
          <p className="text-[11px] leading-[1.5] tracking-[-0.023em] text-amberink">
            {fill(b.belowMinimum, { min: limits.min, missing })}
          </p>
        ) : null}

        {questions.length === 0 ? (
          <p className="py-4 text-center text-[13px] tracking-[-0.023em] text-steel">{b.empty}</p>
        ) : (
          <ul className="flex flex-col">
            {questions.map((question) => (
              <QuestionRow
                key={question.id}
                libraryId={libraryId}
                question={question}
                action={removeAction}
              />
            ))}
          </ul>
        )}
      </div>

      {questions.length < limits.max ? (
        <AddQuestionForm libraryId={libraryId} action={addAction} />
      ) : null}
    </Panel>
  );
}

function QuestionRow({
  libraryId,
  question,
  action,
}: {
  libraryId: string;
  question: EvalQuestionView;
  action: PlatformAction;
}) {
  const { t } = useI18n();
  const b = t.admin.platformLibraryDetail.benchmark;
  const [state, remove, pending] = useActionState(action, null);

  return (
    <li className="flex flex-col gap-1.5 border-b border-line/70 py-2.5 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[12px] leading-[1.5] tracking-[-0.023em] text-ink">
          {question.question}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <LastResult question={question} />
          <form onSubmit={submitOn(remove)}>
            <input type="hidden" name="libraryId" value={libraryId} />
            <input type="hidden" name="questionId" value={question.id} />
            <ConsoleButton type="submit" variant="ghost" size="sm" disabled={pending}>
              <TrashIcon size={13} />
              {b.remove}
            </ConsoleButton>
          </form>
        </div>
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
        {question.expectedSource ? (
          <span>
            {b.expectedSource}: {question.expectedSource}
          </span>
        ) : null}
        {question.expectedText ? (
          <span>
            {b.expectedText}: {question.expectedText}
          </span>
        ) : null}
      </p>
      <Refusal state={state} />
    </li>
  );
}

function LastResult({ question }: { question: EvalQuestionView }) {
  const { t } = useI18n();
  const b = t.admin.platformLibraryDetail.benchmark;
  if (question.lastEvaluatedAt === null) return <Pill>{b.lastNever}</Pill>;
  /* A result from a superseded version says nothing about the one serving. */
  if (!question.lastRunIsCurrent) return <Pill tone="warn">{b.lastStale}</Pill>;
  return question.lastRank === null ? (
    <Pill tone="danger">{b.lastMiss}</Pill>
  ) : (
    <Pill tone="ok">{fill(b.lastHit, { rank: question.lastRank })}</Pill>
  );
}

function AddQuestionForm({ libraryId, action }: { libraryId: string; action: PlatformAction }) {
  const { t } = useI18n();
  const b = t.admin.platformLibraryDetail.benchmark;
  const [state, add, pending] = useActionState(action, null);
  const form = useRef<HTMLFormElement>(null);

  /* Cleared only once the question is saved, so a refusal keeps what was typed. */
  useEffect(() => {
    if (state?.ok) form.current?.reset();
  }, [state]);

  return (
    <form
      ref={form}
      onSubmit={submitOn(add)}
      className="flex flex-col gap-3 border-t-2 border-line px-[19px] py-4"
    >
      <input type="hidden" name="libraryId" value={libraryId} />
      <Field label={b.question}>
        <input
          name="question"
          required
          maxLength={EVAL_LIMITS.question}
          placeholder={b.questionPlaceholder}
          className={FIELD}
        />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={b.expectedSource}>
          <input
            name="expectedSource"
            maxLength={EVAL_LIMITS.expectation}
            placeholder={b.expectedSourcePlaceholder}
            className={FIELD}
          />
        </Field>
        <Field label={b.expectedText}>
          <input
            name="expectedText"
            maxLength={EVAL_LIMITS.expectation}
            placeholder={b.expectedTextPlaceholder}
            className={FIELD}
          />
        </Field>
      </div>
      <p className="text-[11px] leading-[1.5] tracking-[-0.023em] text-muted">
        {b.expectationNote}
      </p>
      <Refusal state={state} />
      <div>
        <ConsoleButton type="submit" variant="primary" disabled={pending}>
          {pending ? (
            <SpinnerIcon size={14} className="motion-safe:animate-spin" />
          ) : (
            <PlusIcon size={14} />
          )}
          {pending ? b.adding : b.add}
        </ConsoleButton>
      </div>
    </form>
  );
}
