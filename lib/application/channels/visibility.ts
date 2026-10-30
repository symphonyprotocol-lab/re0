/**
 * Who may see an asset, as SQL predicates over a `asset` row.
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
    where ca.asset_id = ${ref(schema.asset.id)}
      and c.visibility = 'public' and c.status = 'active'
  )`;
}

/**
 * Readable in full by anyone, signed in or not: in a public, active channel
 * and free. The predicate anonymous retrieval runs under.
 */
export function sharedWithEveryone(): SQL {
  return and(listedInPublicChannel(), eq(schema.asset.access, 'free'))!;
}

/**
 * A `paid` asset in a public, active channel that this workspace subscribes
 * to right now (proposal 6.9): a subscription in an access status whose
 * period has not ended. The period end is compared with the database's
 * clock on every read, so an expired subscription stops reading on the very
 * next call, whether or not any webhook has said so. `ACCESS_STATUSES` in
 * lib/domain/channel-commerce.ts is the same list.
 */
export function subscribedPaid(workspaceId: string): SQL {
  return sql`(${schema.asset.access} = 'paid' and exists (
    select 1 from ${schema.channelAsset} ca
    join ${schema.channel} c on c.id = ca.channel_id
    join ${schema.channelSubscription} cs on cs.channel_id = ca.channel_id
    where ca.asset_id = ${ref(schema.asset.id)}
      and c.visibility = 'public' and c.status = 'active'
      and cs.workspace_id = ${workspaceId}
      and cs.status in ('active', 'past_due', 'canceled')
      and cs.current_period_end > now()
  ))`;
}

/**
 * Readable in full by this caller: the owner sees every asset of their own;
 * a subscriber's workspace also sees the `paid` assets of the channels it
 * subscribes to; everyone else sees what is shared with everyone.
 */
export function readableBy(workspaceId: string | null): SQL {
  if (!workspaceId) return sharedWithEveryone();
  return or(eq(schema.asset.ownerWorkspaceId, workspaceId), sharedWithEveryone(), subscribedPaid(workspaceId))!;
}

/**
 * `public` when the asset is listed in a public channel, else `private`: the
 * one-word reading of the rule above that the console's lists show, now that
 * there is no column to print.
 */
export function exposure(): SQL<'public' | 'private'> {
  return sql<'public' | 'private'>`(case when ${listedInPublicChannel()} then 'public' else 'private' end)`;
}
