/**
 * Who may see an asset, as SQL predicates over a `library` row.
 * agent-first-proposal.md 6.2; architecture.md 5.2, 9.6, 10.
 *
 * The Policy Engine decides visibility while it fixes which assets and
 * versions a request may touch, before anything is recalled: an invisible
 * asset and a nonexistent one must be indistinguishable, so invisibility is a
 * recall predicate, never a filter over rows already read. Every query that
 * reads assets for someone other than their owner -- routing, retrieval, the
 * public pages, the sitemap, the directory, A2A -- goes through these, and
 * nothing else decides it. `lib/domain/channel.ts` `assetSight` is the same
 * table in TypeScript, for rows already in hand.
 *
 * `ref` keeps the outer row's qualification inside the correlated subquery,
 * which Drizzle would otherwise strip in a single-table select.
 */
import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import { ref } from '@/lib/application/administration/column-ref';
import { schema } from '@/lib/infrastructure/postgres/client';

/**
 * In a public, active channel -- whatever its `access`. What the channel page
 * and the directory list: a paid asset there shows its title and summary to
 * everyone (proposal 6.2, "只见标题、摘要和发布时间").
 */
export function listedInPublicChannel(): SQL {
  return sql`exists (
    select 1 from ${schema.channelAsset} ca
    join ${schema.channel} c on c.id = ca.channel_id
    where ca.asset_id = ${ref(schema.library.id)}
      and c.visibility = 'public' and c.status = 'active'
  )`;
}

/**
 * Readable in full by anyone, signed in or not: in a public, active channel
 * and free. The predicate anonymous retrieval runs under.
 */
export function sharedWithEveryone(): SQL {
  return and(listedInPublicChannel(), eq(schema.library.access, 'free'))!;
}

/**
 * Readable in full by this caller: the owner sees every asset of their own,
 * everyone else sees what is shared with everyone. Subscriptions add `paid`
 * assets in P3a; until then a paid asset is its owner's alone to read.
 */
export function readableBy(workspaceId: string | null): SQL {
  if (!workspaceId) return sharedWithEveryone();
  return or(eq(schema.library.ownerWorkspaceId, workspaceId), sharedWithEveryone())!;
}

/**
 * `public` when the asset is listed in a public channel, else `private`: the
 * one-word reading of the rule above that the console's lists show, now that
 * there is no column to print.
 */
export function exposure(): SQL<'public' | 'private'> {
  return sql<'public' | 'private'>`(case when ${listedInPublicChannel()} then 'public' else 'private' end)`;
}
