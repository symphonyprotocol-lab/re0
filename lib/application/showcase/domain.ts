/**
 * A showcase page on the owner's own subdomain (lib/domain/showcase.ts
 * `parseCustomHost`): proving the host is theirs, adding it to the
 * deployment's Vercel project, and reading whether it has gone live.
 *
 * Two things are kept apart. Ownership is proved through the TXT challenge
 * a website library's source goes through (lib/application/libraries/
 * domain-verification.ts), so nobody can point someone else's host at
 * their page. Reachability is Vercel's: the host is added to the project
 * only once owned, and the page is served on it only once Vercel reports
 * its DNS configured and its certificate issued. What each check decides
 * is the domain's (`afterOwnershipCheck`, `afterVercelAdd`,
 * `afterDnsCheck`); this layer only runs the calls and writes the row.
 *
 * A check is the owner's move, never a page render's: every ownership
 * check spends one of the challenge's ten attempts, so nothing here runs
 * on a GET. The console's take-down and the library's deletion remove the
 * host; a plan that stops allowing one makes the host answer 404 at once
 * and leaves the row for the owner to remove.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { canManageLibraries, type WorkspaceRole } from '@/lib/application/libraries/delete';
import { checkDomainVerification, startDomainVerification } from '@/lib/application/libraries/domain-verification';
import { uuidv7 } from '@/lib/domain/id';
import {
  afterDnsCheck,
  afterOwnershipCheck,
  afterVercelAdd,
  parseCustomHost,
  showcaseVisible,
  VERCEL_CNAME_TARGET,
  type DomainCheckStep,
  type ShowcaseDomainStatus,
} from '@/lib/domain/showcase';
import { DNS_CHALLENGE_LABEL } from '@/lib/domain/domain-verification';
import { configuredBaseUrl } from '@/lib/http/base-url';
import { PUBLIC_ORIGIN } from '@/lib/site/origin';
import {
  addProjectDomain,
  isVercelDomainsConfigured,
  projectDomainConfig,
  removeProjectDomain,
  verifyProjectDomain,
} from '@/lib/infrastructure/vercel/domains';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { showcaseEntitlement, type WorkspaceShowcaseEntitlement } from './entitlement';
import { liveHostOf } from './live-host';

export type ShowcaseDomainRefusal = 'host' | 'plan' | 'not_configured' | 'taken' | 'status' | 'limit';

export class ShowcaseDomainInvalid extends AppError {
  constructor(readonly field: ShowcaseDomainRefusal) {
    super('invalid_request', `showcase domain: ${field}`);
  }
}

export interface ShowcaseDomainView {
  host: string;
  status: ShowcaseDomainStatus;
  /** The ownership record: name and value of the TXT the owner adds first. */
  ownershipTxt: { name: string; value: string } | null;
  /** The record Vercel asked for, when the host was used on another account. */
  vercelTxt: { name: string; value: string } | null;
  cnameTarget: string;
  lastCheckedAt: string | null;
  /** A `DomainCheckError` code, or `provider:` followed by Vercel's message. */
  error: string | null;
  createdAt: string;
}

/** Hosts of ours a page may never claim. */
export function ownHosts(): string[] {
  const hosts = new Set<string>();
  for (const origin of [configuredBaseUrl(), PUBLIC_ORIGIN]) {
    if (!origin) continue;
    try {
      hosts.add(new URL(origin).hostname);
    } catch {
      /* not a URL */
    }
  }
  hosts.add('vercel.app');
  hosts.add('localhost');
  return [...hosts];
}

type Row = typeof schema.showcaseDomain.$inferSelect;

