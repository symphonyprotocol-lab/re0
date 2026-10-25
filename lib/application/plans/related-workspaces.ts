/**
 * Related workspaces. publisher-revenue-share.md 5: calls between workspaces
 * under one payer or one controller are self-calls as far as earning goes --
 * otherwise a publisher opens a second workspace and reads their own library
 * from it, and the owner-workspace test alone never sees it.
 *
 * Two workspaces are related when either holds:
 *
 *   - one payment subject: a provider customer id appears on subscriptions of
 *     both, at any time. Paddle keys a customer by email, so one payer paying
 *     for two workspaces is one customer however far apart the payments are;
 *   - one controller: a user is owner or admin of both -- the roles that run a
 *     workspace's billing and keys (BILLING_ROLES in billing/checkout.ts).
 *
 * The share doc also names "one payment method". architecture.md 11.3 keeps
 * card data at the provider -- `billing_document.method` is a type, never an
 * instrument -- and Paddle scopes a saved payment method to its customer, so
 * one card behind two customers is not visible on this side. The customer
 * test is as far as the payment rail reaches.
 *
 * Direct links only: A related to B and B to C does not relate A to C.
 */
import { sql, type SQL } from 'drizzle-orm';
import { schema } from '@/lib/infrastructure/postgres/client';

/**
 * A boolean SQL predicate over two workspace ids -- bound parameters or
 * qualified columns (`ref()`), so the same rule serves the call-time gate in
 * `commitCall` and the close-time sweep in close-period.ts.
 */
export function workspacesRelated(a: SQL, b: SQL): SQL {
  return sql`(
    exists(
      select 1 from ${schema.subscription} sa
      inner join ${schema.subscription} sb on sb.provider_customer_id = sa.provider_customer_id
      where sa.workspace_id = ${a}
        and sb.workspace_id = ${b}
        and sa.provider_customer_id is not null
    )
    or exists(
      select 1 from ${schema.workspaceMember} ma
      inner join ${schema.workspaceMember} mb on mb.user_id = ma.user_id
      where ma.workspace_id = ${a}
        and mb.workspace_id = ${b}
        and ma.role in ('owner', 'admin')
        and mb.role in ('owner', 'admin')
    )
  )`;
}
