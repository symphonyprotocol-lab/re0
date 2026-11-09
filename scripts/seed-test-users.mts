/** Add an identifiable, atomic test batch. Dry-run unless --apply is supplied. */
import nextEnv from '@next/env';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { REE_COLORS, type ReeCategory } from '../lib/constants';
import { reeValues, validateReeFields } from '../lib/domain/ree';

nextEnv.loadEnvConfig(process.cwd());
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--apply' && !arg.startsWith('--batch=') && !arg.startsWith('--expect-host='))) {
  throw new Error('Usage: tsx scripts/seed-test-users.mts [--batch=demo-100] [--apply --expect-host=HOST]');
}
const batch = args.find((arg) => arg.startsWith('--batch='))?.slice('--batch='.length) ?? 'demo-100';
if (!/^[a-z0-9-]{1,30}$/.test(batch)) throw new Error('Batch must contain 1–30 lowercase letters, digits or hyphens');
const host = new URL(process.env.DATABASE_URL!).hostname;
const apply = args.includes('--apply');
if (apply && !args.includes(`--expect-host=${host}`)) throw new Error(`To write this database, supply --expect-host=${host}`);

const { db, schema } = await import('../lib/infra/db');
const { welcomeCredits } = await import('../lib/services/signup-reward');
const database = db();
const themes: { category: ReeCategory; title: string; topic: string; tags: string[] }[] = [
  { category: 'technology', title: '前端开发助手', topic: 'React、Next.js 与前端工程', tags: ['React', 'Next.js'] },
  { category: 'technology', title: 'Python 自动化', topic: 'Python 脚本与自动化工作流', tags: ['Python', '自动化'] },
  { category: 'technology', title: 'AI 应用笔记', topic: 'AI 应用架构与知识检索', tags: ['AI 应用', '技术开发'] },
  { category: 'design', title: '产品设计顾问', topic: '产品设计与用户体验', tags: ['产品设计', '用户体验'] },
  { category: 'design', title: '设计系统手册', topic: '组件规范与设计系统', tags: ['设计系统', '视觉设计'] },
  { category: 'business', title: '增长实验室', topic: '商业增长与市场营销', tags: ['商业增长', '市场营销'] },
  { category: 'business', title: '独立开发日志', topic: '独立开发与产品管理', tags: ['独立开发', '产品管理'] },
  { category: 'learning', title: '学习方法教练', topic: '学习方法与知识管理', tags: ['学习方法', '知识管理'] },
  { category: 'learning', title: '阅读写作伙伴', topic: '读书笔记与写作练习', tags: ['阅读写作', '读书笔记'] },
  { category: 'professional', title: '供应链资料库', topic: '供应链与行业研究', tags: ['供应链', '行业研究'] },
  { category: 'professional', title: '工程知识手册', topic: '工程制造与项目文档', tags: ['工程制造', '行业研究'] },
  { category: 'life', title: '旅行文化指南', topic: '旅行规划与文化体验', tags: ['旅行文化', '生活方式'] },
  { category: 'life', title: '厨房灵感集', topic: '家常烹饪与厨房效率', tags: ['烹饪', '效率工具'] },
  { category: 'other', title: '灵感收集箱', topic: '跨领域灵感与个人笔记', tags: ['灵感', '个人笔记'] },
];
const users = Array.from({ length: 100 }, (_, i) => {
  const number = String(i + 1).padStart(3, '0');
  return {
    id: randomUUID(),
    name: `测试用户 ${number}`,
    email: `${batch}-${number}@example.invalid`,
    provider: 'github' as const,
    // This namespace cannot collide with GitHub's numeric OAuth subjects.
    providerSubject: `re0-test:${batch}:${number}`,
    lang: 'zh' as const,
  };
});
const rees = users.flatMap((user, i) => Array.from({ length: 2 + i % 2 }, (_, j) => {
  const theme = themes[(i * 3 + j) % themes.length]!;
  const number = String(i + 1).padStart(3, '0');
  const fields = {
    name: `${theme.title} ${number}-${j + 1}`,
    description: `【测试数据 ${batch}】围绕${theme.topic}的示例 Ree，用于测试列表、搜索、分类与可见性。`,
    category: theme.category,
    tags: [...theme.tags, '测试数据'],
    systemPrompt: `你是${theme.title}。仅根据已添加的知识回答关于${theme.topic}的问题；没有知识依据时明确说明。`,
    sampleQuestions: [`${theme.topic}有哪些入门要点？`, `如何制定关于${theme.topic}的实践计划？`, '请总结当前知识库的主要内容。'],
    isPublic: j === 0 || i % 2 === 1,
    color: REE_COLORS[(i + j) % REE_COLORS.length]!,
    queryFee: 0,
  };
  const invalid = validateReeFields(fields, 4);
  if (invalid) throw new Error(`Invalid test Ree ${number}-${j + 1}: ${invalid.error}`);
  return { id: randomUUID(), ownerId: user.id, slug: `test-${batch}-${number}-${j + 1}`, ...reeValues(fields) };
}));
const subjects = users.map((user) => user.providerSubject);

