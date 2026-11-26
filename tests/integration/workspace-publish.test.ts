/**
 * Publishing a workspace file's original (docs/design/agent-workspace-p4.md
 * §2, lib/services/workspace-publish.ts): the checks before anything goes
 * out, the pinned version, the public page and the download's headers, what
 * makes a link unavailable or gone, the purge keeping the pinned version,
 * daily volumes, the per-address limit, egress billing, reports, takedowns
 * and freezing, and what agents see. Blob is the local store in a temporary
 * folder.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { TEST_DATABASE_URL, uniqueName } from './setup';

const blobDir = mkdtempSync(join(tmpdir(), 're0-ws-publish-'));
process.env.WORKSPACE_BLOB_DIR = blobDir;

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const workspace = await import('@/lib/services/workspace');
const uploads = await import('@/lib/services/workspace-upload');
const publish = await import('@/lib/services/workspace-publish');
const admin = await import('@/lib/services/admin');
const { db, schema } = await import('@/lib/infra/db');
const { forgetRateLimitSettings } = await import('@/lib/services/rate-limit-settings');
const rawRoute = await import('@/app/f/[id]/raw/route');
const { WORKSPACE_UPLOAD_PART } = await import('@/lib/constants');

afterAll(() => rmSync(blobDir, { recursive: true, force: true }));

type Scope = Awaited<ReturnType<typeof workspace.webScope>>;

/** An account old enough to publish (or `days` old). */
async function owner(days = 30): Promise<Scope> {
  const subject = uniqueName('pub');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: subject, avatarUrl: null }, 'en', '/');
  await db().update(schema.user).set({ createdAt: new Date(Date.now() - days * 86_400_000) }).where(eq(schema.user.id, userId));
  return workspace.webScope(userId);
}

async function upload(scope: Scope, path: string, bytes: Uint8Array) {
  const ticket = await uploads.createUpload(scope, { path, size: bytes.length });
  const token = ticket.url.split('/').pop()!;
  let result;
  for (let n = 1; n <= ticket.parts; n += 1) {
    const part = bytes.slice((n - 1) * WORKSPACE_UPLOAD_PART, n * WORKSPACE_UPLOAD_PART);
    result = await uploads.receivePart(token, { part: ticket.parts === 1 ? null : String(n), contentLength: String(part.length), body: new Response(Buffer.from(part)).body });
  }
  expect(result).toMatchObject({ done: true });
}

async function setCeiling(key: string, value: number | null) {
  if (value === null) await db().delete(schema.limitCeilingSetting).where(eq(schema.limitCeilingSetting.key, key));
  else await db().insert(schema.limitCeilingSetting).values({ key, value }).onConflictDoUpdate({ target: schema.limitCeilingSetting.key, set: { value } });
  forgetRateLimitSettings();
}

async function withCeiling<T>(key: string, value: number, work: () => Promise<T>): Promise<T> {
  await setCeiling(key, value);
  try {
    return await work();
  } finally {
    await setCeiling(key, null);
  }
}

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const failed = (checks: { key: string; ok: boolean; detail?: string }[]) => checks.filter((check) => !check.ok).map((check) => (check.detail ? `${check.key}:${check.detail}` : check.key));
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const download = (publicId: string, from = ip()) => publish.serveDownload(publicId, from);

async function refused(promise: Promise<unknown>): Promise<{ code: string; checks: string[] }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof publish.PublishError) return { code: error.code, checks: failed((error.details.checks as never) ?? []) };
    throw error;
  }
  throw new Error('expected a refusal');
}

async function administrator(): Promise<string> {
  const [row] = await db()
    .insert(schema.administrator)
    .values({ name: 'a', email: `${uniqueName('adm')}@x.test`, passwordHash: await admin.hashPassword('x'.repeat(12)), totpSecretCipher: 'x' })
    .returning();
  return row!.id;
}

