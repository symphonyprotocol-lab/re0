'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

/** How often a waiting page asks the server again, and for how long at most. */
const POLL_MS = 3_000;
const POLL_LIMIT = 120;

/**
 * Keeps a `useChat` transcript in step with the server (review C3).
 * `useChat` reads its messages once, so a page refreshed after a dropped
 * stream, or a question answered while the page was away, would never show
 * the paid answer: whenever the server hands newer `initialMessages` and
 * nothing is streaming, they replace the local copy. While the latest
 * question is still `answering` on the server (its chat hold is open) and
 * this page is not the one streaming it, the page polls and reports
 * `waiting`, so the asker is shown the wait instead of an idle composer.
 */
export function useServerTranscript<M>({
  initialMessages,
  answering,
  busy,
  setMessages,
}: {
  initialMessages: M[];
  answering: boolean;
  busy: boolean;
  setMessages: (messages: M[]) => void;
}): { waiting: boolean } {
  const router = useRouter();
  const seen = useRef(initialMessages);
  const set = useRef(setMessages);
  set.current = setMessages;
  useEffect(() => {
    if (seen.current === initialMessages) return;
    seen.current = initialMessages;
    if (!busy) set.current(initialMessages);
  }, [initialMessages, busy]);

  const waiting = answering && !busy;
  useEffect(() => {
    if (!waiting) return;
    let polls = 0;
    const timer = window.setInterval(() => {
      polls += 1;
      if (polls > POLL_LIMIT) window.clearInterval(timer);
      else router.refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [waiting, router]);
  return { waiting };
}