try {
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', host, batch, users: users.length, rees: rees.length,
    public: rees.filter((ree) => ree.isPublic).length, private: rees.filter((ree) => !ree.isPublic).length }));
  if (apply) {
    const result = await database.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`seed-test-users:${batch}`}))`);
      const existing = await tx.select({ id: schema.user.id }).from(schema.user)
        .where(and(eq(schema.user.provider, 'github'), inArray(schema.user.providerSubject, subjects)));
      if (existing.length) {
        if (existing.length !== users.length) throw new Error('Partial batch exists; refusing to modify existing test data');
        return { created: false, message: 'Batch already exists; no changes made' };
      }
      // Name the required columns explicitly so pending optional profile migrations
      // in another working change do not prevent seeding the current database.
      await tx.execute(sql`insert into ${schema.user} (id, email, name, provider, provider_subject, lang)
        values ${sql.join(users.map((user) => sql`(${user.id}, ${user.email}, ${user.name}, ${user.provider}, ${user.providerSubject}, ${user.lang})`), sql`, `)}`);
      await tx.insert(schema.ree).values(rees);
      const { credits } = await welcomeCredits(tx);
      if (credits > 0) {
        const grants = users.map((user) => ({ id: randomUUID(), userId: user.id, source: 'welcome' as const, amount: credits, remaining: credits }));
        await tx.insert(schema.creditGrant).values(grants);
        await tx.insert(schema.creditEntry).values(grants.map((grant) => ({
          userId: grant.userId, delta: credits, reason: 'welcome' as const, refId: grant.id,
          note: `Test batch: ${batch}`,
          allocations: [{ grantId: grant.id, source: 'welcome' as const, amount: credits }],
        })));
      }
      const counts = await tx.select({ count: sql<number>`count(*)::int` }).from(schema.ree)
        .where(inArray(schema.ree.ownerId, users.map((user) => user.id))).groupBy(schema.ree.ownerId);
      if (counts.length !== 100 || counts.filter((row) => row.count === 2).length !== 50 || counts.filter((row) => row.count === 3).length !== 50) {
        throw new Error('Unexpected ownership distribution; rolling back the batch');
      }
      return { created: true, welcomeCreditsPerUser: credits };
    });
    console.log(JSON.stringify(result));
  }
  const verification = await database.execute(sql`
    select count(*)::int as users, coalesce(sum(n), 0)::int as rees,
      min(n)::int as min_per_user, max(n)::int as max_per_user
    from (
      select u.id, count(r.id) as n
      from ${schema.user} u left join ${schema.ree} r on r.owner_id = u.id
      where u.provider = 'github' and u.provider_subject in (${sql.join(subjects.map((subject) => sql`${subject}`), sql`, `)})
      group by u.id
    ) batch
  `);
  console.log(JSON.stringify({ verification: verification.rows[0] }));
} finally {
  await database.$client.end();
}
