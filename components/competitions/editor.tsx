'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client/upload';
import { COMPETITION_JUDGE_FEE, COMPETITION_QUESTIONS_MAX, type CompetitionStatus, type CompetitionWeights } from '@/lib/domain/competition';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { useToast } from '@/components/ui/toast';

export interface EditorSettings {
  title: string;
  channel: string;
  description: string;
  lang: 'zh' | 'en';
  questionMode: 'open' | 'closed';
  payer: 'entrant' | 'host';
  maxEntries: number;
  maxEntriesPerUser: number;
  weights: CompetitionWeights;
  revealReference: boolean;
  /** ISO, or empty. */
  deadlineAt: string;
  reviewHours: number;
}

export interface EditorQuestion {
  id?: string;
  question: string;
  detail: string;
  referenceAnswer: string;
  rubric: string;
  weight: number;
}

type Failure = { error?: string; field?: string; balance?: number; needed?: number };

/** `<input type="datetime-local">` speaks local time without a zone. */
const toLocalInput = (iso: string): string => {
  if (!iso) return '';
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
};
const fromLocalInput = (value: string): string => (value ? new Date(value).toISOString() : '');

/**
 * The host's editor (docs/design/competitions.md 5.1): a draft's settings
 * and questions (with 试评 on a saved question), then 提交发布; an open
 * competition's description and 提前截止; 取消 while the rules allow it.
 */
