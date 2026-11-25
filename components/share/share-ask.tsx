'use client';

import type { ReactNode } from 'react';
import { focusAsk } from '@/components/posts/ree-ask';
import { REE_ASK_ANCHOR } from '@/lib/domain/post';
import { Icon } from '@/components/ui/icons';

/**
 * The share page's ways into 向 {name} 提问 at its foot: the hero's button
 * (the box, its question in focus) and 可以这样问它 (the picked question
 * put in first). Without script they are links to `#ask`.
 */
export function AskJump({ slug, className, children }: { slug: string; className: string; children: ReactNode }) {
  return (
    <a
      href={`#${REE_ASK_ANCHOR}`}
      className={className}
      onClick={(event) => {
        event.preventDefault();
        focusAsk(slug);
      }}
    >
      {children}
    </a>
  );
}

export function TryQuestions({ slug, questions, live }: { slug: string; questions: string[]; live: boolean }) {
  return (
    <ul className="share-questions">
      {questions.map((question) => (
        <li key={question}>
          {live ? (
            <a
              href={`#${REE_ASK_ANCHOR}`}
              className="share-question"
              onClick={(event) => {
                event.preventDefault();
                focusAsk(slug, question);
              }}
            >
              <span>{question}</span>
              <Icon name="arrow" className="size-3.5 flex-none" />
            </a>
          ) : (
            <span className="share-question">{question}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 问问这个 under a product feature: its question put into the box, which takes focus. */
export function AskAbout({ slug, question, children }: { slug: string; question: string; children: ReactNode }) {
  return (
    <a
      href={`#${REE_ASK_ANCHOR}`}
      className="share-link share-feature-ask"
      onClick={(event) => {
        event.preventDefault();
        focusAsk(slug, question);
      }}
    >
      {children}
      <Icon name="arrow" />
    </a>
  );
}
