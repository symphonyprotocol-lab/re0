/**
 * RE0's example posts ("示例问题", v5 P12): public Rees' own example
 * questions posted under RE0's name, so a new feed has answered questions
 * to read. Run only by an administrator, by hand
 * (`scripts/seed-posts.mts`): nothing in the app calls it, and each post
 * costs the platform up to five answers. A plan first, then posting;
 * a question already posted as an example is never posted again.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ReeCategory } from '@/lib/constants';
import { POST_QUESTION_MAX } from '@/lib/domain/post';
import { db, schema } from '@/lib/infra/db';
import { publicRee } from '@/lib/services/explore';
import { processPost, takesPosts, type ProcessDeps } from '@/lib/services/posts';

export interface SeedCandidate {
  reeId: string;
  reeName: string;
  category: string;
  question: string;
  lang: 'zh' | 'en';
}

const CJK = /[㐀-鿿]/;

/** Up to `perCategory` example questions in each category (or the one asked for), from public Rees that take posts, most active first. */
export async function planSeedPosts(options: { perCategory: number; category?: ReeCategory | null }): Promise<SeedCandidate[]> {
  const rees = await db()
    .select({ id: schema.ree.id, name: schema.ree.name, category: schema.ree.category, questions: schema.ree.sampleQuestions })
    .from(schema.ree)
    .where(and(publicRee(), takesPosts(), options.category ? eq(schema.ree.category, options.category) : undefined))
    .orderBy(desc(sql`coalesce((${schema.ree.rank} ->> 'score')::float, 0)`), desc(schema.ree.updatedAt));
  const posted = new Set(
    (await db().select({ question: schema.post.question }).from(schema.post).where(eq(schema.post.source, 'seed'))).map((row) => row.question),
  );
  const taken = new Map<string, number>();
  const out: SeedCandidate[] = [];
  for (const ree of rees) {
    for (const raw of ree.questions) {
      const question = raw.trim();
      if (!question || question.length > POST_QUESTION_MAX || posted.has(question)) continue;
      if ((taken.get(ree.category) ?? 0) >= options.perCategory) break;
      posted.add(question);
      taken.set(ree.category, (taken.get(ree.category) ?? 0) + 1);
      out.push({ reeId: ree.id, reeName: ree.name, category: ree.category, question, lang: CJK.test(question) ? 'zh' : 'en' });
    }
  }
  return out;
}

/** Posts the plan as RE0's examples, published at once (the questions are the Rees' own), each answered before the next. */
export async function applySeedPosts(plan: readonly SeedCandidate[], deps: ProcessDeps = {}): Promise<{ posted: number; answered: number }> {
  let posted = 0;
  for (const entry of plan) {
    const now = new Date();
    const [row] = await db()
      .insert(schema.post)
      .values({ source: 'seed', question: entry.question, lang: entry.lang, mentionReeId: entry.reeId, status: 'published', publishedAt: now, createdAt: now })
      .returning({ id: schema.post.id });
    posted += 1;
    await processPost(row!.id, deps);
  }
  const ids = posted
    ? (await db().select({ id: schema.post.id }).from(schema.post).where(and(eq(schema.post.source, 'seed'), inArray(schema.post.question, plan.map((entry) => entry.question))))).map((row) => row.id)
    : [];
  const [counted] = ids.length
    ? await db().select({ n: sql<number>`count(*) filter (where ${schema.post.answerCount} > 0)::int` }).from(schema.post).where(inArray(schema.post.id, ids))
    : [{ n: 0 }];
  return { posted, answered: counted?.n ?? 0 };
}
