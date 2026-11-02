import type { Metadata } from 'next';
import { currentUser } from '@/lib/http/session';
import { pickerCandidates, priceFor } from '@/lib/services/conversations';
import { serverMessages } from '@/i18n/server';
import { Topbar } from '@/components/shell/topbar';
import { TalkDraft } from '@/components/conversations/talk-draft';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.conversations.talk.title };
}

/** `/talk`: a new conversation, unsaved until its first question; it starts with the user's first ready Ree. */
export default async function TalkPage() {
  const [user, { t }] = await Promise.all([currentUser(), serverMessages()]);
  const candidates = await pickerCandidates(user!.id, '');
  const first = candidates.find((ree) => ree.ownerId === user!.id && ree.ready > 0) ?? candidates.find((ree) => ree.ready > 0);
  return (
    <>
      <Topbar crumbs={[{ label: t.conversations.talk.title }]} />
      <TalkDraft initialMembers={first ? [{ ...first, price: priceFor(first, user!.id) }] : []} viewerId={user!.id} />
    </>
  );
}
