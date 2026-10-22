/**
 * The console's view of showcase pages (lib/domain/showcase.ts): every
 * page across workspaces, and the two moves an operator has over one --
 * taking it down and reinstating it. A page taken down comes back disabled,
 * so its owner publishes it again knowingly. Both moves take a reason and
 * write the audit row, as every console mutation does.
 */
import { and, count, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { recordAudit } from '@/lib/application/administration/audit';
import { normalizeReason } from '@/lib/domain/admin';
import {
  readShowcaseDocument,
  showcaseTransition,
  type ShowcaseAccess,
  type ShowcaseKind,
  type ShowcaseStatus,
} from '@/lib/domain/showcase';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { dropShowcaseDomainOf } from './domain';
import { liveHostSql } from './live-host';

export const SHOWCASE_CONSOLE_FILTERS = ['published', 'taken_down', 'all'] as const;
export type ShowcaseConsoleFilter = (typeof SHOWCASE_CONSOLE_FILTERS)[number];

export interface ConsoleShowcaseRow {
  id: string;
  slug: string;
  kind: ShowcaseKind;
  status: ShowcaseStatus;
  access: ShowcaseAccess;
  name: string;
  libraryTitle: string;
  libraryPublicId: string;
  workspaceName: string;
  publishedAt: Date | null;
  createdAt: Date;
  /** Leads the page has collected; the console sees the count, never the contents. */
  leads: number;
  /** The live custom host, when one is ready. */
  host: string | null;
}

export async function listConsoleShowcases(input: {
  query?: string;
  status: ShowcaseConsoleFilter;
  limit: number;
  offset: number;
}): Promise<{ rows: ConsoleShowcaseRow[]; total: number; counts: Record<ShowcaseConsoleFilter, number> }> {
  const database = db();
  const term = input.query?.trim();
  /* `%` and `_` are LIKE wildcards; a typed one must match itself. */
  const pattern = term ? `%${term.replace(/[\\%_]/g, (match) => `\\${match}`)}%` : null;
  const search = pattern
    ? or(
        ilike(schema.libraryShowcase.slug, pattern),
        ilike(schema.library.title, pattern),
        ilike(schema.library.publicId, pattern),
        ilike(schema.workspace.name, pattern),
      )
    : undefined;
  const scope = and(
    isNull(schema.libraryShowcase.deletedAt),
    input.status === 'all' ? undefined : eq(schema.libraryShowcase.status, input.status),
    search,
  );
  const base = () =>
    database
      .select({
        showcase: schema.libraryShowcase,
        libraryTitle: schema.library.title,
        libraryPublicId: schema.library.publicId,
        workspaceName: schema.workspace.name,
        leads: sql<number>`(select count(*) from ${schema.showcaseLead} where ${schema.showcaseLead.showcaseId} = ${schema.libraryShowcase.id})::int`,
        host: liveHostSql,
      })
      .from(schema.libraryShowcase)
      .innerJoin(schema.library, eq(schema.library.id, schema.libraryShowcase.libraryId))
      .innerJoin(schema.workspace, eq(schema.workspace.id, schema.libraryShowcase.workspaceId));

  const [rows, [total], [tally]] = await Promise.all([
    base().where(scope).orderBy(desc(schema.libraryShowcase.createdAt)).limit(input.limit).offset(input.offset),
    database
      .select({ n: count() })
      .from(schema.libraryShowcase)
      .innerJoin(schema.library, eq(schema.library.id, schema.libraryShowcase.libraryId))
      .innerJoin(schema.workspace, eq(schema.workspace.id, schema.libraryShowcase.workspaceId))
      .where(scope),
    database
      .select({
        all: sql<number>`count(*)::int`,
        published: sql<number>`(count(*) filter (where ${schema.libraryShowcase.status} = 'published'))::int`,
        takenDown: sql<number>`(count(*) filter (where ${schema.libraryShowcase.status} = 'taken_down'))::int`,
      })
      .from(schema.libraryShowcase)
      .where(isNull(schema.libraryShowcase.deletedAt)),
  ]);

  return {
    rows: rows.map((row) => ({
      id: row.showcase.id,
      slug: row.showcase.slug,
      kind: row.showcase.kind,
      status: row.showcase.status,
      access: row.showcase.access,
      name: readShowcaseDocument(row.showcase.content).content.name,
      libraryTitle: row.libraryTitle,
      libraryPublicId: row.libraryPublicId,
      workspaceName: row.workspaceName,
      publishedAt: row.showcase.publishedAt,
      createdAt: row.showcase.createdAt,
      leads: row.leads,
      host: row.host ?? null,
    })),
    total: total?.n ?? 0,
    counts: { all: tally?.all ?? 0, published: tally?.published ?? 0, taken_down: tally?.takenDown ?? 0 },
  };
}

export interface ShowcaseConsoleActor {
  administratorId: string;
  email: string;
  clientAddress: string | null;
}

/** Take a page down (any state but taken down) or reinstate it (to disabled). */
export async function moderateShowcase(input: {
  actor: ShowcaseConsoleActor;
  showcaseId: string;
  verb: 'take_down' | 'reinstate';
  reason: string;
}): Promise<{ status: ShowcaseStatus }> {
  const reason = normalizeReason(input.reason);
  const [row] = await db()
    .select({ id: schema.libraryShowcase.id, status: schema.libraryShowcase.status, slug: schema.libraryShowcase.slug })
    .from(schema.libraryShowcase)
    .where(and(eq(schema.libraryShowcase.id, input.showcaseId), isNull(schema.libraryShowcase.deletedAt)))
    .limit(1);
  if (!row) throw new AppError('library_not_found', 'no such showcase page');
  const next = showcaseTransition(row.status, input.verb);
  if (!next) throw new AppError('invalid_request', `cannot ${input.verb} a page that is ${row.status}`);
  const now = new Date();
  await db()
    .update(schema.libraryShowcase)
    .set({ status: next, updatedAt: now, ...(next === 'disabled' ? { disabledAt: now } : {}) })
    .where(eq(schema.libraryShowcase.id, row.id));
  /* A page taken down loses its domain; the owner sets one again once reinstated and published. */
  if (next === 'taken_down') await dropShowcaseDomainOf(row.id).catch(() => {});
  await recordAudit({
    administratorId: input.actor.administratorId,
    action: `showcase.${input.verb}`,
    targetType: 'library_showcase',
    targetId: row.id,
    reason,
    beforeValue: { status: row.status, slug: row.slug },
    afterValue: { status: next, slug: row.slug },
    clientAddress: input.actor.clientAddress,
    result: 'success',
  });
  return { status: next };
}
