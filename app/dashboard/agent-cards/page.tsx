import type { Metadata } from 'next';
import Link from 'next/link';
import { CopyButton } from '@/components/dashboard/copy-button';
import { PANEL, PageHeader } from '@/components/dashboard/ui';
import { cardUrl } from '@/lib/application/a2a/card';
import { isPublicChannel, listWorkspaceChannels } from '@/lib/application/channels';
import { workspaceHandle } from '@/lib/application/workspaces/handle';
import { appBaseUrl } from '@/lib/http/base-url';
import { requireSession } from '@/lib/http/session';
import { getMessages, translations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.agentCards.metaTitle };
}

/**
 * 我的用户卡与频道卡 (agent-first-proposal.md 4.4, 7.1): where other agents
 * find this workspace -- its user card and one card per public channel. A
 * private channel has no card and is not listed.
 */
export default async function AgentCardsPage() {
  const [session, { t }] = await Promise.all([requireSession('/dashboard/agent-cards'), translations()]);
  const c = t.dashboard.agentCards;
  const origin = appBaseUrl().replace(/\/+$/, '');
  const [handle, channels] = await Promise.all([
    workspaceHandle(session.workspace.id),
    listWorkspaceChannels(session.workspace.id),
  ]);
  const publicChannels = channels.filter((channel) => isPublicChannel(channel));
  const platform = cardUrl(origin, { key: '' });

  const row = (label: string, url: string) => (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[12px] text-ink">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-subtle px-2 py-1 font-mono text-[11px] text-muted">{url}</code>
      <CopyButton value={url} label={`${label}: ${url}`} className="text-muted hover:bg-mutedbg" />
    </div>
  );

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader eyebrow={session.workspace.name} title={c.title} description={c.description} />

      <section className={`${PANEL} flex flex-col gap-3 p-5`}>
        <h2 className="text-[13px] font-medium text-ink">{c.userCard}</h2>
        {handle ? row(`@${handle}`, cardUrl(origin, { key: `users/${handle}` })) : null}
        <p className="text-[11.5px] leading-[1.6] text-muted">{c.userCardHint}</p>
        {publicChannels.length === 0 ? <p className="text-[11.5px] text-faint">{c.noPublicChannel}</p> : null}
      </section>

      <section className={`${PANEL} flex flex-col gap-3 p-5`}>
        <h2 className="text-[13px] font-medium text-ink">{c.channelCards}</h2>
        {publicChannels.length === 0 ? <p className="text-[12px] text-muted">{c.noChannelCards}</p> : null}
        {publicChannels.map((channel) => (
          <div key={channel.id}>{row(channel.title, cardUrl(origin, { key: `channels/${channel.slug}` }))}</div>
        ))}
      </section>

      <section className={`${PANEL} flex flex-col gap-3 p-5`}>
        <h2 className="text-[13px] font-medium text-ink">{c.platformCard}</h2>
        {row('re0', platform)}
        <p className="text-[11.5px] leading-[1.6] text-muted">{c.platformCardHint}</p>
      </section>

      <Link href="/dashboard/api-keys" className="text-[12px] text-brandink hover:underline">
        {c.apiKeysLink}
      </Link>
    </div>
  );
}