describeWithDb('publishing: checks', () => {
  it('publishes a text file whose checks all pass, and serves its exact bytes as a sandboxed attachment', async () => {
    const scope = await owner();
    const text = '# Plan\r\n\tdetails — ünïcode\n';
    await workspace.writeFile(scope, { path: '/docs/plan.md', content: text });
    const check = await publish.publishCheck(scope, { path: '/docs/plan.md' });
    expect(check.ok).toBe(true);
    expect(check.checks.map((c) => c.key)).toEqual(expect.arrayContaining(['type', 'size', 'account', 'count', 'blocked', 'text', 'secrets']));
    const view = await publish.publishFile(scope, { path: '/docs/plan.md', title: '  The plan\n' });
    expect(view.public_id).toMatch(/^[0-9A-Za-z]{22}$/);
    expect(view.url.endsWith(`/f/${view.public_id}`)).toBe(true);
    expect(view.title).toBe('The plan');

    const response = await rawRoute.GET(new NextRequest(`http://localhost:3000/f/${view.public_id}/raw`, { headers: { 'x-real-ip': ip() } }), { params: Promise.resolve({ id: view.public_id }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="plan.md"; filename*=UTF-8''plan.md`);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(sha(new Uint8Array(await response.arrayBuffer()))).toBe(sha(text));

    const page = await publish.publicFile(view.public_id);
    expect(page).toMatchObject({ title: 'The plan', fileName: 'plan.md', availability: 'live', sha256: sha(text), preview: text, image: false, indexable: false });
    expect(await refused(publish.publishFile(scope, { path: '/docs/plan.md' }))).toMatchObject({ code: 'already_published' });
  });

  it('refuses types that can run or render, PDFs with active content (even compressed or escaped), macro Office files, false images and secrets', async () => {
    const scope = await owner();
    const encode = (text: string) => new TextEncoder().encode(text);
    for (const path of ['/x/page.html', '/x/pic.svg', '/x/run.js', '/x/tool.exe', '/x/pack.zip', '/x/code.py']) await upload(scope, path, encode('MZ<script>alert(1)</script>'));
    for (const path of ['/x/page.html', '/x/pic.svg', '/x/run.js', '/x/tool.exe', '/x/pack.zip', '/x/code.py']) {
      expect((await publish.publishCheck(scope, { path })).checks.find((c) => c.key === 'type')!.ok, path).toBe(false);
    }
    await upload(scope, '/x/renamed.pdf', encode('MZ\u0090\u0000 this is an executable'));
    expect(failed((await publish.publishCheck(scope, { path: '/x/renamed.pdf' })).checks)).toEqual(['active_content:not_a_pdf']);
    await upload(scope, '/x/js.pdf', encode('%PDF-1.4\n<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>\n%%EOF'));
    expect(failed((await publish.publishCheck(scope, { path: '/x/js.pdf' })).checks)).toEqual(['active_content:javascript']);
    await upload(scope, '/x/hidden.pdf', new Uint8Array(Buffer.concat([Buffer.from('%PDF-1.7\n1 0 obj << /Type /ObjStm /Filter /FlateDecode >>\nstream\n'), deflateSync('<< /S /Launch /F (calc.exe) >>'), Buffer.from('\nendstream\nendobj\n%%EOF\n')])));
    expect(failed((await publish.publishCheck(scope, { path: '/x/hidden.pdf' })).checks)).toEqual(['active_content:launch']);

    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('word/document.xml', '<w:document><w:t>hello</w:t></w:document>');
    zip.file('word/vbaProject.bin', 'macro');
    await upload(scope, '/x/macro.docx', await zip.generateAsync({ type: 'uint8array' }));
    expect(failed((await publish.publishCheck(scope, { path: '/x/macro.docx' })).checks)).toEqual(['active_content:macros']);

    await upload(scope, '/x/fake.png', encode('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    expect(failed((await publish.publishCheck(scope, { path: '/x/fake.png' })).checks)).toEqual(['image:image/png']);

    await workspace.writeFile(scope, { path: '/x/keys.txt', content: `deploy with AKIA${'A'.repeat(16)}\n` });
    expect(failed((await publish.publishCheck(scope, { path: '/x/keys.txt' })).checks)).toEqual(['secrets:aws_access_key']);
    expect(await refused(publish.publishFile(scope, { path: '/x/keys.txt' }))).toMatchObject({ code: 'checks_failed', checks: ['secrets:aws_access_key'] });

    /* A clean docx goes out, with its text as the preview. */
    const clean = new JSZip();
    clean.file('[Content_Types].xml', '<Types/>');
    clean.file('word/document.xml', '<w:document><w:p><w:t>Quarterly overview</w:t></w:p></w:document>');
    await upload(scope, '/x/ok.docx', await clean.generateAsync({ type: 'uint8array' }));
    const docx = await publish.publishFile(scope, { path: '/x/ok.docx' });
    expect((await publish.publicFile(docx.public_id))?.preview).toContain('Quarterly overview');
  });

  it('holds to the account rules: a week old, enabled, no storage debt, not frozen, under the file ceiling', async () => {
    const young = await owner(2);
    await workspace.writeFile(young, { path: '/a.txt', content: 'a' });
    expect(failed((await publish.publishCheck(young, { path: '/a.txt' })).checks)).toEqual(['account:too_new']);

    const owing = await owner();
    await workspace.writeFile(owing, { path: '/a.txt', content: 'a' });
    await db().insert(schema.creditDebt).values({ userId: owing.userId, amount: 10, remaining: 10 });
    expect(failed((await publish.publishCheck(owing, { path: '/a.txt' })).checks)).toEqual(['account:debt']);

    const many = await owner();
    await workspace.writeFile(many, { path: '/one.txt', content: '1' });
    await workspace.writeFile(many, { path: '/two.txt', content: '2' });
    await withCeiling('publishMaxFiles', 1, async () => {
      await publish.publishFile(many, { path: '/one.txt' });
      expect(failed((await publish.publishCheck(many, { path: '/two.txt' })).checks)).toEqual(['count:1']);
    });
  });

  it('keeps every published file within one function response until the Blob redirect is confirmed (R4)', async () => {
    const scope = await owner();
    await upload(scope, '/big.txt', new TextEncoder().encode('a'.repeat(4 * 1024 * 1024 + 1)));
    expect(failed((await publish.publishCheck(scope, { path: '/big.txt' })).checks)).toEqual([`size:${4 * 1024 * 1024}`]);
  });
});

describeWithDb('publishing: the pinned version', () => {
  it('serves the published version whatever is saved later, until the owner updates it; the URL stays', async () => {
    const scope = await owner();
    await workspace.writeFile(scope, { path: '/v.md', content: 'version one' });
    const view = await publish.publishFile(scope, { path: '/v.md' });
    await workspace.writeFile(scope, { path: '/v.md', content: 'version two, written by an agent' });
    expect(await (await download(view.public_id)).text()).toBe('version one');
    const stat = (await workspace.statEntry(scope, '/v.md')) as { published?: unknown };
    expect(stat.published).toMatchObject({ url: view.url, revision: view.revision, current: false });

    const updated = await publish.updatePublication(scope, view.id, { toCurrent: true });
    expect(updated.public_id).toBe(view.public_id);
    expect(await (await download(view.public_id)).text()).toBe('version two, written by an agent');
    expect(((await workspace.statEntry(scope, '/v.md')) as { published?: unknown }).published).toMatchObject({ current: true });
  });

  it('keeps the pinned version through the purge while the link is live, and lets it go once revoked', async () => {
    const scope = await owner();
    await workspace.writeFile(scope, { path: '/keep.md', content: 'pinned' });
    const view = await publish.publishFile(scope, { path: '/keep.md' });
    await workspace.writeFile(scope, { path: '/keep.md', content: 'newer' });
    /* Make the pinned version look like one the purge drops: superseded within its run, long ago. */
    await db()
      .update(schema.workspaceRevision)
      .set({ squashedInto: ((await workspace.statEntry(scope, '/keep.md')) as { revision: string }).revision, updatedAt: new Date(Date.now() - 10 * 86_400_000) })
      .where(eq(schema.workspaceRevision.id, view.revision));
    await db().update(schema.workspaceUsage).set({ purgedAt: null }).where(eq(schema.workspaceUsage.userId, scope.userId));
    await workspace.purgeWorkspaces(new Date(), 100_000);
    expect(await db().select().from(schema.workspaceRevision).where(eq(schema.workspaceRevision.id, view.revision))).toHaveLength(1);
    expect(await (await download(view.public_id)).text()).toBe('pinned');

    await publish.unpublish(scope, view.id);
    await db().update(schema.workspaceUsage).set({ purgedAt: null }).where(eq(schema.workspaceUsage.userId, scope.userId));
    await workspace.purgeWorkspaces(new Date(), 100_000);
    expect(await db().select().from(schema.workspaceRevision).where(eq(schema.workspaceRevision.id, view.revision))).toHaveLength(0);
  });
});

describeWithDb('publishing: unavailable and gone', () => {
  it('pauses a link while its file is in the trash, resumes it when restored, and ends it when deleted for good', async () => {
    const scope = await owner();
    await workspace.writeFile(scope, { path: '/t.md', content: 't' });
    const view = await publish.publishFile(scope, { path: '/t.md' });
    const trashed = await workspace.trashEntry(scope, { path: '/t.md' });
    expect((await publish.publicFile(view.public_id))?.availability).toBe('trashed');
    expect((await download(view.public_id)).status).toBe(404);
    await workspace.restoreEntry(scope, { trashId: trashed.trash_id });
    expect((await publish.publicFile(view.public_id))?.availability).toBe('live');

    const again = await workspace.trashEntry(scope, { path: '/t.md' });
    await workspace.purgeTrashed(scope, [again.trash_id]);
    expect(await publish.publicFile(view.public_id)).toBeNull();
    const [row] = await db().select().from(schema.workspacePublication).where(eq(schema.workspacePublication.id, view.id));
    expect(row).toMatchObject({ revokeReason: 'purged', entryId: null });
  });

  it('ends a link at once when the owner stops it, looking exactly like an id that never existed', async () => {
    const scope = await owner();
    await workspace.writeFile(scope, { path: '/s.md', content: 's' });
    const view = await publish.publishFile(scope, { path: '/s.md' });
    await publish.unpublish(scope, view.id);
    expect(await publish.publicFile(view.public_id)).toBeNull();
    expect(await publish.publicFile('A'.repeat(22))).toBeNull();
    const [gone, never] = await Promise.all([download(view.public_id), download('A'.repeat(22))]);
    expect([gone.status, await gone.text()]).toEqual([never.status, await never.text()]);
    /* Another account cannot stop or update someone else's file. */
    const other = await owner();
    await workspace.writeFile(scope, { path: '/s2.md', content: 's2' });
    const mine = await publish.publishFile(scope, { path: '/s2.md' });
    expect(await refused(publish.unpublish(other, mine.id))).toMatchObject({ code: 'not_found' });
  });
});

describeWithDb('publishing: downloads', () => {
  it('limits one address per file and hour, and each file and account per day', async () => {
    const scope = await owner();
    await workspace.writeFile(scope, { path: '/d.txt', content: 'x'.repeat(600 * 1024) });
    const view = await publish.publishFile(scope, { path: '/d.txt' });
    const from = ip();
    const { PUBLISH_DOWNLOADS_PER_IP_HOUR } = await import('@/lib/constants');
    for (let n = 0; n < PUBLISH_DOWNLOADS_PER_IP_HOUR; n += 1) expect((await download(view.public_id, from)).status).toBe(200);
    expect((await download(view.public_id, from)).status).toBe(429);

    const second = await owner();
    await workspace.writeFile(second, { path: '/e.txt', content: 'y'.repeat(600 * 1024) });
    const limited = await publish.publishFile(second, { path: '/e.txt' });
    await withCeiling('publishFileDailyMb', 1, async () => {
      expect((await download(limited.public_id)).status).toBe(200);
      expect((await download(limited.public_id)).status).toBe(429);
      expect((await publish.publicFile(limited.public_id))?.availability).toBe('daily_limit');
    });
  });

  it('bills the volume past the month’s free allowance with the daily storage charge', async () => {
    const scope = await owner();
    await workspace.writeFile(scope, { path: '/bill.txt', content: 'z'.repeat(700 * 1024) });
    const view = await publish.publishFile(scope, { path: '/bill.txt' });
    await withCeiling('publishFreeMbMonth', 1, async () => {
      for (let n = 0; n < 2; n += 1) expect((await download(view.public_id)).status).toBe(200);
    });
    const [usage] = await db().select().from(schema.workspaceUsage).where(eq(schema.workspaceUsage.userId, scope.userId));
    expect(usage!.egressMonthBytes).toBe(2 * 700 * 1024);
    expect(usage!.egressUnbilledBytes).toBe(2 * 700 * 1024 - 1024 * 1024);
    await db().update(schema.workspaceUsage).set({ chargedAt: new Date(Date.now() - 2 * 3_600_000) }).where(eq(schema.workspaceUsage.userId, scope.userId));
    await workspace.chargeWorkspaceStorage(new Date(), 100_000);
    const [after] = await db().select().from(schema.workspaceUsage).where(eq(schema.workspaceUsage.userId, scope.userId));
    expect(after!.egressUnbilledBytes).toBe(0);
    const [accrual] = await db().select().from(schema.storageAccrual).where(eq(schema.storageAccrual.userId, scope.userId));
    expect(BigInt(accrual!.costPico)).toBeGreaterThan(0n);
    const [day] = await db().select().from(schema.workspacePublicationDay).where(eq(schema.workspacePublicationDay.publicationId, view.id));
    expect(day).toMatchObject({ downloads: 2, bytes: 2 * 700 * 1024 });
  });
});

describeWithDb('publishing: reports, takedowns and freezing', () => {
  it('suspends a file reported from enough addresses, tells the owner, and lets an administrator restore it', async () => {
    const scope = await owner();
    await workspace.writeFile(scope, { path: '/r.md', content: 'r' });
    const view = await publish.publishFile(scope, { path: '/r.md' });
    const { PUBLISH_REPORT_SUSPEND } = await import('@/lib/constants');
    const same = ip();
    for (let n = 0; n < 3; n += 1) await publish.reportPublication(view.public_id, same, { reason: 'malware' });
    expect((await publish.publicFile(view.public_id))?.availability).toBe('live');
    for (let n = 1; n < PUBLISH_REPORT_SUSPEND; n += 1) await publish.reportPublication(view.public_id, ip(), { reason: 'phishing', note: 'looks off' });
    expect((await publish.publicFile(view.public_id))?.availability).toBe('suspended');
    expect((await download(view.public_id)).status).toBe(404);
    const notices = await db().select().from(schema.notice).where(and(eq(schema.notice.userId, scope.userId), eq(schema.notice.kind, 'publication')));
    expect(notices.map((notice) => notice.params.action)).toEqual(['suspended']);
    expect(await refused(publish.reportPublication(view.public_id, ip(), { reason: 'nonsense' }))).toMatchObject({ code: 'invalid_reason' });

    const adminId = await administrator();
    expect((await publish.adminPublications('suspended', view.public_id)).map((row) => row.id)).toEqual([view.id]);
    expect(await publish.adminRestore(adminId, view.id)).toBe(true);
    expect((await publish.publicFile(view.public_id))?.availability).toBe('live');
    expect((await publish.adminPublications('reported', view.public_id))).toHaveLength(0);
  });

  it('takes a file down for good, blocklists its bytes for every account, and logs it', async () => {
    const scope = await owner();
    const content = `blocked content ${uniqueName('c')}`;
    await workspace.writeFile(scope, { path: '/bad.md', content });
    const view = await publish.publishFile(scope, { path: '/bad.md' });
    const adminId = await administrator();
    expect(await publish.adminTakeDown(adminId, view.id, 'malware')).toBe(true);
    expect(await publish.adminTakeDown(adminId, view.id, 'again')).toBe(false);
    expect(await publish.publicFile(view.public_id)).toBeNull();
    const [audit] = await db().select().from(schema.adminAudit).where(and(eq(schema.adminAudit.action, 'workspace.publication.takedown'), eq(schema.adminAudit.target, view.id)));
    expect(audit).toBeTruthy();

    const other = await owner();
    await workspace.writeFile(other, { path: '/copy.md', content });
    expect(failed((await publish.publishCheck(other, { path: '/copy.md' })).checks)).toEqual(['blocked']);
    await workspace.writeFile(scope, { path: '/bad.md', content: `${content} (edited)` });
    expect((await publish.publishCheck(scope, { path: '/bad.md' })).ok).toBe(true);
  });

  it('freezing an account makes its links unavailable and stops it publishing, until unfrozen', async () => {
    const scope = await owner();
    await workspace.writeFile(scope, { path: '/f.md', content: 'f' });
    await workspace.writeFile(scope, { path: '/g.md', content: 'g' });
    const view = await publish.publishFile(scope, { path: '/f.md' });
    const adminId = await administrator();
    expect(await publish.adminFreezePublishing(adminId, scope.userId, true)).toBe(true);
    expect((await publish.publicFile(view.public_id))?.availability).toBe('owner_unavailable');
    expect(failed((await publish.publishCheck(scope, { path: '/g.md' })).checks)).toEqual(['account:frozen']);
    expect(await publish.adminFreezePublishing(adminId, scope.userId, false)).toBe(true);
    expect((await publish.publicFile(view.public_id))?.availability).toBe('live');
  });

  it('makes links unavailable while the owner is disabled', async () => {
    const scope = await owner();
    await workspace.writeFile(scope, { path: '/u.md', content: 'u' });
    const view = await publish.publishFile(scope, { path: '/u.md' });
    await db().update(schema.user).set({ disabledAt: new Date() }).where(eq(schema.user.id, scope.userId));
    try {
      expect((await publish.publicFile(view.public_id))?.availability).toBe('owner_unavailable');
      expect((await download(view.public_id)).status).toBe(404);
    } finally {
      await db().update(schema.user).set({ disabledAt: null }).where(eq(schema.user.id, scope.userId));
    }
  });
});

describeWithDb('publishing: agents and citations', () => {
  it('refuses a key-held scope (no MCP publishing), and lists the owner’s files with their state', async () => {
    const scope = await owner();
    await workspace.writeFile(scope, { path: '/m.md', content: 'm' });
    expect(await refused(publish.publishFile({ ...scope, apiKeyId: '00000000-0000-0000-0000-000000000001' }, { path: '/m.md' }))).toMatchObject({ code: 'forbidden' });
    const view = await publish.publishFile(scope, { path: '/m.md' });
    await workspace.writeFile(scope, { path: '/m.md', content: 'm2' });
    expect(await publish.publicationsOf(scope)).toEqual([expect.objectContaining({ id: view.id, path: '/m.md', stale: true, trashed: false })]);
  });

  it('gives a cited workspace file its public link, only while it is live', async () => {
    const scope = await owner();
    await workspace.writeFile(scope, { path: '/cite.md', content: 'cited' });
    const entry = (await db().select({ id: schema.workspaceEntry.id }).from(schema.workspaceEntry).where(and(eq(schema.workspaceEntry.workspaceId, scope.workspaceId), eq(schema.workspaceEntry.path, '/cite.md'), isNull(schema.workspaceEntry.deletedAt))))[0]!;
    const [ree] = await db().insert(schema.ree).values({ ownerId: scope.userId, name: 'Cites', slug: uniqueName('cites').toLowerCase(), category: 'other' }).returning({ id: schema.ree.id });
    const [knowledge] = await db()
      .insert(schema.knowledge)
      .values({ reeId: ree!.id, kind: 'file', title: 'cite.md', originalTitle: 'cite.md', status: 'ready', workspaceEntryId: entry.id })
      .returning({ id: schema.knowledge.id });
    expect((await publish.publishedOriginals([knowledge!.id])).size).toBe(0);
    const view = await publish.publishFile(scope, { path: '/cite.md' });
    expect(await publish.publishedOriginals([knowledge!.id, knowledge!.id])).toEqual(new Map([[knowledge!.id, `/f/${view.public_id}`]]));
    await db().update(schema.workspacePublication).set({ suspendedAt: new Date() }).where(eq(schema.workspacePublication.id, view.id));
    expect((await publish.publishedOriginals([knowledge!.id])).size).toBe(0);
    await db().execute(sql`select 1`);
  });
});
