/**
 * The workspace's showcase pages in one place, for the dashboard's
 * "shared pages" screen: every asset of the workspace that has a page,
 * where the page stands, and the last thirty days of what visitors did
 * there. An asset without a page is left out -- the list is of pages, and
 * making one starts on the asset's own page; this is the view across all
 * of them.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { isShowcaseExpired, type ShowcaseAccess, type ShowcaseKind, type ShowcaseStatus } from '@/lib/domain/showcase';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { liveHostSql } from './live-host';
import { readShowcaseRow } from './row';

export interface WorkspaceShowcaseRow {
  assetId: string;
  assetTitle: string;
  assetPublicId: string;
  page: {
    id: string;
    name: string;
    slug: string;
    kind: ShowcaseKind;
    status: ShowcaseStatus;
    access: ShowcaseAccess;
    hasPassword: boolean;
    expired: boolean;
    customHost: string | null;
    publishedAt: string | null;
  };
  /** The last thirty days. */
  views: number;
  questions: number;
  leads: number;
  unhandledLeads: number;
}

export interface WorkspaceShowcases {
  rows: WorkspaceShowcaseRow[];
  days: number;
  published: number;
  views: number;
  questions: number;
  unhandledLeads: number;
}

export async function listWorkspaceShowcases(workspaceId: string, days = 30): Promise<WorkspaceShowcases> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const daily = schema.assetShowcaseDaily;
  const sum = (column: AnyPgColumn) =>
    sql<number>`coalesce((select sum(${column}) from ${daily} where ${daily.showcaseId} = ${schema.assetShowcase.id} and ${daily.day} >= ${since}), 0)::int`;
  const rows = await db()
    .select({
      assetId: schema.asset.id,
      assetTitle: schema.asset.title,
      assetPublicId: schema.asset.publicId,
      showcase: schema.assetShowcase,
      customHost: liveHostSql,
      views: sum(daily.views),
      questions: sum(daily.questions),
      leads: sum(daily.leads),
      unhandledLeads: sql<number>`coalesce((select count(*) from ${schema.showcaseLead} where ${schema.showcaseLead.showcaseId} = ${schema.assetShowcase.id} and ${schema.showcaseLead.status} = 'new'), 0)::int`,
    })
    .from(schema.asset)
    .innerJoin(
      schema.assetShowcase,
      and(eq(schema.assetShowcase.assetId, schema.asset.id), isNull(schema.assetShowcase.deletedAt)),
    )
    .where(
      and(
        eq(schema.asset.ownerWorkspaceId, workspaceId),
        eq(schema.asset.isPlatformAsset, false),
        isNull(schema.asset.deletedAt),
      ),
    )
    .orderBy(desc(schema.assetShowcase.publishedAt), desc(schema.asset.createdAt));

  const view: WorkspaceShowcaseRow[] = rows.map((row) => ({
    assetId: row.assetId,
    assetTitle: row.assetTitle,
    assetPublicId: row.assetPublicId,
    page: {
      id: row.showcase.id,
      name: readShowcaseRow(row.showcase).document.content.name || row.assetTitle,
      slug: row.showcase.slug,
      kind: row.showcase.kind,
      status: row.showcase.status,
      access: row.showcase.access,
      hasPassword: row.showcase.passwordHash !== null,
      expired: isShowcaseExpired(row.showcase.expiresAt),
      customHost: row.customHost ?? null,
      publishedAt: row.showcase.publishedAt?.toISOString() ?? null,
    },
    views: row.views,
    questions: row.questions,
    leads: row.leads,
    unhandledLeads: row.unhandledLeads,
  }));

  return {
    rows: view,
    days,
    published: view.filter((row) => row.page.status === 'published').length,
    views: view.reduce((total, row) => total + row.views, 0),
    questions: view.reduce((total, row) => total + row.questions, 0),
    unhandledLeads: view.reduce((total, row) => total + row.unhandledLeads, 0),
  };
}
