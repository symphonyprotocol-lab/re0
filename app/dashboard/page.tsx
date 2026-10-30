import type { Metadata } from 'next';
import Link from 'next/link';
import { PANEL, PageHeader } from '@/components/dashboard/ui';
import { Playground } from '@/components/site/playground';
import { ArrowUpRightIcon, PlusIcon } from '@/components/ui/icons';
import {
  actionsByIds,
  conversationTurns,
  latestConversation,
  listActions,
  pendingTargets,
} from '@/lib/application/agent';
import { listWorkspaceChannels } from '@/lib/application/channels';
import { listWorkspaceLibraries } from '@/lib/application/libraries';
import { cardOf } from '@/lib/dashboard/action-card';
import type { PlaygroundUIMessage } from '@/lib/http/playground-stream';
import { requireSession } from '@/lib/http/session';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.workbench.metaTitle };
}

const CARDS_SHOWN = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Search = { searchParams: Promise<{ q?: string; c?: string; new?: string }> };

/**
 * The Agent workbench (agent-first-proposal.md 4.4): the conversation on the
 * left, the workspace's asset and channel cards on the right.
 *
 * The two halves read the same rows. A pending action the conversation
 * proposes shows on the card of the asset or channel it names; confirming
 * it on its card in the conversation refreshes the page, so the cards show
 * the build, the move, the new channel. `?q=` carries a question in from
 * /playground or the home page and sends it once; `?c=` reopens one
 * conversation, `?new=1` starts one, and by default the latest continues.
 */
