'use client';

import { useEffect, useRef, useState } from 'react';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { QUERY_BASE_FEE } from '@/lib/constants';
import { POST_QUESTION_MAX, type PrivateReeOption } from '@/lib/domain/post';
import { PrivatePostForm, PublicPostForm } from '@/components/posts/composer';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import './posts.css';

/** The anchor of the box on a share page and a Ree page (`#ask`): signing in comes back to it, 向它提问 scrolls to it. */
export const REE_ASK_ANCHOR = 'ask';

export type AskVisibility = 'public' | 'private';

interface AskDraft {
  text: string;
  visibility: AskVisibility;
}

/** Where a draft waits across signing in: this tab only, per Ree (its slug), so the share page and the Ree page share it. */
export function askDraftKey(slug: string): string {
  return `re0.ask.${slug}`;
}

function readDraft(slug: string): AskDraft | null {
  try {
    const raw = window.sessionStorage.getItem(askDraftKey(slug));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AskDraft>;
    return { text: typeof value.text === 'string' ? value.text.slice(0, POST_QUESTION_MAX + 50) : '', visibility: value.visibility === 'private' ? 'private' : 'public' };
  } catch {
    return null;
  }
}

function writeDraft(slug: string, draft: AskDraft | null): void {
  try {
    if (draft && (draft.text.trim() || draft.visibility === 'private')) window.sessionStorage.setItem(askDraftKey(slug), JSON.stringify(draft));
    else window.sessionStorage.removeItem(askDraftKey(slug));
  } catch {
    /* Storage blocked (a private window): the draft just is not kept. */
  }
}

/**
 * 向 {name} 提问 (稿 2, sections 5 and 6): the box a share page and a Ree page
 * end with, this Ree already named, and who sees it -- 公开帖子 (a public
 * post naming the Ree, which answers first; others may join) or 私密提问 (a
 * private post asking this Ree at its shown price; more may be added). The
 * forms are the composer's own. A visitor sees the same box with
 * 登录后提问: what they wrote and chose waits in this tab's session storage
 * and is put back when they come back signed in. From a share page
 * (`share`), a published post is that page's conversion.
 */
export function ReeAsk({ ree, option, takesPosts, signedIn, loginHref, share = null }: {
  ree: { id: string; slug: string; name: string };
  /** This Ree as the private form lists it, at the viewer's price. */
  option: PrivateReeOption;
  /** It answers public posts; when not, only 私密提问 is offered. */
  takesPosts: boolean;
  signedIn: boolean;
  loginHref: string;
  /** The share page's slug: report a published post as its conversion. */
  share?: string | null;
}) {
  const { t } = useI18n();
  const a = t.posts.ask;
  const [visibility, setVisibility] = useState<AskVisibility>(takesPosts ? 'public' : 'private');
  const [text, setText] = useState('');
  /* Bumped when a kept draft comes back, so the form starts again with it. */
  const [generation, setGeneration] = useState(0);
  const draft = useRef<AskDraft>({ text: '', visibility });

  useEffect(() => {
    const kept = readDraft(ree.slug);
    if (!kept) return;
    const shown = { text: kept.text, visibility: takesPosts ? kept.visibility : 'private' } as AskDraft;
    draft.current = shown;
    setText(shown.text);
    setVisibility(shown.visibility);
    setGeneration((value) => value + 1);
    if (window.location.hash === `#${REE_ASK_ANCHOR}`) document.getElementById(REE_ASK_ANCHOR)?.scrollIntoView({ block: 'center' });
  }, [ree.slug, takesPosts]);

  const remember = (change: Partial<AskDraft>) => {
    draft.current = { ...draft.current, ...change };
    if (change.text !== undefined) setText(change.text);
    if (change.visibility) setVisibility(change.visibility);
    /* Signed in, a draft only matters until it is sent; a visitor's must outlive the sign-in. */
    writeDraft(ree.slug, draft.current);
  };

  const published = (id: string) => {
    writeDraft(ree.slug, null);
    if (share) {
      void fetch(`/api/share/${encodeURIComponent(share)}/conversion`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ postId: id }), keepalive: true }).catch(() => undefined);
    }
  };

  const head = (
    <div className="ask-vis" role="radiogroup" aria-label={a.visibility}>
      {(['public', 'private'] as const).map((key) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={visibility === key}
          disabled={key === 'public' && !takesPosts}
          title={key === 'public' && !takesPosts ? fill(a.noPosts, { name: ree.name }) : undefined}
          onClick={() => remember({ visibility: key })}
        >
          <Icon name={key === 'public' ? 'globe' : 'lock'} className="" />
          {key === 'public' ? a.public : a.private}
        </button>
      ))}
    </div>
  );
  const placeholder = fill(a.placeholder, { name: ree.name });

  return (
    <section id={REE_ASK_ANCHOR} className="post-ask scroll-mt-24" aria-label={fill(a.heading, { name: ree.name })}>
      <div className="post-composer">
        <span className="grid size-10 place-items-center rounded-full bg-soft text-blue">
          <Icon name="chat" className="size-4" />
        </span>
        {!signedIn ? (
          <div className="post-form">
            {head}
            <div className="ree-pick">
              <span className="fu-chip ask-chip">
                <Icon name="at" className="size-3.5" />
                {ree.name}
              </span>
            </div>
            <textarea aria-label={fill(a.heading, { name: ree.name })} placeholder={placeholder} value={text} maxLength={POST_QUESTION_MAX + 50} onChange={(event) => remember({ text: event.target.value })} />
            <p className="post-hint">{a.visitorHint}</p>
            <div className="post-composer-foot">
              <small className="post-cost">{fill(a.visitorCost, { fee: QUERY_BASE_FEE })}</small>
              <Link rel="nofollow" href={loginHref} className="btn btn-sm ml-auto" onClick={() => writeDraft(ree.slug, draft.current)}>
                {a.signIn}
              </Link>
            </div>
          </div>
        ) : visibility === 'public' ? (
          <PublicPostForm key={`public:${generation}`} mention={{ id: ree.id, name: ree.name }} lockMention head={head} placeholder={placeholder} question={text} onQuestionChange={(value) => remember({ text: value })} onPublished={published} />
        ) : (
          <PrivatePostForm key={`private:${generation}`} rees={[option]} head={head} placeholder={placeholder} question={text} onQuestionChange={(value) => remember({ text: value })} onPublished={published} />
        )}
      </div>
    </section>
  );
}

