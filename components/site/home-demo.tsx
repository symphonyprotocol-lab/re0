'use client';

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n/client';
import { Icon, type IconName } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';

type QuestionId = 'q1' | 'q2' | 'q3';
const QUESTIONS: QuestionId[] = ['q1', 'q2', 'q3'];
const ASK_EVENT = 're0:home-demo';

/** The hero's "看看它如何回答": asks the demo its first question again. */
export function DemoTrigger({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="btn-secondary min-h-12 px-5 text-[14px]"
      onClick={() => {
        document.getElementById('home-demo')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: 'q1' }));
      }}
    >
      <Icon name="play" />
      {label}
    </button>
  );
}

/**
 * The home page's question-and-answer example (prototype suite.js
 * `demoVisual`): a Ree with four sources; pick a question and it answers
 * with a citation you can open, or says it does not know and charges nothing.
 * Scripted, no model call.
 */
export function HomeDemo() {
  const { t } = useI18n();
  const d = t.site.demo;
  const [question, setQuestion] = useState<QuestionId>('q1');
  const [shown, setShown] = useState(Number.POSITIVE_INFINITY);
  const [citation, setCitation] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const answerText = question === 'q3' ? '' : d[question].answer;

  const ask = (id: QuestionId) => {
    if (timer.current) clearInterval(timer.current);
    setQuestion(id);
    setCitation(false);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || id === 'q3') {
      setShown(Number.POSITIVE_INFINITY);
      return;
    }
    const full = d[id].answer;
    setShown(0);
    timer.current = setInterval(() => {
      setShown((value) => {
        if (value >= full.length) {
          if (timer.current) clearInterval(timer.current);
          return Number.POSITIVE_INFINITY;
        }
        return value + 2;
      });
    }, 30);
  };

  const askRef = useRef(ask);
  askRef.current = ask;
  useEffect(() => {
    const listener = (event: Event) => askRef.current(((event as CustomEvent).detail as QuestionId) ?? 'q1');
    window.addEventListener(ASK_EVENT, listener);
    return () => {
      window.removeEventListener(ASK_EVENT, listener);
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  const typing = shown !== Number.POSITIVE_INFINITY;
  const sources: [IconName, keyof typeof d.sources][] = [
    ['file', 'handbook'],
    ['github', 'repo'],
    ['audio', 'audio'],
    ['globe', 'site'],
  ];

  return (
    <div id="home-demo" className="relative min-w-0" aria-label={d.label} role="region">
      <div className="overflow-hidden rounded-2xl border border-[#dfe5f2] bg-white shadow-[0_24px_60px_-28px_rgba(9,17,53,0.35)]">
        <div className="flex items-center gap-3 border-b border-line bg-[#fbfaff] px-4 py-2.5 text-[11px] text-muted">
          <span className="flex gap-1.5" aria-hidden="true">
            <i className="size-2 rounded-full bg-[#e2e6f0]" />
            <i className="size-2 rounded-full bg-[#e2e6f0]" />
            <i className="size-2 rounded-full bg-[#e2e6f0]" />
          </span>
          <span className="min-w-0 flex-1 truncate font-mono">{d.path}</span>
          <Icon name="shield" className="size-3.5" />
        </div>
        <div className="grid sm:grid-cols-[190px_minmax(0,1fr)]">
          <div className="hidden flex-col gap-2 border-r border-line bg-wash p-3 sm:flex">
            <p className="eyebrow px-1">{d.knowledge}</p>
            {sources.map(([icon, key]) => (
              <div key={key} className="flex items-center gap-2 rounded-lg border border-line bg-white px-2.5 py-2">
                <Icon name={icon} className="size-4 flex-none text-blue" />
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-[11px]">{d.sources[key].name}</strong>
                  <small className="text-[10px] text-muted">{d.sources[key].note}</small>
                </span>
                <span className="size-1.5 flex-none rounded-full bg-green" aria-hidden="true" />
              </div>
            ))}
            <p className="mt-auto flex items-center gap-1.5 px-1 text-[10px] text-muted">
              <Icon name="plus" className="size-3" />
              {d.more}
            </p>
          </div>
          <div className="flex min-h-[340px] min-w-0 flex-col p-4">
            <div className="flex items-center gap-2.5">
              <ReeAvatar size="sm" />
              <span className="min-w-0 flex-1">
                <strong className="block text-[13px]">{d.ree}</strong>
                <small className="text-[11px] text-green">{d.ready}</small>
              </span>
            </div>
            <div className="mt-4 flex flex-1 flex-col gap-3" aria-live="polite">
              <p className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-blue px-3.5 py-2 text-[13px] text-white">{d[question].question}</p>
              {question === 'q3' ? (
                <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-dashed border-[#d5dbe8] bg-wash px-3.5 py-3 text-[13px]">
                  <strong className="flex items-center gap-1.5">
                    <Icon name="info" className="size-4 text-muted" />
                    {d.noAnswer}
                  </strong>
                  <p className="mt-1 text-[12px] text-muted">{d.noAnswerNote}</p>
                  <span className="tag mt-2">{d.free}</span>
                </div>
              ) : (
                <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-line bg-white px-3.5 py-3 text-[13px] leading-relaxed">
                  <p>
                    {typing ? answerText.slice(0, shown) : answerText}
                    {typing ? <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-blue align-middle" aria-hidden="true" /> : <sup className="ml-0.5 font-mono text-blue">1</sup>}
                  </p>
                  {!typing && (
                    <>
                      <button
                        type="button"
                        aria-expanded={citation}
                        onClick={() => setCitation((value) => !value)}
                        className="mt-2.5 inline-flex max-w-full items-center gap-1.5 rounded-full border border-[#d8e6fb] bg-soft px-2.5 py-1 text-[11px] font-semibold text-blue hover:border-blue"
                      >
                        <Icon name="file" className="size-3.5 flex-none" />
                        <span className="truncate">1 · {d[question].cite}</span>
                        <Icon name={citation ? 'chevronDown' : 'chevronRight'} className="size-3 flex-none" />
                      </button>
                      {citation && <blockquote className="mt-2 border-l-2 border-blue bg-wash px-3 py-2 text-[12px] text-[#3b4361]">{d[question].excerpt}</blockquote>}
                      <span className="tag mt-2.5">{d.charged}</span>
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="mt-4 border-t border-line pt-3">
              <p className="mb-2 text-[11px] text-muted">{d.pick}</p>
              <div className="flex flex-wrap gap-2">
                {QUESTIONS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => ask(id)}
                    aria-pressed={question === id}
                    className={`rounded-full border px-3 py-1.5 text-left text-[12px] transition ${
                      question === id ? 'border-blue bg-soft text-blue' : 'border-line bg-white text-ink hover:border-[#c4cce0]'
                    }`}
                  >
                    {d[id].question}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="absolute -bottom-4 left-4 hidden items-center gap-2 rounded-full border border-line bg-white px-3 py-1.5 text-[11px] font-semibold shadow-md sm:flex">
        <Icon name="file" className="size-3.5 text-blue" />
        {d.float}
      </div>
    </div>
  );
}
