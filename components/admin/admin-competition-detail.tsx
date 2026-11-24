'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client/upload';
import type { AdminCompetitionDetail } from '@/lib/services/competitions';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime } from '@/i18n/format';
import { Modal } from '@/components/admin/console-modal';
import { RecordsTable } from '@/components/admin/list-kit';
import { useToast } from '@/components/ui/toast';

type Entry = AdminCompetitionDetail['entries'][number];
type Answer = AdminCompetitionDetail['answers'][number];

const score = (value: number | null, none: string) => (value === null ? none : String(value));

/**
 * The console's two actions on one competition (docs/design/competitions.md
 * 7.5, Q7), each behind a dialog that names what will happen and requires a
 * reason: 取消参赛资格 on an entry, and 改分 on an answer. The page shows
 * every change made so far beneath them.
 */
export function AdminCompetitionActions({ detail }: { detail: AdminCompetitionDetail }) {
  const { t, locale } = useI18n();
  const d = t.competitions.admin.detail;
  const toast = useToast();
  const router = useRouter();
  const [disqualifying, setDisqualifying] = useState<Entry | null>(null);
  const [scoring, setScoring] = useState<Answer | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const published = detail.competition.status === 'published';
  const errorText = (code: string | undefined) => (code && code in d.errors ? d.errors[code as keyof typeof d.errors] : t.common.errors.generic);

  const close = () => {
    if (busy) return;
    setDisqualifying(null);
    setScoring(null);
    setError('');
  };

  async function submit(url: string, json: Record<string, unknown>, done: string) {
    setBusy(true);
    setError('');
    const result = await api<{ error?: string }>(url, { method: 'POST', json });
    setBusy(false);
    if (!result.ok) return setError(errorText(result.data.error));
    setDisqualifying(null);
    setScoring(null);
    toast(done);
    router.refresh();
  }

  const entryStatus = (entry: Entry) => t.competitions.workspace.entryStatus[entry.status];
  const answerState = (answer: Answer) => {
    const states = d.answerStates;
    if (answer.state === 'answered' && answer.review === 'rejected') return states.rejected;
    if (answer.state === 'answered' && answer.judgeState === 'failed') return states.judgeFailed;
    return states[answer.state as keyof typeof states] ?? answer.state;
  };
  const scorable = (answer: Answer) => detail.canScore && answer.entryStatus === 'locked' && answer.state === 'answered' && answer.review !== 'rejected';

  return (
    <>
      <section className="card">
        <div className="p-4">
          <h2 className="text-[15px] font-semibold">{d.entriesTitle}</h2>
          <p className="muted small mt-1">{d.entriesLede}</p>
        </div>
        <RecordsTable
          actions
          label={d.entriesTitle}
          empty={t.competitions.page.entriesEmpty}
          head={[d.entryColumns.ree, d.entryColumns.owner, d.entryColumns.status, d.entryColumns.rank, d.entryColumns.total, d.entryColumns.answered, d.entryColumns.reason, d.entryColumns.actions]}
          rows={detail.entries.map((entry) => [
            <a key="ree" href={`/admin/rees/${entry.reeId}`} className="hover:underline">{entry.reeName}</a>,
            <a key="owner" href={`/admin/users/${entry.ownerId}`} className="hover:underline">{entry.ownerName ?? entry.ownerId}</a>,
            entryStatus(entry),
            <span key="rank" className="mono">{entry.rank ?? d.none}</span>,
            <span key="total" className="mono">{score(entry.total, d.none)}</span>,
            <span key="answered" className="mono">{entry.answered}</span>,
            <span key="reason" className="block max-w-[260px] whitespace-normal">{entry.reason ?? d.none}</span>,
            detail.canDisqualify && (entry.status === 'entered' || entry.status === 'locked') ? (
              <button key="act" type="button" className="btn ghost sm" onClick={() => setDisqualifying(entry)}>
                {d.disqualify}
              </button>
            ) : null,
          ])}
        />
      </section>

      <section className="card mt16">
        <div className="p-4">
          <h2 className="text-[15px] font-semibold">{d.answersTitle}</h2>
          <p className="muted small mt-1">{d.answersLede}</p>
        </div>
        <RecordsTable
          actions
          label={d.answersTitle}
          empty={t.console.list.empty}
          head={[d.answerColumns.question, d.answerColumns.ree, d.answerColumns.state, d.answerColumns.ai, d.answerColumns.host, d.answerColumns.final, d.answerColumns.actions]}
          rows={detail.answers.map((answer) => [
            <span key="q" className="block max-w-[260px] whitespace-normal">
              {answer.ordinal}. {answer.question}
            </span>,
            <span key="ree" className="block max-w-[320px] whitespace-normal">
              {answer.reeName}
              {answer.excerpt && <span className="block text-[11px] text-muted">{answer.excerpt}</span>}
            </span>,
            answerState(answer),
            <span key="ai" className="mono">{score(answer.aiScore, d.none)}</span>,
            <span key="host" className="mono">{score(answer.hostScore, d.none)}</span>,
            <span key="final" className="mono">{score(answer.finalScore, d.none)}</span>,
            scorable(answer) ? (
              <button key="act" type="button" className="btn ghost sm" onClick={() => setScoring(answer)}>
                {d.changeScore}
              </button>
            ) : null,
          ])}
        />
      </section>

      <section className="card mt16">
        <div className="p-4">
          <h2 className="text-[15px] font-semibold">{d.logTitle}</h2>
          <p className="muted small mt-1">{d.logLede}</p>
        </div>
        <RecordsTable
          label={d.logTitle}
          empty={d.logEmpty}
          head={[d.logColumns.time, d.logColumns.target, d.logColumns.actor, d.logColumns.change, d.logColumns.note]}
          rows={detail.scoreLog.map((log) => [
            formatDateTime(log.at, locale),
            `${log.reeName} · Q${log.ordinal}`,
            `${d.actors[log.actor]}${log.actorName ? ` · ${log.actorName}` : ''}`,
            <span key="change" className="mono">
              {score(log.from, d.none)} → {log.to}
            </span>,
            <span key="note" className="block max-w-[320px] whitespace-normal">{log.note}</span>,
          ])}
        />
      </section>

      <Modal
        open={Boolean(disqualifying)}
        onClose={close}
        title={fill(d.disqualifyTitle, { ree: disqualifying?.reeName ?? '' })}
        footer={
          <>
            <button type="button" className="btn secondary" onClick={close}>
              {t.common.actions.cancel}
            </button>
            <button type="submit" form="competition-disqualify" className="btn danger" disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {d.confirmDisqualify}
            </button>
          </>
        }
      >
        <form
          id="competition-disqualify"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
            if (!reason || [...reason].length > 500) return setError(d.errors.invalid_reason);
            void submit(`/api/admin/competitions/entries/${disqualifying!.id}`, { reason }, d.disqualified);
          }}
        >
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <p className="form-hint">{published ? d.disqualifyAfter : d.disqualifyBefore}</p>
          <div className="field">
            <label htmlFor="disqualify-reason">{d.reason}</label>
            <textarea id="disqualify-reason" name="reason" maxLength={500} required rows={3} />
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(scoring)}
        onClose={close}
        title={fill(d.scoreTitle, { ree: scoring?.reeName ?? '', n: scoring?.ordinal ?? 0 })}
        subtitle={scoring ? fill(d.scoreNow, { ai: score(scoring.aiScore, d.none), host: score(scoring.hostScore, d.none), final: score(scoring.finalScore, d.none) }) : undefined}
        footer={
          <>
            <button type="button" className="btn secondary" onClick={close}>
              {t.common.actions.cancel}
            </button>
            <button type="submit" form="competition-score" className="btn" disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {d.confirmScore}
            </button>
          </>
        }
      >
        <form
          id="competition-score"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const value = Number(String(form.get('score') ?? '').trim());
            const note = String(form.get('note') ?? '').trim();
            if (String(form.get('score') ?? '').trim() === '' || !Number.isFinite(value) || value < 0 || value > 10) return setError(d.errors.invalid_score);
            if (!note || [...note].length > 500) return setError(d.errors.invalid_note);
            void submit(`/api/admin/competitions/answers/${scoring!.id}/score`, { score: value, note }, d.scored);
          }}
        >
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          {scoring?.excerpt && <p className="form-hint whitespace-pre-wrap">{scoring.excerpt}</p>}
          <div className="field">
            <label htmlFor="competition-score-value">{d.newScore}</label>
            <input id="competition-score-value" name="score" type="number" min={0} max={10} step={0.1} required />
          </div>
          <div className="field">
            <label htmlFor="competition-score-note">{d.note}</label>
            <textarea id="competition-score-note" name="note" maxLength={500} required rows={3} />
          </div>
        </form>
      </Modal>
    </>
  );
}
