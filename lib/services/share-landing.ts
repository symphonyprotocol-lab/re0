/**
 * What the share page `/s/[slug]` says about a public Ree's knowledge beyond
 * the count every public page shows (public-rees.ts `readySources`): how
 * its ready sources split by kind -- kinds and counts, never a title -- and
 * the sources its shown answers on visible posts cited. Those titles are
 * already public: each such answer shows them under its citations. A
 * source that is no longer ready, enabled and live is left out, so the page
 * never advertises one its owner took away.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { KNOWLEDGE_KIND_LIST, type KnowledgeKind } from '@/lib/domain/knowledge';
import { isUuid } from '@/lib/domain/list';
import { db, schema } from '@/lib/infra/db';
import { firstRound, shownAnswer, visiblePost } from '@/lib/services/posts';

/** How many cited sources the share page lists. */
export const SHARE_CITED_SOURCES = 6;

export interface SourceMix {
  kind: KnowledgeKind;
  count: number;
}

export interface CitedSource {
  knowledgeId: string;
  title: string;
  kind: KnowledgeKind;
  /** Shown answers on visible posts that cite it. */
  answers: number;
}

/** Ready, enabled, live sources by kind, most first. */
export async function reeSourceMix(reeId: string): Promise<SourceMix[]> {
  if (!isUuid(reeId)) return [];
  const k = schema.knowledge;
  const rows = await db()
    .select({ kind: k.kind, count: sql<number>`count(*)::int` })
    .from(k)
    .where(and(eq(k.reeId, reeId), eq(k.status, 'ready'), eq(k.enabled, true), isNull(k.deletedAt)))
    .groupBy(k.kind);
  return rows
    .filter((row): row is SourceMix => (KNOWLEDGE_KIND_LIST as readonly string[]).includes(row.kind) && row.count > 0)
    .sort((a, b) => b.count - a.count || KNOWLEDGE_KIND_LIST.indexOf(a.kind) - KNOWLEDGE_KIND_LIST.indexOf(b.kind));
}

/** The sources this Ree's public answers cite most, as those answers name them. */
export async function reeCitedSources(reeId: string, limit = SHARE_CITED_SOURCES): Promise<CitedSource[]> {
  if (!isUuid(reeId)) return [];
  const { postAnswer: answer, post, ree, knowledge } = schema;
  const result = await db().execute<{ knowledge_id: string; title: string; kind: string; answers: number }>(sql`
    select c.value->>'knowledgeId' as knowledge_id,
      (array_agg(c.value->>'title' order by ${answer.answeredAt} desc nulls last))[1] as title,
      max(${knowledge.kind}) as kind,
      count(distinct ${answer.id})::int as answers
    from ${answer}
    join ${post} on ${post.id} = ${answer.postId}
    join ${ree} on ${ree.id} = ${answer.reeId}
    cross join lateral jsonb_array_elements(${answer.citations}) as c(value)
    join ${knowledge} on ${knowledge.id}::text = c.value->>'knowledgeId'
    where ${answer.reeId} = ${reeId}::uuid
      and ${and(firstRound(), shownAnswer(), visiblePost())}
      and ${knowledge.reeId} = ${answer.reeId}
      and ${knowledge.status} = 'ready' and ${knowledge.enabled} and ${knowledge.deletedAt} is null
    group by 1
    order by answers desc, max(${answer.answeredAt}) desc nulls last
    limit ${limit}`);
  return result.rows.flatMap((row) => {
    const title = (row.title ?? '').trim();
    if (!title || !(KNOWLEDGE_KIND_LIST as readonly string[]).includes(row.kind)) return [];
    return [{ knowledgeId: row.knowledge_id, title, kind: row.kind as KnowledgeKind, answers: Number(row.answers) }];
  });
}