export function CompetitionEditor(props: { id?: string; status?: CompetitionStatus; settings: EditorSettings; questions: EditorQuestion[]; entries?: number; entriesMax: number; deposit?: number; rejectedReason?: string | null }) {
  const { t, locale } = useI18n();
  const c = t.competitions.editor;
  const toast = useToast();
  const router = useRouter();
  const [settings, setSettings] = useState(props.settings);
  const [questions, setQuestions] = useState<EditorQuestion[]>(props.questions.length ? props.questions : [{ question: '', detail: '', referenceAnswer: '', rubric: '', weight: 1 }]);
  const [busy, setBusy] = useState(false);
  const [trial, setTrial] = useState<{ questionId: string; answer: string; result: string | null }>({ questionId: props.questions[0]?.id ?? '', answer: '', result: null });
  const status = props.status ?? 'draft';
  const draft = status === 'draft';
  const set = <K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) => setSettings((current) => ({ ...current, [key]: value }));
  const setQuestion = (index: number, patch: Partial<EditorQuestion>) => setQuestions((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  const message = (data: Failure) => {
    const key = data.error as keyof typeof c.errors | undefined;
    if (key === 'insufficient_credits') return fill(c.errors.insufficient_credits, { needed: formatNumber(data.needed ?? 0, locale), balance: formatNumber(data.balance ?? 0, locale) });
    return key && key in c.errors ? c.errors[key] : c.errors.generic;
  };

  async function call<T = Failure>(url: string, method: string, json?: unknown) {
    setBusy(true);
    const result = await api<T & Failure>(url, { method, json });
    setBusy(false);
    return result;
  }

  async function save() {
    const payload = { ...settings, deadlineAt: settings.deadlineAt || null };
    if (!props.id) {
      const result = await call<{ id: string }>('/api/competitions', 'POST', payload);
      if (!result.ok) return toast(message(result.data));
      toast(c.saved);
      router.push(`/workspace/competitions/${result.data.id}`);
      return;
    }
    const result = await call(`/api/competitions/${props.id}`, 'PATCH', draft ? payload : { description: settings.description });
    toast(result.ok ? c.saved : message(result.data));
    if (result.ok) router.refresh();
  }

  async function saveQuestions() {
    const result = await call<{ count: number }>(`/api/competitions/${props.id}/questions`, 'PUT', { questions });
    toast(result.ok ? c.questionsSaved : message(result.data));
    if (result.ok) router.refresh();
  }

  async function act(path: string, done: string, confirmText?: string, json?: unknown) {
    if (confirmText && !window.confirm(confirmText)) return;
    const result = await call(path ? `/api/competitions/${props.id}/${path}` : `/api/competitions/${props.id}`, path ? 'POST' : 'PATCH', json);
    toast(result.ok ? done : message(result.data));
    if (result.ok) router.refresh();
  }

  async function runTrial() {
    const result = await call<{ score: number }>(`/api/competitions/${props.id}/trial-judge`, 'POST', { questionId: trial.questionId, answer: trial.answer });
    if (!result.ok) return toast(message(result.data));
    setTrial((current) => ({ ...current, result: fill(c.trialResult, { score: String(result.data.score) }) }));
  }

  const field = 'flex flex-col gap-1';
  return (
    <div className="flex flex-col gap-6">
      <p className="text-[12px] leading-relaxed text-muted">{c.lede}</p>
      {props.rejectedReason && status === 'rejected' && <p className="info-strip text-[12px]">{fill(c.rejectedReason, { reason: props.rejectedReason })}</p>}

      <section className="card flex flex-col gap-4 p-4">
        <label className={field}>
          <span className="field-label">{c.name}</span>
          <input className="input" value={settings.title} maxLength={80} disabled={!draft} onChange={(event) => set('title', event.target.value)} />
        </label>
        <label className={field}>
          <span className="field-label">{c.channel}</span>
          <input className="input" value={settings.channel} maxLength={33} disabled={Boolean(props.id)} onChange={(event) => set('channel', event.target.value)} />
          <span className="hint">{c.channelHint}</span>
        </label>
        <label className={field}>
          <span className="field-label">{c.description}</span>
          <textarea className="input min-h-[140px]" value={settings.description} maxLength={8000} disabled={!(draft || status === 'open')} onChange={(event) => set('description', event.target.value)} />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={field}>
            <span className="field-label">{c.lang}</span>
            <select className="input" value={settings.lang} disabled={!draft} onChange={(event) => set('lang', event.target.value as 'zh' | 'en')}>
              <option value="zh">{c.langs.zh}</option>
              <option value="en">{c.langs.en}</option>
            </select>
          </label>
          <label className={field}>
            <span className="field-label">{c.questionMode}</span>
            <select className="input" value={settings.questionMode} disabled={!draft} onChange={(event) => set('questionMode', event.target.value as 'open' | 'closed')}>
              <option value="open">{t.competitions.mode.open}</option>
              <option value="closed">{t.competitions.mode.closed}</option>
            </select>
          </label>
          <label className={field}>
            <span className="field-label">{c.payer}</span>
            <select className="input" value={settings.payer} disabled={!draft} onChange={(event) => set('payer', event.target.value as 'entrant' | 'host')}>
              <option value="entrant">{t.competitions.payer.entrant}</option>
              <option value="host">{t.competitions.payer.host}</option>
            </select>
          </label>
          <label className={field}>
            <span className="field-label">{c.maxEntries}</span>
            <input className="input" type="number" min={1} max={props.entriesMax} value={settings.maxEntries} disabled={!draft} onChange={(event) => set('maxEntries', Number(event.target.value))} />
          </label>
          <label className={field}>
            <span className="field-label">{c.maxEntriesPerUser}</span>
            <input className="input" type="number" min={1} max={3} value={settings.maxEntriesPerUser} disabled={!draft} onChange={(event) => set('maxEntriesPerUser', Number(event.target.value))} />
          </label>
          <label className={field}>
            <span className="field-label">{c.reviewHours}</span>
            <input className="input" type="number" min={0} max={168} value={settings.reviewHours} disabled={!draft} onChange={(event) => set('reviewHours', Number(event.target.value))} />
          </label>
          <label className={field}>
            <span className="field-label">{c.deadline}</span>
            <input className="input" type="datetime-local" value={toLocalInput(settings.deadlineAt)} disabled={!draft} onChange={(event) => set('deadlineAt', fromLocalInput(event.target.value))} />
            <span className="hint">{c.deadlineHint}</span>
          </label>
          <div className={field}>
            <span className="field-label">{c.weights}</span>
            <div className="flex gap-2">
              {(['accuracy', 'completeness', 'citation'] as const).map((key) => (
                <input key={key} className="input" type="number" min={0} max={1} step={0.05} value={settings.weights[key]} disabled={!draft} aria-label={key} onChange={(event) => set('weights', { ...settings.weights, [key]: Number(event.target.value) })} />
              ))}
            </div>
          </div>
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={settings.revealReference} disabled={!draft} onChange={(event) => set('revealReference', event.target.checked)} />
          {c.revealReference}
        </label>
        {(draft || status === 'open') && (
          <div>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void save()}>
              {busy ? c.saving : c.save}
            </button>
          </div>
        )}
      </section>

      {props.id && (
        <section className="card flex flex-col gap-4 p-4">
          <h2 className="text-[15px] font-semibold">{c.questions}</h2>
          <p className="text-[12px] text-muted">{fill(c.questionsLede, { max: COMPETITION_QUESTIONS_MAX })}</p>
          {questions.map((item, index) => (
            <div key={item.id ?? `new-${index}`} className="flex flex-col gap-2 border-t border-line pt-4 first-of-type:border-t-0 first-of-type:pt-0">
              <div className="flex items-center justify-between">
                <strong className="text-[13px]">{fill(t.competitions.sheet.question, { n: index + 1 })}</strong>
                {draft && questions.length > 1 && (
                  <button type="button" className="btn-ghost" onClick={() => setQuestions((current) => current.filter((_, i) => i !== index))}>
                    {c.remove}
                  </button>
                )}
              </div>
              <label className={field}>
                <span className="field-label">{c.question}</span>
                <input className="input" value={item.question} maxLength={300} disabled={!draft} onChange={(event) => setQuestion(index, { question: event.target.value })} />
              </label>
              <label className={field}>
                <span className="field-label">{c.detail}</span>
                <textarea className="input" value={item.detail} maxLength={2000} disabled={!draft} onChange={(event) => setQuestion(index, { detail: event.target.value })} />
              </label>
              <label className={field}>
                <span className="field-label">{c.referenceAnswer}</span>
                <textarea className="input" value={item.referenceAnswer} maxLength={4000} disabled={!draft} onChange={(event) => setQuestion(index, { referenceAnswer: event.target.value })} />
              </label>
              <label className={field}>
                <span className="field-label">{c.rubric}</span>
                <textarea className="input" value={item.rubric} maxLength={2000} disabled={!draft} onChange={(event) => setQuestion(index, { rubric: event.target.value })} />
              </label>
              <label className={`${field} max-w-[160px]`}>
                <span className="field-label">{c.weight}</span>
                <input className="input" type="number" min={0.1} max={10} step={0.1} value={item.weight} disabled={!draft} onChange={(event) => setQuestion(index, { weight: Number(event.target.value) })} />
              </label>
            </div>
          ))}
          {draft && (
            <div className="flex flex-wrap gap-2">
              {questions.length < COMPETITION_QUESTIONS_MAX && (
                <button type="button" className="btn-secondary btn-sm" onClick={() => setQuestions((current) => [...current, { question: '', detail: '', referenceAnswer: '', rubric: '', weight: 1 }])}>
                  {c.add}
                </button>
              )}
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void saveQuestions()}>
                {c.saveQuestions}
              </button>
            </div>
          )}
        </section>
      )}

      {props.id && draft && props.questions.some((item) => item.id) && (
        <section className="card flex flex-col gap-3 p-4">
          <h2 className="text-[15px] font-semibold">{c.trial}</h2>
          <p className="text-[12px] text-muted">{fill(c.trialLede, { fee: COMPETITION_JUDGE_FEE })}</p>
          <select className="input" value={trial.questionId} onChange={(event) => setTrial({ ...trial, questionId: event.target.value, result: null })}>
            {props.questions.filter((item) => item.id).map((item, index) => (
              <option key={item.id} value={item.id}>
                {index + 1}. {item.question}
              </option>
            ))}
          </select>
          <label className={field}>
            <span className="field-label">{c.trialAnswer}</span>
            <textarea className="input" value={trial.answer} maxLength={4000} onChange={(event) => setTrial({ ...trial, answer: event.target.value, result: null })} />
          </label>
          <div className="flex items-center gap-3">
            <button type="button" className="btn-secondary btn-sm" disabled={busy || !trial.answer.trim()} onClick={() => void runTrial()}>
              {c.trialRun}
            </button>
            {trial.result && <strong className="text-[13px]">{trial.result}</strong>}
          </div>
        </section>
      )}

      {props.id && (
        <section className="flex flex-wrap items-center gap-3">
          {draft && (
            <>
              <p className="w-full text-[12px] text-muted">{fill(c.submitNote, { deposit: formatNumber(props.deposit ?? 0, locale) })}</p>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act('submit', c.submitted)}>
                {c.submit}
              </button>
            </>
          )}
          {status === 'open' && (
            <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void act('', c.closed, c.closeNowConfirm, { closeNow: true })}>
              {c.closeNow}
            </button>
          )}
          {(draft || status === 'pending' || (status === 'open' && (props.entries ?? 0) === 0)) && (
            <button type="button" className="btn-danger btn-sm" disabled={busy} onClick={() => void act('cancel', c.cancelled, c.cancelConfirm)}>
              {c.cancel}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
