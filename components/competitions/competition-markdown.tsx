'use client';

import { Markdown } from '@/components/posts/markdown';

/** A competition's rules as Markdown: no citations in them, so a marker stays as written. */
export function CompetitionMarkdown({ text }: { text: string }) {
  return <Markdown text={text} citation={(index, key) => <span key={key}>[{index}]</span>} className="flex flex-col gap-3 text-[13px] leading-relaxed" />;
}
