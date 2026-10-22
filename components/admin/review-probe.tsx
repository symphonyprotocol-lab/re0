'use client';

import { useActionState } from 'react';
import { FIELD } from '@/components/admin/form-fields';
import { ConsoleButton, Panel, PanelHead, Pill } from '@/components/admin/ui';
import { SearchIcon, SpinnerIcon } from '@/components/ui/icons';
import type { ProbeActionResult } from '@/app/admin/(console)/libraries/actions';
import { REVIEW_PROBE_MAX_LENGTH } from '@/lib/domain/review';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';
import { Refusal, submitOn } from './platform-library-shared';

type ProbeAction = (previous: ProbeActionResult | null, form: FormData) => Promise<ProbeActionResult>;

/**
 * The reviewer's probe: one question, the passages the library would
 * answer it with, in the order a caller gets them. review-visibility-
 * proposal.md 4.2. The excerpts are what 7.4's "sampling" reads; a
 * question that returns nothing is itself a finding.
 */
export function ReviewProbe({ libraryId, ready, action }: { libraryId: string; ready: boolean; action: ProbeAction }) {
  const { t } = useI18n();
  const p = t.admin.libraries.detail.probe;
  const [state, submit, pending] = useActionState(action, null);
  const probe = state?.ok ? state.probe : undefined;

  return (
    <Panel>
      <PanelHead title={p.title} description={p.description} />
      <form onSubmit={submitOn(submit)} className="flex flex-col gap-3 px-[19px] py-4">
        <input type="hidden" name="libraryId" value={libraryId} />
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            name="query"
            required
            maxLength={REVIEW_PROBE_MAX_LENGTH}
            disabled={!ready || pending}
            placeholder={p.placeholder}
            aria-label={p.placeholder}
            className={`${FIELD} flex-1`}
          />
          <ConsoleButton type="submit" variant="primary" disabled={!ready || pending}>
            {pending ? <SpinnerIcon size={14} className="motion-safe:animate-spin" /> : <SearchIcon size={14} />}
            {pending ? p.running : p.submit}
          </ConsoleButton>
        </div>
        {!ready ? <p className="text-[11px] tracking-[-0.023em] text-muted">{p.notReady}</p> : null}
        <Refusal state={state} />
      </form>

      {probe ? (
        <div className="flex flex-col border-t-2 border-line">
          <p className="px-[19px] py-3 text-[12px] tracking-[-0.023em] text-muted">
            {probe.chunks.length === 0
              ? fill(p.none, { query: probe.query })
              : fill(p.summary, { n: probe.chunks.length, query: probe.query, hits: probe.confidence.keywordHits })}
          </p>
          <ol className="flex flex-col">
            {probe.chunks.map((chunk, at) => (
              <li key={`${at}-${chunk.sourceUrl}`} className="flex flex-col gap-1.5 border-t border-line/70 px-[19px] py-3">
                <div className="flex flex-wrap items-center gap-2 text-[12px] tracking-[-0.023em]">
                  <Pill tone="info">#{at + 1}</Pill>
                  <span className="font-semibold text-ink">{chunk.documentTitle}</span>
                  {chunk.section ? <span className="text-muted">· {chunk.section}</span> : null}
                  <a href={chunk.sourceUrl} target="_blank" rel="noreferrer" className="break-all text-brandink hover:text-brand">
                    {chunk.sourceUrl}
                  </a>
                  <span className="ml-auto text-[11px] text-muted">{fill(p.score, { score: chunk.score.toFixed(3), tokens: chunk.tokens })}</span>
                </div>
                <p className="line-clamp-6 text-[12.5px] leading-[1.6] whitespace-pre-wrap text-steel">{chunk.text}</p>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </Panel>
  );
}
