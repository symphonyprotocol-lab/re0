'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CONVERSATION_MAX_REES } from '@/lib/constants';
import { ApiError, conversationApi } from '@/lib/client/conversations';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { useToast } from '@/components/ui/toast';

/**
 * 「加入对话」, the public page's only action (8.2, "公开页提问"): pick an
 * existing conversation that is not full and does not have it yet, or start
 * a new one. A visitor is sent to sign in first and comes back with the
 * dialog open.
 */
export function JoinButton({
  ree,
  signedIn,
  conversations,
  returnTo,
  openOnLoad,
}: {
  ree: { id: string; name: string; description: string; avatarBlob: string | null; color: string; price: number };
  signedIn: boolean;
  conversations: { id: string; title: string; members: number }[];
  returnTo: string;
  openOnLoad: boolean;
}) {
  const { t } = useI18n();
  const p = t.discover.public;
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (signedIn && openOnLoad) setOpen(true);
  }, [signedIn, openOnLoad]);

  if (!signedIn) {
    return (
      <Link href={`/login?returnTo=${encodeURIComponent(returnTo)}`} className="btn w-full justify-center">
        <Icon name="plus" />
        {p.join}
      </Link>
    );
  }

  const fail = (error: unknown) => {
    setBusy(false);
    toast(error instanceof ApiError && error.code === 'too_many_rees' ? t.conversations.room.full : t.common.errors.generic);
  };

  return (
    <>
      <button type="button" className="btn w-full justify-center" onClick={() => setOpen(true)}>
        <Icon name="plus" />
        {p.join}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={p.joinTitle} subtitle={`${ree.name} · ${fill(t.conversations.room.perAnswer, { n: ree.price })}`}>
        <div className="flex items-center gap-3">
          <ReeAvatar avatar={ree.avatarBlob} color={ree.color} />
          <div className="min-w-0">
            <strong className="block truncate text-[13px]">{ree.name}</strong>
            <p className="line-clamp-2 text-[11px] text-muted">{ree.description}</p>
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-2">
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              disabled={busy}
              className="btn-secondary w-full justify-between"
              onClick={async () => {
                setBusy(true);
                try {
                  await conversationApi.addRee(conversation.id, ree.id);
                  toast(p.joined);
                  router.push(`/chats/${conversation.id}`);
                } catch (error) {
                  fail(error);
                }
              }}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Icon name="chat" className="flex-none" />
                <span className="truncate">{conversation.title || t.conversations.sidebar.untitled}</span>
              </span>
              <small className="font-mono text-muted">
                {conversation.members}/{CONVERSATION_MAX_REES}
              </small>
            </button>
          ))}
          {conversations.length === 0 && <p className="text-[11px] text-muted">{p.joinNone}</p>}
        </div>
        <div className="my-4 border-t border-line" />
        <button
          type="button"
          className="btn w-full justify-center"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const { id } = await conversationApi.create([ree.id], fill(p.joinNewTitle, { name: ree.name }).slice(0, 120));
              router.push(`/chats/${id}`);
            } catch (error) {
              fail(error);
            }
          }}
        >
          <Icon name="plus" />
          {p.joinNew}
        </button>
      </Modal>
    </>
  );
}
