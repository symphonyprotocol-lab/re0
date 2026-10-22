'use client';

import { useActionState } from 'react';
import { ConsoleButton, Panel, PanelHead, Pill } from '@/components/admin/ui';
import { SearchIcon, SpinnerIcon } from '@/components/ui/icons';
import type { ExpertSampleActionResult } from '@/app/admin/(console)/expert-libraries/actions';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';
import { submitOn } from './platform-library-shared';

type SampleAction = (previous: ExpertSampleActionResult | null, form: FormData) => Promise<ExpertSampleActionResult>;

/**
 * The reviewer's own look at the question set (review-visibility-
 * proposal.md 6.5): a few questions drawn by the application, each
 * re-asked of the current version, with whether the expected answer came
 * back and what did. What the reviewer scores as `sample_ok` on the
 * checklist is this.
 */
export function ExpertSample({ applicationId, questions, action }: { applicationId: string; questions: number; action: SampleAction }) {
  const { t } = useI18n();
  const s = t.admin.expertDetail.sample;
  const [state, submit, pending] = useActionState(action, null);
  const sample = state?.ok ? state.sample : undefined;

  return (
    <Panel>
      <PanelHead
        title={s.title}
        description={fill(s.description, { n: questions })}
        action={
          <form onSubmit={submitOn(submit)}>
            <input type="hidden" name="applicationId" value={applicationId} />
            <ConsoleButton type="submit" variant="primary" disabled={pending || questions === 0}>
              {pending ? <SpinnerIcon size={14} className="motion-safe:animate-spin" /> : <SearchIcon size={14} />}
              {pending ? s.running : s.run}
            </ConsoleButton>
          </form>
        }
      />
      {state && !state.ok ? (
        <p className="px-[19px] py-3 text-[12px] tracking-[-0.023em] text-err">{s.errors[state.error === 'library_ineligible' ? 'library_ineligible' : 'unavailable']}</p>
      ) : null}
      {sample ? (
        <ol className="flex flex-col">
          {sample.questions.map((item, at) => (
            <li key={item.id} className="flex flex-col gap-2 border-t border-line/70 px-[19px] py-3">
              <div className="flex flex-wrap items-center gap-2 text-[12px] tracking-[-0.023em]">
                <Pill tone="info">#{at + 1}</Pill>
                <span className="font-semibold text-ink">{item.question}</span>
                <Pill tone={item.author === 'owner' ? 'neutral' : 'brand'}>{item.author === 'owner' ? s.authorOwner : s.authorAdmin}</Pill>
                <Pill tone={item.hitRank === null ? 'danger' : 'ok'}>{item.hitRank === null ? s.miss : fill(s.hit, { rank: item.hitRank })}</Pill>
              </div>
              <p className="flex flex-wrap gap-x-4 font-mono text-[11px] text-muted">
                {item.expectedSource ? <span>{s.expectedSource}: {item.expectedSource}</span> : null}
                {item.expectedText ? <span>{s.expectedText}: {item.expectedText}</span> : null}
              </p>
              <ol className="flex flex-col gap-1.5">
                {item.passages.map((passage, rank) => (
                  <li key={`${rank}-${passage.sourceUrl}`} className="rounded-[6px] border border-line bg-subtle px-2.5 py-2">
                    <p className="flex flex-wrap items-center gap-2 text-[11.5px] tracking-[-0.023em]">
                      <span className="text-muted">{rank + 1}.</span>
                      <span className="font-medium text-ink">{passage.title}</span>
                      {passage.section ? <span className="text-muted">· {passage.section}</span> : null}
                      <a href={passage.sourceUrl} target="_blank" rel="noreferrer" className="break-all text-brandink hover:text-brand">
                        {passage.sourceUrl}
                      </a>
                    </p>
                    <p className="mt-1 line-clamp-3 text-[12px] leading-[1.55] text-steel">{passage.excerpt}</p>
                  </li>
                ))}
                {item.passages.length === 0 ? <li className="text-[12px] text-muted">{s.nothing}</li> : null}
              </ol>
            </li>
          ))}
        </ol>
      ) : (
        <p className="px-[19px] py-4 text-[12px] tracking-[-0.023em] text-muted">{questions === 0 ? s.noQuestions : s.idle}</p>
      )}
    </Panel>
  );
}
