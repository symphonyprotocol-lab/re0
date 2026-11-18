'use client';

import { useState } from 'react';
import type { CitationSnapshot } from '@/lib/domain/answer';
import type { PublicQa } from '@/lib/domain/public-qa';
import { useI18n } from '@/i18n/client';
import { formatRelative } from '@/i18n/format';
import { CitationDrawer } from '@/components/chat/message-parts';
import { AnswerBubble, QaThread, type QaRee } from '@/components/discover/public-qa';
import { Icon } from '@/components/ui/icons';

/** The share page's "大家问过的": a few public answers in the Ree page's style, read-only; the whole stream is on the Ree page. */
export function SharePicks({ ree, items, renderedAt }: { ree: QaRee; items: PublicQa[]; renderedAt: number }) {
  const { t, locale } = useI18n();
  const q = t.discover.public.qa;
  const [citation, setCitation] = useState<CitationSnapshot | null>(null);
  return (
    <div className="share-picks">
      {items.map((item) => (
        <QaThread
          key={item.id}
          asker={item.asker === 'user' ? q.someUser : q.visitor}
          question={item.question}
          meta={
            <>
              <span>· {formatRelative(item.publishedAt, renderedAt, locale, q.justNow)}</span>
              {item.pinned && (
                <span className="tag">
                  <Icon name="pin" className="size-3" />
                  {q.pinned}
                </span>
              )}
            </>
          }
          answer={<AnswerBubble ree={ree} text={item.answer} citations={item.citations} onCitation={setCitation} />}
        />
      ))}
      <CitationDrawer citation={citation} ree={ree} canOpen={false} onClose={() => setCitation(null)} />
    </div>
  );
}
