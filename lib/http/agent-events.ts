/**
 * The Agent loop's events as UI message stream parts, for both doors that
 * run it: the public playground (/api/playground) and the workbench
 * (/api/agent). One writer, so the two transcripts cannot drift apart --
 * agent-first-proposal.md 4.5: one loop, one generation chain, only the tool
 * set differs.
 *
 * There is no text part: claims arrive bound (requirement.md 5.1), and
 * actions and listings arrive as the server's own data, never as prose.
 */
import type { UIMessageStreamWriter } from 'ai';
import type { AgentEvent } from '@/lib/application/playground/agent';
import { fencedCodeBlocks } from '@/lib/domain/code-blocks';
import type { PlaygroundUIMessage } from './playground-stream';

/** What one exchange showed, for the workbench's record of the conversation. */
export interface ExchangeRecord {
  claims: { claim: string; chunkIds: string[] }[];
  sources: { chunkId: string; sourceUrl: string; documentTitle: string; section: string | null; assetId: string; assetTitle: string }[];
  actions: string[];
  refused: { tool: string; code: string; message: string }[];
  listings: unknown[];
  outcome: string | null;
}

export function emptyRecord(): ExchangeRecord {
  return { claims: [], sources: [], actions: [], refused: [], listings: [], outcome: null };
}

export function writeAgentEvent(
  writer: UIMessageStreamWriter<PlaygroundUIMessage>,
  event: AgentEvent,
  context: { question: string; requestId: string; record?: ExchangeRecord },
): void {
  const record = context.record;
  switch (event.type) {
    case 'routing':
      writer.write({
        type: 'data-routing',
        data: {
          question: context.question,
          candidates: event.candidates,
          assetId: event.top?.assetId ?? null,
          assetTitle: event.top?.title ?? null,
          version: event.top?.version ?? null,
          requestId: context.requestId,
          pinned: event.pinned,
        },
      });
      return;
    case 'no_asset':
      writer.write({ type: 'data-outcome', data: { kind: 'no_asset' } });
      if (record) record.outcome = 'no_asset';
      return;
    case 'step':
      /* Same id twice: the running card is replaced by the finished one. */
      writer.write({ type: 'data-step', id: event.step.id, data: event.step });
      return;
    case 'resolved':
      writer.write({ type: 'data-resolved', data: { question: event.question } });
      return;
    case 'gather':
      writer.write({ type: 'data-gather', data: { assets: event.assets } });
      return;
    case 'model':
      writer.write({ type: 'data-model', data: { label: event.label, audience: event.audience, upgrade: event.upgrade } });
      return;
    case 'context': {
      const sources = event.chunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        sourceUrl: chunk.citation.sourceUrl,
        documentTitle: chunk.citation.documentTitle,
        section: chunk.citation.section,
        assetId: chunk.assetId,
        assetTitle: chunk.assetTitle,
        codeBlocks: fencedCodeBlocks(chunk.text),
      }));
      writer.write({ type: 'data-sources', data: { sources } });
      if (record) record.sources = sources.map(({ codeBlocks: _codeBlocks, ...source }) => source);
      return;
    }
    case 'claim':
      writer.write({ type: 'data-claim', data: { claim: event.claim, chunkIds: event.chunkIds } });
      record?.claims.push({ claim: event.claim, chunkIds: event.chunkIds });
      return;
    case 'rewrite':
      writer.write({ type: 'data-rewrite', data: { query: event.query } });
      return;
    case 'action':
      writer.write({
        type: 'data-action',
        id: event.action.id,
        data: {
          id: event.action.id,
          tool: event.action.tool,
          state: event.action.state,
          summary: event.action.summary,
          digest: event.action.digest,
          expiresAt: event.action.expiresAt,
          error: event.action.error,
        },
      });
      record?.actions.push(event.action.id);
      return;
    case 'refused':
      writer.write({ type: 'data-refused', data: { tool: event.tool, code: event.code, message: event.message } });
      record?.refused.push({ tool: event.tool, code: event.code, message: event.message });
      return;
    case 'listing': {
      const data =
        event.listing.kind === 'assets'
          ? {
              kind: 'assets' as const,
              total: event.listing.listing.total,
              assets: event.listing.listing.assets.map((asset) => ({
                id: asset.id,
                publicId: asset.publicId,
                title: asset.title,
                kind: asset.kind,
                channel: asset.channel?.slug ?? null,
                status: asset.status,
                building: asset.building,
              })),
            }
          : event.listing.kind === 'delegations'
            ? { kind: 'delegations' as const, delegations: event.listing.delegations }
            : {
                kind: 'subscriptions' as const,
                channels: event.listing.summary.channels.map((channel) => ({
                  slug: channel.slug,
                  title: channel.title,
                  visibility: channel.visibility,
                  assets: channel.assets,
                })),
                usedBytes: event.listing.summary.storage.usedBytes,
                capacityBytes: event.listing.summary.storage.capacityBytes,
              };
      writer.write({ type: 'data-listing', data });
      /*
       * An external Agent's output is an A2A body, purged after 30 days
       * (proposal 10): the conversation keeps which delegations were shown,
       * and the workbench reads them back from their rows.
       */
      record?.listings.push(
        data.kind === 'delegations' ? { kind: 'delegations', delegationIds: data.delegations.map((delegation) => delegation.id) } : data,
      );
      return;
    }
    case 'acted':
      writer.write({ type: 'data-outcome', data: { kind: 'acted' } });
      if (record) record.outcome = 'acted';
      return;
    case 'done':
      writer.write({ type: 'data-outcome', data: { kind: event.kind } });
      if (record) record.outcome = event.kind;
      return;
  }
}