export default async function WorkbenchPage({ searchParams }: Search) {
  const [session, { t }, query] = await Promise.all([requireSession('/dashboard'), translations(), searchParams]);
  const w = t.dashboard.workbench;
  const workspaceId = session.workspace.id;

  const conversationId =
    query.new === '1'
      ? null
      : query.c && UUID.test(query.c)
        ? query.c
        : ((await latestConversation(workspaceId))?.id ?? null);
  const [assets, channels, pending, turns] = await Promise.all([
    listWorkspaceLibraries(workspaceId),
    listWorkspaceChannels(workspaceId),
    listActions(workspaceId, { pendingOnly: true, limit: 200 }),
    conversationId && !query.q ? conversationTurns(workspaceId, conversationId) : Promise.resolve([]),
  ]);
  const targets = pendingTargets(pending);
  const initialMessages = await rebuildMessages(workspaceId, turns);
  const initialQuestion = typeof query.q === 'string' && query.q.trim() ? query.q.trim().slice(0, 2_000) : null;

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader eyebrow={session.workspace.name} title={w.title} description={w.description} />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          <div className="mb-2 flex justify-end">
            <Link href="/dashboard?new=1" className="flex items-center gap-1 text-[11.5px] text-brandink hover:underline">
              <PlusIcon size={12} />
              {w.newConversation}
            </Link>
          </div>
          <Playground
            key={initialQuestion ? `q:${initialQuestion}` : (conversationId ?? 'new')}
            mode="workbench"
            signedIn
            initialQuestion={initialQuestion}
            conversationId={initialQuestion ? null : conversationId}
            initialMessages={initialMessages}
          />
        </div>

        <aside className="flex flex-col gap-4">
          {pending.length > 0 ? (
            <Link
              href="/dashboard/actions"
              className="flex items-center justify-between rounded-md border border-warnsoft bg-warnsoft/50 px-3.5 py-2.5 text-[12px] font-medium text-warn"
            >
              {fill(w.pending, { n: String(pending.length) })}
              <ArrowUpRightIcon size={13} />
            </Link>
          ) : null}

          <section className={`${PANEL} p-4`}>
            <div className="flex items-center justify-between">
              <h2 className="text-[13px] font-medium text-ink">{w.assetsHeading}</h2>
              <Link href="/dashboard/assets" className="text-[11px] text-brandink hover:underline">
                {w.viewAll}
              </Link>
            </div>
            {assets.length === 0 ? (
              <p className="mt-2 text-[12px] text-muted">
                {w.noAssets}{' '}
                <Link href="/dashboard/assets/new" className="text-brandink hover:underline">
                  {w.addAsset}
                </Link>
              </p>
            ) : (
              <ul className="mt-2.5 flex flex-col gap-2">
                {assets.slice(0, CARDS_SHOWN).map((asset) => (
                  <li key={asset.id}>
                    <Link
                      href={`/dashboard/assets/${asset.id}`}
                      className="flex flex-col gap-0.5 rounded-md border border-line px-3 py-2 transition-colors hover:bg-subtle"
                    >
                      <span className="truncate text-[12.5px] text-ink">{asset.title}</span>
                      <span className="truncate font-mono text-[10.5px] text-faint">{asset.publicId}</span>
                      <span className="flex flex-wrap gap-x-2 text-[10.5px] text-muted">
                        <span>{asset.kind}</span>
                        <span>{asset.channel ? `/channels/${asset.channel.slug}` : w.unfiled}</span>
                        {asset.building ? <span className="text-brandink">{w.building}</span> : null}
                        {targets.get(asset.id) ? (
                          <span className="text-warn">{fill(w.pending, { n: String(targets.get(asset.id)) })}</span>
                        ) : null}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={`${PANEL} p-4`}>
            <div className="flex items-center justify-between">
              <h2 className="text-[13px] font-medium text-ink">{w.channelsHeading}</h2>
              <Link href="/dashboard/channels" className="text-[11px] text-brandink hover:underline">
                {channels.length === 0 ? w.openChannels : w.viewAll}
              </Link>
            </div>
            {channels.length === 0 ? (
              <p className="mt-2 text-[12px] text-muted">{w.noChannels}</p>
            ) : (
              <ul className="mt-2.5 flex flex-col gap-2">
                {channels.slice(0, CARDS_SHOWN).map((channel) => (
                  <li key={channel.id}>
                    <Link
                      href={`/dashboard/channels/${channel.id}`}
                      className="flex flex-col gap-0.5 rounded-md border border-line px-3 py-2 transition-colors hover:bg-subtle"
                    >
                      <span className="truncate text-[12.5px] text-ink">{channel.title}</span>
                      <span className="flex flex-wrap gap-x-2 text-[10.5px] text-muted">
                        <span className="font-mono">/channels/{channel.slug}</span>
                        <span>{channel.visibility}</span>
                        <span>{fill(w.assetsCount, { n: String(channel.assetCount) })}</span>
                        {targets.get(channel.id) ? (
                          <span className="text-warn">{fill(w.pending, { n: String(targets.get(channel.id)) })}</span>
                        ) : null}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

/**
 * The conversation so far as the transcript's own messages, from what the
 * server recorded. A proposal is shown in its state now -- confirmed,
 * declined or expired since -- not as it was when proposed.
 */
async function rebuildMessages(
  workspaceId: string,
  turns: Awaited<ReturnType<typeof conversationTurns>>,
): Promise<PlaygroundUIMessage[]> {
  const messages: PlaygroundUIMessage[] = [];
  const actions = await actionsByIds(
    workspaceId,
    turns.flatMap((turn) => ((turn.content as { actions?: string[] }).actions ?? [])),
  );
  for (const turn of turns) {
    const content = turn.content as Record<string, unknown>;
    if (turn.role === 'user') {
      messages.push({ id: turn.id, role: 'user', parts: [{ type: 'text', text: String(content.question ?? '') }] });
      continue;
    }
    const parts: PlaygroundUIMessage['parts'] = [];
    for (const listing of (content.listings as PlaygroundUIMessage['parts'][number][] | undefined) ?? []) {
      parts.push({ type: 'data-listing', data: listing as never });
    }
    for (const actionId of (content.actions as string[] | undefined) ?? []) {
      const action = actions.get(actionId);
      if (!action) continue;
      parts.push({ type: 'data-action', id: action.id, data: cardOf(action) });
    }
    for (const refusal of (content.refused as { tool: string; code: string; message: string }[] | undefined) ?? []) {
      parts.push({ type: 'data-refused', data: refusal as never });
    }
    const sources = (content.sources as Record<string, unknown>[] | undefined) ?? [];
    if (sources.length > 0) {
      parts.push({ type: 'data-sources', data: { sources: sources.map((source) => ({ ...source, codeBlocks: [] })) as never } });
    }
    for (const claim of (content.claims as { claim: string; chunkIds: string[] }[] | undefined) ?? []) {
      parts.push({ type: 'data-claim', data: claim });
    }
    const outcome = typeof content.outcome === 'string' ? content.outcome : 'acted';
    parts.push({ type: 'data-outcome', data: { kind: outcome as never } });
    messages.push({ id: turn.id, role: 'assistant', parts });
  }
  return messages;
}
