'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n/client';
import { Icon, type IconName } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';
import { ReeAvatar } from '@/components/ui/ree-avatar';

type QuestionId = 'q1' | 'q2' | 'q3';
const QUESTIONS: QuestionId[] = ['q1', 'q2', 'q3'];

/**
 * The question-and-answer window (prototype suite.js `demoVisual`): a Ree with
 * four sources answering with a citation. On the page it shows the first
 * answer and its citation opens the source (prototype `home-citation`); in the
 * dialog you pick a question and it answers, or says it does not know and
 * charges nothing. Scripted, no model call.
 */
function DemoWindow({ interactive = false }: { interactive?: boolean }) {
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
    if (interactive) askRef.current('q1');
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [interactive]);

  const typing = shown !== Number.POSITIVE_INFINITY;
  const sources: [IconName, keyof typeof d.sources][] = [
    ['file', 'handbook'],
    ['github', 'repo'],
    ['audio', 'audio'],
    ['globe', 'site'],
  ];
  const cite = question === 'q3' ? null : d[question].cite;

  return (
    <>
      <div className="hero-demo" role="region" aria-label={d.label}>
        <div className="demo-window-head">
          <span aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>{d.path}</span>
          <Icon name="shield" />
        </div>
        <div className="demo-window-body">
          <div className="demo-source-panel">
            <p className="eyebrow">KNOWLEDGE</p>
            {sources.map(([icon, key]) => (
              <div key={key} className="demo-source">
                <Icon name={icon} />
                <div>
                  <strong>{d.sources[key].name}</strong>
                  <small>{d.sources[key].note}</small>
                </div>
                <span className="dot" aria-hidden="true" />
              </div>
            ))}
            <div className="demo-add">
              <Icon name="plus" /> {d.more}
            </div>
          </div>
          <div className="demo-conversation" aria-live={interactive ? 'polite' : undefined}>
            <div className="demo-ree">
              <ReeAvatar size="sm" className="dot-avatar sm" />
              <span>
                {d.ree}
                <small>{d.ready}</small>
              </span>
              <span className="demo-online" aria-hidden="true" />
            </div>
            <div className="demo-user">{d[question].question}</div>
            {question === 'q3' ? (
              <div className="demo-answer">
                <span className="demo-answer-icon">
                  <Icon name="info" />
                </span>
                <p>
                  {d.noAnswer}
                  {'\n'}
                  {d.noAnswerNote}
                </p>
                <span className="tag demo-charge">{d.free}</span>
              </div>
            ) : (
              <div className="demo-answer">
                <span className="demo-answer-icon">
                  <Icon name="sparkle" />
                </span>
                <p>
                  {typing ? answerText.slice(0, shown) : answerText} {!typing && <sup>1</sup>}
                </p>
                {!typing && (
                  <>
                    <button
                      type="button"
                      className="citation-chip"
                      aria-expanded={interactive ? citation : undefined}
                      onClick={() => setCitation((value) => !value)}
                    >
                      <Icon name="file" /> 1 · {cite} <Icon name="external" />
                    </button>
                    {interactive && citation && <blockquote className="citation-preview">{d[question as 'q1' | 'q2'].excerpt}</blockquote>}
                    {interactive && <span className="tag demo-charge">{d.charged}</span>}
                  </>
                )}
              </div>
            )}
            <div className="demo-compose">
              {d.compose}
              <span>
                <Icon name="arrow" className="-rotate-90" />
              </span>
            </div>
          </div>
        </div>
        <div className="demo-float-label">
          <Icon name="file" />
          {d.float}
        </div>
      </div>
      {interactive ? (
        <div className="demo-picks">
          <p>{d.pick}</p>
          <div>
            {QUESTIONS.map((id) => (
              <button key={id} type="button" onClick={() => ask(id)} aria-pressed={question === id}>
                {d[id].question}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <Modal open={citation} onClose={() => setCitation(false)} title={d.sourceTitle} subtitle={d.q1.cite}>
          <div className="citation-preview">{d.q1.excerpt}</div>
        </Modal>
      )}
    </>
  );
}

/** The hero's question-and-answer window. */
export function HomeDemo() {
  return <DemoWindow />;
}

/** The hero's "看看它如何回答" (prototype `home-demo`): the same window in a dialog, where you pick the question. */
export function DemoTrigger({ label }: { label: string }) {
  const { t } = useI18n();
  const d = t.site.demo;
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn secondary large" onClick={() => setOpen(true)}>
        <Icon name="play" />
        {label}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={d.dialogTitle}
        subtitle={d.dialogNote}
        wide
        footer={
          <Link href="/explore" className="btn">
            {d.explore}
            <Icon name="arrow" />
          </Link>
        }
      >
        <div className="home-demo-modal">
          <DemoWindow interactive />
        </div>
      </Modal>
    </>
  );
}