function view(row: Row): ShowcaseDomainView {
  return {
    host: row.host,
    status: row.status,
    ownershipTxt:
      row.status === 'pending_ownership' && row.verificationToken
        ? { name: `${DNS_CHALLENGE_LABEL}.${row.host}`, value: `re0-verify=${row.verificationToken}` }
        : null,
    vercelTxt: row.vercelTxtName && row.vercelTxtValue ? { name: row.vercelTxtName, value: row.vercelTxtValue } : null,
    cnameTarget: VERCEL_CNAME_TARGET,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

async function pageOf(workspaceId: string, libraryId: string): Promise<{ id: string; slug: string; status: string } | null> {
  const [row] = await db()
    .select({ id: schema.libraryShowcase.id, slug: schema.libraryShowcase.slug, status: schema.libraryShowcase.status })
    .from(schema.libraryShowcase)
    .where(
      and(
        eq(schema.libraryShowcase.workspaceId, workspaceId),
        eq(schema.libraryShowcase.libraryId, libraryId),
        isNull(schema.libraryShowcase.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function rowOf(showcaseId: string): Promise<Row | null> {
  const [row] = await db().select().from(schema.showcaseDomain).where(eq(schema.showcaseDomain.showcaseId, showcaseId)).limit(1);
  return row ?? null;
}

/** Whether the feature can be offered at all on this deployment. */
export function customDomainsAvailable(): boolean {
  return isVercelDomainsConfigured();
}

/** The page's domain, for its owner; a plain read. The caller passes the entitlement it already holds. */
export async function showcaseDomainFor(
  input: { workspaceId: string; libraryId: string },
  _entitlement?: WorkspaceShowcaseEntitlement,
): Promise<ShowcaseDomainView | null> {
  const page = await pageOf(input.workspaceId, input.libraryId);
  if (!page) return null;
  const row = await rowOf(page.id);
  return row ? view(row) : null;
}

export interface StartShowcaseDomainInput {
  workspaceId: string;
  role: WorkspaceRole;
  libraryId: string;
  host: unknown;
}

/**
 * Claim a host for the page. The row is written first, which is what holds
 * the host against a second claimant (the unique index refuses the loser
 * before any challenge is started for it); the ownership challenge follows,
 * and nothing reaches Vercel yet.
 */
export async function startShowcaseDomain(input: StartShowcaseDomainInput): Promise<ShowcaseDomainView> {
  if (!canManageLibraries(input.role)) throw new AppError('access_denied', 'only a library manager can set a domain');
  if (!customDomainsAvailable()) throw new ShowcaseDomainInvalid('not_configured');
  const entitlement = await showcaseEntitlement(input.workspaceId, { fresh: true });
  if (!entitlement.customDomain) throw new ShowcaseDomainInvalid('plan');
  const page = await pageOf(input.workspaceId, input.libraryId);
  if (!page) throw new AppError('library_not_found', 'this library has no showcase page');
  if (page.status === 'taken_down') throw new ShowcaseDomainInvalid('status');
  const host = parseCustomHost(input.host, ownHosts());
  if (!host) throw new ShowcaseDomainInvalid('host');
  if (await rowOf(page.id)) throw new ShowcaseDomainInvalid('limit');

  const id = uuidv7();
  const now = new Date();
  try {
    await db().insert(schema.showcaseDomain).values({
      id,
      showcaseId: page.id,
      workspaceId: input.workspaceId,
      host,
      status: 'pending_ownership',
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('showcase_domain_host_uq')) throw new ShowcaseDomainInvalid('taken');
    if (message.includes('showcase_domain_showcase_uq')) throw new ShowcaseDomainInvalid('limit');
    throw error;
  }

  try {
    const challenge = await startDomainVerification({
      workspaceId: input.workspaceId,
      role: input.role,
      sourceType: 'website',
      location: `https://${host}/`,
      method: 'dns_txt',
    });
    await db()
      .update(schema.showcaseDomain)
      .set({ verificationId: challenge.verificationId, verificationToken: challenge.token, updatedAt: new Date() })
      .where(eq(schema.showcaseDomain.id, id));
  } catch (error) {
    /* No challenge, no claim: the host is released for the next try. */
    await db().delete(schema.showcaseDomain).where(eq(schema.showcaseDomain.id, id));
    throw error;
  }

  const row = await rowOf(page.id);
  if (!row) throw new AppError('internal_error', 'domain not written');
  return view(row);
}

/**
 * Move the host one step on, at the owner's request: the ownership record
 * found takes it to Vercel; Vercel's own record found and its DNS
 * configured takes it live. Says where it stands either way; a step that
 * cannot be taken yet is not an error, only a reason.
 */
export async function checkShowcaseDomain(input: { workspaceId: string; role: WorkspaceRole; libraryId: string }): Promise<ShowcaseDomainView | null> {
  if (!canManageLibraries(input.role)) throw new AppError('access_denied', 'only a library manager can check a domain');
  const page = await pageOf(input.workspaceId, input.libraryId);
  if (!page) return null;
  const row = await rowOf(page.id);
  if (!row) return null;

  let step: DomainCheckStep = { error: null };
  try {
    if (row.status === 'pending_ownership') {
      if (!row.verificationId || !row.verificationToken) {
        step = { status: 'failed', error: 'ownership_challenge_missing' };
      } else {
        const result = await checkDomainVerification({
          workspaceId: input.workspaceId,
          role: input.role,
          verificationId: row.verificationId,
          token: row.verificationToken,
        });
        step = afterOwnershipCheck(result.ok ? 'ok' : result.reason) ?? afterVercelAdd(await addProjectDomain(row.host));
      }
    } else if (row.status === 'pending_dns') {
      const asked = row.vercelTxtName ? await verifyProjectDomain(row.host) : null;
      if (asked && !asked.verified) {
        step = afterVercelAdd(asked);
      } else {
        step = { ...afterDnsCheck(await projectDomainConfig(row.host)), ...(asked?.verified ? { vercelTxt: null } : {}) };
      }
    } else if (row.status === 'ready') {
      step = afterDnsCheck(await projectDomainConfig(row.host));
    }
  } catch (error) {
    step = { error: null };
    await db()
      .update(schema.showcaseDomain)
      .set({ lastCheckedAt: new Date(), updatedAt: new Date(), error: `provider:${error instanceof AppError ? error.message : 'check failed'}` })
      .where(eq(schema.showcaseDomain.id, row.id));
    const after = await rowOf(page.id);
    return after ? view(after) : null;
  }

  const now = new Date();
  await db()
    .update(schema.showcaseDomain)
    .set({
      lastCheckedAt: now,
      updatedAt: now,
      error: step.error,
      ...(step.status ? { status: step.status } : {}),
      ...(step.vercelTxt !== undefined
        ? { vercelTxtName: step.vercelTxt?.name ?? null, vercelTxtValue: step.vercelTxt?.value ?? null }
        : {}),
    })
    .where(eq(schema.showcaseDomain.id, row.id));
  const updated = await rowOf(page.id);
  return updated ? view(updated) : null;
}

async function dropDomain(row: Row): Promise<void> {
  if (row.status !== 'pending_ownership') {
    await removeProjectDomain(row.host).catch((error: unknown) => {
      console.warn(`showcase domain not removed from Vercel: ${error instanceof Error ? error.message : 'unknown'}`);
    });
  }
  await db().delete(schema.showcaseDomain).where(eq(schema.showcaseDomain.id, row.id));
}

export async function removeShowcaseDomain(input: { workspaceId: string; role: WorkspaceRole; libraryId: string }): Promise<void> {
  if (!canManageLibraries(input.role)) throw new AppError('access_denied', 'only a library manager can remove a domain');
  const page = await pageOf(input.workspaceId, input.libraryId);
  if (!page) throw new AppError('library_not_found', 'this library has no showcase page');
  const row = await rowOf(page.id);
  if (!row) return;
  await dropDomain(row);
}

/** The console's and the delete path's removal: by page, no role check (the caller has its own). */
export async function dropShowcaseDomainOf(showcaseId: string): Promise<void> {
  const row = await rowOf(showcaseId);
  if (row) await dropDomain(row);
}

/**
 * The page a custom host serves: live on Vercel, published, on a library
 * that is alive and a plan that still allows a domain. Null is a 404.
 */
export async function showcaseByHost(host: string): Promise<{ slug: string } | null> {
  const lowered = host.toLowerCase().replace(/:\d+$/, '');
  const [row] = await db()
    .select({
      slug: schema.libraryShowcase.slug,
      status: schema.libraryShowcase.status,
      workspaceId: schema.libraryShowcase.workspaceId,
      libraryDeletedAt: schema.library.deletedAt,
    })
    .from(schema.showcaseDomain)
    .innerJoin(schema.libraryShowcase, eq(schema.libraryShowcase.id, schema.showcaseDomain.showcaseId))
    .innerJoin(schema.library, eq(schema.library.id, schema.libraryShowcase.libraryId))
    .where(and(eq(schema.showcaseDomain.host, lowered), eq(schema.showcaseDomain.status, 'ready'), isNull(schema.libraryShowcase.deletedAt)))
    .limit(1);
  if (!row || row.libraryDeletedAt || !showcaseVisible(row.status)) return null;
  if (!(await showcaseEntitlement(row.workspaceId)).customDomain) return null;
  return { slug: row.slug };
}

/**
 * The live custom host of a page, for the redirect from `/s/{slug}` and
 * the canonical link: the same answer `showcaseByHost` gives, from the
 * other side, so the two never send a visitor to a host that 404s.
 */
export async function customHostOf(showcaseId: string): Promise<string | null> {
  const live = await liveHostOf(showcaseId);
  if (!live) return null;
  return (await showcaseEntitlement(live.workspaceId)).customDomain ? live.host : null;
}
