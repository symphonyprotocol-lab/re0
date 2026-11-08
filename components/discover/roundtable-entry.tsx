'use client';

import { useState } from 'react';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { autoTitle } from '@/lib/domain/conversation';
import { ApiError, conversationApi, stashPending } from '@/lib/client/conversations';
import type { ReeCard } from '@/lib/services/explore';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { useToast } from '@/components/ui/toast';

/**
 * "一起问前 3 个 Ree" (ree-council-proposal.md 4.4): above the search
 * results, never on a card (2.4 keeps cards free of inputs and buttons). It
 * starts a conversation with the top Rees and sends the question there,
 * where a synthesis of their answers is one click away. A visitor signs in
 * first, as with 「加入对话」.
 */
export function RoundtableEntry({ question, rees, signedIn, returnTo }: { question: string; rees: Pick<ReeCard, 'id' | 'name' | 'price' | 'avatarBlob' | 'color'>[]; signedIn: boolean; returnTo: string }) {
  const { t, locale } = useI18n();
  const e = t.discover.explore.roundtable;
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const cost = rees.reduce((sum, ree) => sum + ree.price, 0);

  const start = async () => {
    setBusy(true);
    try {
      const { id } = await conversationApi.create(rees.map((ree) => ree.id), autoTitle(question));
      stashPending(id, { question, scope: null });
      router.push(`/chats/${id}`);
    } catch (error) {
      setBusy(false);
      toast(error instanceof ApiError && error.code === 'ree_unavailable' ? t.conversations.room.unavailable : e.failed);
    }
  };

  return (
    <section className="roundtable-entry" aria-label={fill(e.title, { n: rees.length })}>
      <div className="roundtable-entry-avatars" aria-hidden="true">
        {rees.map((ree) => (
          <ReeAvatar key={ree.id} avatar={ree.avatarBlob} color={ree.color} size="sm" className="roundtable-entry-avatar" />
        ))}
      </div>
      <div className="roundtable-entry-text">
        <strong>{fill(e.title, { n: rees.length })}</strong>
        <span>
          {rees.map((ree) => ree.name).join(' · ')} — {e.body}
        </span>
      </div>
      {signedIn ? (
        <button type="button" className="btn sm" onClick={start} disabled={busy}>
          {busy ? <i className="spinner" /> : <Icon name="users" />}
          {e.ask}
          <small>· {fill(e.cost, { n: formatNumber(cost, locale) })}</small>
        </button>
      ) : (
        <Link href={`/login?returnTo=${encodeURIComponent(returnTo)}`} className="btn sm">
          <Icon name="users" />
          {e.login}
        </Link>
      )}
    </section>
  );
}
