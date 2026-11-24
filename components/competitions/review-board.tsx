'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client/upload';
import type { ReviewAnswer } from '@/lib/services/competitions';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime } from '@/i18n/format';
import { useToast } from '@/components/ui/toast';

/**
 * 复核 (docs/design/competitions.md 5.1 step 8): every answer by question,
 * its AI score, the two runs and the judge's reasoning; the host changes a
 * score with a reason, and publishes when ready.
 */
export function ReviewBoard({ competitionId, answers, reviewEndsAt }: { competitionId: string; answers: ReviewAnswer[]; reviewEndsAt: string | null }) {
  const { t, locale } = useI18n();
  const r = t.competitions.review;
  const toast = useToast();
  const router = useRouter();
  const [drafts, setDrafts] = useState<Record<string, { score: string; note: string }>>({});
  const [busy, setBusy] = useState(false);
  const byQuestion = new Map<number, ReviewAnswer[]>();
  for (const answer of answers) byQuestion.set(answer.ordinal, [...(byQuestion.get(answer.ordinal) ?? []), answer]);

  async function score(answer: ReviewAnswer) {
    const draft = drafts[answer.id] ?? { score: '', note: '' };
    setBusy(true);
    const result = await api<{ error?: string }>(`/api/competitions/answers/${answer.id}/score`, { method: 'PATCH', json: { score: Number(draft.score), note: draft.note } });
    setBusy(false);
    const key = result.data.error as keyof typeof r.errors | undefined;
    toast(result.ok ? r.setDone : key && key in r.errors ? r.errors[key] : t.common.errors.generic);
    if (result.ok) router.refresh();
  }

  async function publish() {
    if (!window.confirm(r.publishConfirm)) return;
    setBusy(true);
    const result = await api(`/api/competitions/${competitionId}/publish`, { method: 'POST' });
    setBusy(false);
    toast(result.ok ? r.published : t.common.errors.generic);
    if (result.ok) router.refresh();
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">{r.title}</h2>
          <p className="text-[12px] text-muted">{r.lede}</p>
          {reviewEndsAt && <p className="mt-1 text-[12px] text-muted">{fill(r.until, { at: formatDateTime(reviewEndsAt, locale) })}</p>}
        </div>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void publish()}>
          {r.publish}
        </button>
      </div>
      {[...byQuestion.entries()].map(([ordinal, rows]) => (
        <div key={ordinal} className="card flex flex-col gap-3 p-4">
          <h3 className="text-[13px] font-semibold">{fill(r.byQuestion, { n: ordinal, question: rows[0]!.question })}</h3>
          {rows.map((answer) => {
            const draft = drafts[answer.id] ?? { score: '', note: '' };
            const scorable = answer.state === 'answered' && answer.review !== 'rejected';
            return (
              <div key={answer.id} className="flex flex-col gap-2 border-t border-line pt-3">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <strong>{answer.reeName}</strong>
                  {answer.aiScore !== null && <span className="tag">{fill(r.ai, { score: String(answer.aiScore) })}</span>}
                  {answer.hostScore !== null && <span className="tag">{fill(t.competitions.sheet.host, { score: String(answer.hostScore) })}</span>}
                  {answer.injection && <span className="tag text-red">{r.injection}</span>}
                </div>
                {answer.state !== 'answered' ? (
                  <p className="text-[12px] text-muted">{r.noAnswer}</p>
                ) : answer.review === 'rejected' ? (
                  <p className="text-[12px] text-muted">{r.rejected}</p>
                ) : (
                  <>
                    <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{answer.text}</p>
                    {answer.judgeState === 'failed' && <p className="text-[12px] text-red">{r.judgeFailed}</p>}
                    {answer.runs.length > 0 && <p className="text-[11px] text-muted">{fill(r.runs, { runs: answer.runs.map((run) => `${run.accuracy}/${run.completeness}/${run.citation}`).join(' · ') })}</p>}
                    {answer.rationale && <p className="text-[12px] text-muted">{answer.rationale}</p>}
                  </>
                )}
                {scorable && (
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="flex w-[90px] flex-col gap-1">
                      <span className="field-label">{r.score}</span>
                      <input className="input" type="number" min={0} max={10} step={0.1} value={draft.score} onChange={(event) => setDrafts({ ...drafts, [answer.id]: { ...draft, score: event.target.value } })} />
                    </label>
                    <label className="flex min-w-[220px] flex-1 flex-col gap-1">
                      <span className="field-label">{r.note}</span>
                      <input className="input" maxLength={500} value={draft.note} onChange={(event) => setDrafts({ ...drafts, [answer.id]: { ...draft, note: event.target.value } })} />
                    </label>
                    <button type="button" className="btn-secondary btn-sm" disabled={busy || draft.score === '' || !draft.note.trim()} onClick={() => void score(answer)}>
                      {r.set}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}
