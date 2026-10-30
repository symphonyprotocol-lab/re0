import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { CopyButton } from '@/components/dashboard/copy-button';
import { ChannelGrid } from '@/components/site/channel-grid';
import { ArrowUpRightIcon, BotIcon } from '@/components/ui/icons';
import { userByHandle } from '@/lib/application/channels';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';
import { publicUrl } from '@/lib/site/origin';

type Props = { params: Promise<{ handle: string }> };

const userFor = cache((handle: string) => userByHandle(handle));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params;
  const [user, { channels: c }] = await Promise.all([userFor(handle), getMessages()]);
  if (!user) return { title: c.user.eyebrow };
  const canonical = `/u/${user.handle}`;
  return { title: fill(c.user.metaTitle, { name: user.name }), alternates: { canonical }, openGraph: { url: canonical } };
}

/**
 * A user's public page (agent-first-proposal.md 4.3): their public name,
 * their public channels and the address of their user Agent Card. A user
 * without a public channel has no public page.
 */
export default async function UserPage({ params }: Props) {
  const { handle } = await params;
  const [user, { locale, t }] = await Promise.all([userFor(handle), translations()]);
  if (!user) notFound();
  const c = t.channels;
  const cardUrl = publicUrl(`/a2a/users/${user.handle}/agent-card.json`);

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-5 pt-12 pb-20">
      <link rel="agent-card" href={cardUrl} type="application/json" />
      <header className="flex flex-col gap-2">
        <p className="eyebrow">{c.user.eyebrow}</p>
        <h1 className="text-[36px] leading-[1.25] font-semibold tracking-[0.018em] text-ink">{user.name}</h1>
        <p className="font-mono text-caption text-muted">@{user.handle}</p>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="text-[17px] font-medium text-ink">{c.user.channels}</h2>
        <ChannelGrid entries={user.channels} locale={locale} />
      </section>

      <section className="flex max-w-[640px] flex-col gap-3 rounded-lg border border-line bg-card p-5">
        <h2 className="flex items-center gap-2 text-[15px] font-medium text-ink">
          <BotIcon size={16} className="text-brandink" />
          {c.user.agentTitle}
        </h2>
        <p className="text-[12.5px] leading-[1.6] text-muted">{c.user.agentBody}</p>
        <span className="flex items-center gap-2 rounded-md border border-line bg-subtle py-1 pr-1 pl-3">
          <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink">{cardUrl}</code>
          <CopyButton value={cardUrl} label={c.user.agentTitle} className="text-steel hover:bg-card" />
        </span>
        <Link
          href={`/a2a/users/${user.handle}/agent-card.json`}
          className="inline-flex items-center gap-1.5 text-[12px] text-brandink hover:underline"
        >
          {c.user.agentTitle}
          <ArrowUpRightIcon size={13} />
        </Link>
      </section>
    </div>
  );
}
