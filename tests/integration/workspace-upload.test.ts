/**
 * The workspace's third phase (docs/design/agent-workspace.md §3.1, §4.3,
 * §8): bytes in by upload URL (one PUT, or parts stitched without holding the
 * file), out by signed download URL; binary files refused by the text tools
 * with a clear error; uploads checked before any byte, scoped to the key's
 * root, single-use, and cleaned up unbilled when unfinished; PDF and Word
 * files indexed; and the web's upload, download and version comparison.
 * Objects go to a local folder (WORKSPACE_BLOB_DIR), so the stitching runs
 * on real streams.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import { handbookPages, makePdf } from '../fixtures/pdf';
import { makeDocx, word } from '../fixtures/docx';

const blobDir = mkdtempSync(join(tmpdir(), 're0-ws-upload-'));
process.env.WORKSPACE_BLOB_DIR = blobDir;
vi.mock('next/server', async (original) => ({ ...(await original<typeof import('next/server')>()), after: () => undefined }));
const signedIn = vi.hoisted(() => ({ id: '' }));
vi.mock('@/lib/http/session', async (original) => ({ ...(await original<typeof import('@/lib/http/session')>()), apiUser: async () => ({ id: signedIn.id }) }));

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const apiKeys = await import('@/lib/services/api-keys');
const workspace = await import('@/lib/services/workspace');
const uploads = await import('@/lib/services/workspace-upload');
const index = await import('@/lib/services/workspace-index');
const { db, schema } = await import('@/lib/infra/db');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { addGrant } = await import('@/lib/services/credits');
const { WORKSPACE_UPLOAD_PART } = await import('@/lib/constants');
const mcpRoute = await import('@/app/api/mcp/route');
const putRoute = await import('@/app/api/files/upload/[token]/route');
const getRoute = await import('@/app/api/files/download/[token]/route');
const webUpload = await import('@/app/api/files/upload/route');
const rawRoute = await import('@/app/api/files/raw/route');

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(() => {
  fake?.close();
  rmSync(blobDir, { recursive: true, force: true });
});

const routeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const handler = { GET: mcpRoute.GET, POST: mcpRoute.POST, DELETE: mcpRoute.DELETE }[request.method as 'GET' | 'POST' | 'DELETE'];
  return handler ? handler(request as Parameters<typeof mcpRoute.POST>[0]) : new Response(null, { status: 405 });
};

async function person(credits = 1_000) {
  const subject = uniqueName('wsu');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: subject, avatarUrl: null }, 'en', '/');
  if (credits) await db().transaction((tx) => addGrant(tx, { userId, source: 'pack', amount: credits, reason: 'admin_adjust', refId: crypto.randomUUID() }));
  return userId;
}

async function connect(userId: string, options: { kind?: 'account' | 'workspace'; workspaceAccess?: 'read' | 'write'; workspaceRoot?: string } = {}) {
  const made = await apiKeys.createApiKey(userId, { name: 'k', kind: options.kind, workspaceAccess: options.workspaceAccess ?? 'write', workspaceRoot: options.workspaceRoot });
  const client = new Client({ name: 'claude-code', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3000/api/mcp'), { fetch: routeFetch, requestInit: { headers: { authorization: `Bearer ${made.secret}` } } }));
  return { client, keyId: made.key.id };
}

type ToolResult = { isError?: boolean; structuredContent?: Record<string, any>; content: { text?: string }[] };
async function call(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}
async function ok(client: Client, name: string, args: Record<string, unknown>) {
  const result = await call(client, name, args);
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`);
  return result.structuredContent!;
}
async function refused(client: Client, name: string, args: Record<string, unknown>) {
  const result = await call(client, name, args);
  expect(result.isError, `${name} should fail`).toBe(true);
  return result.structuredContent!;
}

const tokenOf = (url: string) => new URL(url).pathname.split('/').pop()!;
const put = (url: string, body: Uint8Array, part?: number, length = body.length) =>
  putRoute.PUT(new NextRequest(`${url}${part ? `?part=${part}` : ''}`, { method: 'PUT', body: Buffer.from(body), headers: { 'content-length': String(length) } }), { params: Promise.resolve({ token: tokenOf(url) }) });
const download = (url: string) => getRoute.GET(new NextRequest(url), { params: Promise.resolve({ token: tokenOf(url) }) });
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytesOf = async (response: Response) => new Uint8Array(await response.arrayBuffer());
/** Bytes that are not text: a PNG header, a NUL, then noise. */
const binary = (size: number, seed = 1) => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  let x = seed;
  for (let i = 9; i < size; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = x & 0xff;
  }
  return bytes;
};
const uploadFiles = () => readdirSync(blobDir, { recursive: true }).map(String).filter((name) => /\/upload\/[^/]+\/\d+$/.test(name));

describeWithDb('uploads and downloads by URL', () => {
  it('takes a binary file in one PUT, refuses it to the text tools, and gives it back byte for byte', async () => {
    const userId = await person();
    const { client } = await connect(userId);
    const png = binary(50_000);
    const ticket = await ok(client, 'ws_upload_url', { path: '/img/logo.png', size: png.length });
    expect(ticket).toMatchObject({ method: 'PUT', parts: 1, path: '/img/logo.png' });
    expect(ticket.curl).toContain('curl -fsS -X PUT -T');
    const saved = await put(ticket.url, png);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ done: true, path: '/img/logo.png', sha256: sha(png), binary: true, size: png.length });
    /* The URL works once. */
    expect((await put(ticket.url, png)).status).toBe(409);

    expect(await ok(client, 'ws_stat', { path: '/img/logo.png' })).toMatchObject({ binary: true, media_type: 'image/png' });
    const read = await refused(client, 'ws_read', { path: '/img/logo.png' });
    expect(read.error).toBe('binary_file');
    expect((await call(client, 'ws_read', { path: '/img/logo.png' })).content[0]!.text).toMatch(/ws_download_url.*curl -o.*without a shell/s);
    expect((await refused(client, 'ws_edit', { path: '/img/logo.png', old_string: 'a', new_string: 'b' })).error).toBe('binary_file');
    expect((await refused(client, 'ws_append', { path: '/img/logo.png', content: 'x' })).error).toBe('binary_file');
    expect((await ok(client, 'ws_grep', { pattern: 'PNG' })).matches).toEqual([]);

    const link = await ok(client, 'ws_download_url', { path: '/img/logo.png' });
    const got = await download(link.url);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('content-disposition')).toMatch(/^attachment; filename="logo.png"/);
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(got.headers.get('content-security-policy')).toContain('sandbox');
    expect(got.headers.get('cache-control')).toBe('private, no-store');
    expect(sha(await bytesOf(got))).toBe(sha(png));

    /* Copying names the same object; storage counts it once. */
    const [before] = await db().select().from(schema.workspaceUsage).where(eq(schema.workspaceUsage.userId, userId));
    await ok(client, 'ws_copy', { from: '/img/logo.png', to: '/img/logo-2.png' });
    const [after] = await db().select().from(schema.workspaceUsage).where(eq(schema.workspaceUsage.userId, userId));
    expect(after!.blobBytes).toBe(before!.blobBytes);
    expect(sha(await bytesOf(await download((await ok(client, 'ws_download_url', { path: '/img/logo-2.png' })).url)))).toBe(sha(png));
  });

  it('stitches a file sent in parts, out of order and with a part sent twice, without leaving the parts behind', async () => {
    const userId = await person();
    const { client } = await connect(userId);
    const file = binary(2 * WORKSPACE_UPLOAD_PART + 12_345, 7);
    const ticket = await ok(client, 'ws_upload_url', { path: '/big/data.bin', size: file.length });
    expect(ticket.parts).toBe(3);
    expect(ticket.curl).toMatch(/split -b 4194304 .*part=/);
    const part = (n: number) => file.slice((n - 1) * WORKSPACE_UPLOAD_PART, n * WORKSPACE_UPLOAD_PART);
    expect(await (await put(ticket.url, part(3), 3)).json()).toMatchObject({ done: false, received: 1, parts: 3 });
    expect(await (await put(ticket.url, part(1), 1)).json()).toMatchObject({ done: false, received: 2 });
    expect(await (await put(ticket.url, part(1), 1)).json()).toMatchObject({ done: false, received: 2 });
    expect(uploadFiles().length).toBe(2);
    const last = await put(ticket.url, part(2), 2);
    expect(await last.json()).toMatchObject({ done: true, sha256: sha(file), size: file.length });
    expect(uploadFiles()).toEqual([]);
    const got = await bytesOf(await download((await ok(client, 'ws_download_url', { path: '/big/data.bin' })).url));
    expect(sha(got)).toBe(sha(file));
    expect((await ok(client, 'ws_history', { path: '/big/data.bin' })).versions[0]).toMatchObject({ op: 'upload' });
    const [usage] = await db().select().from(schema.workspaceUsage).where(eq(schema.workspaceUsage.userId, userId));
    expect(usage!.blobBytes).toBeGreaterThanOrEqual(file.length);
  });

  it('checks each part before reading it, and keeps uploaded text readable by lines', async () => {
    const userId = await person();
    const { client } = await connect(userId);
    const ticket = await ok(client, 'ws_upload_url', { path: '/t/notes.md', size: 12 });
    expect((await put(ticket.url, new TextEncoder().encode('hello world!'), undefined, 99)).status).toBe(400);
    expect((await put(ticket.url, new TextEncoder().encode('hello world!!'))).status).toBe(400);
    expect((await put(ticket.url, new TextEncoder().encode('hello world!'), 2)).status).toBe(400);
    expect((await put(ticket.url, new TextEncoder().encode('hello world!'))).status).toBe(200);
    expect(await ok(client, 'ws_read', { path: '/t/notes.md' })).toMatchObject({ content: 'hello world!' });
    expect(await ok(client, 'ws_stat', { path: '/t/notes.md' })).toMatchObject({ binary: false });
    /* A token that was never issued, or tampered with. */
    expect((await putRoute.PUT(new NextRequest('http://localhost/api/files/upload/nope', { method: 'PUT', body: 'x' }), { params: Promise.resolve({ token: 'A'.repeat(43) }) })).status).toBe(404);
  });

  it('refuses an upload before any byte when the save would be refused', async () => {
    const userId = await person();
    const { client } = await connect(userId);
    expect((await call(client, 'ws_upload_url', { path: '/x.bin', size: 101 * 1024 * 1024 })).isError).toBe(true);
    await expect(uploads.createUpload(await workspace.webScope(userId), { path: '/x.bin', size: 101 * 1024 * 1024 })).rejects.toMatchObject({ code: 'too_large' });
    await ok(client, 'ws_mkdir', { path: '/dir' });
    expect((await refused(client, 'ws_upload_url', { path: '/dir', size: 10 })).error).toBe('is_a_directory');
    await ok(client, 'ws_write', { path: '/here.txt', content: 'x' });
    expect((await refused(client, 'ws_upload_url', { path: '/here.txt', size: 10, if_none_match: '*' })).error).toBe('exists');
    expect((await refused(client, 'ws_upload_url', { path: '/here.txt', size: 10, if_match: 'stale' })).error).toBe('conflict');
    /* Debt over the limit stops writing, uploads included. */
    await db().insert(schema.creditDebt).values({ userId, amount: 500, remaining: 500 });
    expect((await refused(client, 'ws_upload_url', { path: '/later.bin', size: 10 })).error).toBe('insufficient_credits');
  });

  it('keeps a key to its root, its access and its life, at the URL and at the upload', async () => {
    const userId = await person();
    const { client: owner } = await connect(userId);
    await ok(owner, 'ws_write', { path: '/b/secret.txt', content: 'not for the scoped key' });
    const { client: scoped, keyId } = await connect(userId, { kind: 'workspace', workspaceRoot: '/a' });
    const ticket = await ok(scoped, 'ws_upload_url', { path: '/inside.bin', size: 20 });
    expect(ticket.path).toBe('/inside.bin');
    const [row] = await db().select().from(schema.workspaceUpload).where(eq(schema.workspaceUpload.tokenHash, await (await import('@/lib/infra/crypto/tokens')).sha256(tokenOf(ticket.url))));
    expect(row!.path).toBe('/a/inside.bin');
    expect((await refused(scoped, 'ws_download_url', { path: '/../b/secret.txt' })).error).toMatch(/invalid_path|not_found/);
    const { client: reader } = await connect(userId, { kind: 'workspace', workspaceAccess: 'read' });
    expect((await refused(reader, 'ws_upload_url', { path: '/x.bin', size: 5 })).error).toBe('workspace_not_allowed');
    /* Revoked after the URL was given: the upload fails. */
    await db().update(schema.apiKey).set({ revokedAt: new Date() }).where(eq(schema.apiKey.id, keyId));
    expect((await put(ticket.url, binary(20))).status).toBe(403);
    expect((await workspace.listEntries(await workspace.webScope(userId), { path: '/a' }).catch(() => ({ entries: [] }))).entries).toEqual([]);

    /* A download URL is for one file, for ten minutes, and cannot be altered. */
    const link = await ok(owner, 'ws_download_url', { path: '/b/secret.txt' });
    const [payload, signature] = tokenOf(link.url).split('.');
    expect((await getRoute.GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ token: `${payload}x.${signature}` }) })).status).toBe(404);
    await expect(uploads.openDownload(tokenOf(link.url), new Date(Date.now() + 11 * 60_000))).rejects.toMatchObject({ status: 410 });
    await ok(owner, 'ws_delete', { path: '/b/secret.txt' });
    expect((await download(link.url)).status).toBe(404);
  });

  it('cleans up an unfinished upload once it expires, without ever billing it', async () => {
    const userId = await person();
    const { client } = await connect(userId);
    const file = binary(WORKSPACE_UPLOAD_PART + 10, 3);
    const ticket = await ok(client, 'ws_upload_url', { path: '/half.bin', size: file.length });
    await put(ticket.url, file.slice(0, WORKSPACE_UPLOAD_PART), 1);
    expect(uploadFiles().length).toBeGreaterThan(0);
    const [usage] = await db().select().from(schema.workspaceUsage).where(eq(schema.workspaceUsage.userId, userId));
    expect(usage?.blobBytes ?? 0).toBe(0);
    const ended = await uploads.reapUploads(new Date(Date.now() + 2 * 60 * 60_000));
    expect(ended.ended).toBeGreaterThanOrEqual(1);
    expect(uploadFiles().filter((name) => name.includes(ticket.url.split('/').pop()!))).toEqual([]);
    const [row] = await db().select().from(schema.workspaceUpload).where(and(eq(schema.workspaceUpload.userId, userId), eq(schema.workspaceUpload.path, '/half.bin')));
    expect(row).toMatchObject({ status: 'failed', error: 'expired' });
    expect((await put(ticket.url, file.slice(WORKSPACE_UPLOAD_PART), 2)).status).toBe(410);
    await uploads.reapUploads(new Date(Date.now() + 25 * 60 * 60_000));
    expect(await db().select().from(schema.workspaceUpload).where(eq(schema.workspaceUpload.id, row!.id))).toEqual([]);
    expect(await workspace.kindAt(await workspace.webScope(userId), '/half.bin')).toBeNull();
  });
});

describeWithDb('PDF and Word files in the index', () => {
  it('indexes a PDF by page and a Word file, and says when a file has no text to read', async () => {
    const userId = await person();
    const { client } = await connect(userId);
    await ok(client, 'ws_mkdir', { path: '/docs' });
    await ok(client, 'ws_index', { path: '/docs', mode: 'on' });
    const send = async (path: string, bytes: Uint8Array) => {
      const ticket = await ok(client, 'ws_upload_url', { path, size: bytes.length });
      expect((await put(ticket.url, bytes)).status).toBe(200);
    };
    await send('/docs/handbook.pdf', makePdf(handbookPages().slice(0, 4)));
    await send('/docs/memo.docx', makeDocx([word.heading(1, 'Travel memo'), word.paragraph('The ferry to Isla Yacyretá leaves every Tuesday at dawn.')]));
    await send('/docs/photo.png', binary(2_000));
    const estimate = await index.estimateIndex(await workspace.webScope(userId), '/docs');
    expect(estimate.files).toBe(2);
    await index.runIndexQueue(new Date(Date.now() + 3 * 60_000), { limit: 100 });
    const found = await ok(client, 'ws_search', { query: 'Refunds are issued to the original payment method within 14 days' });
    expect(found.passages[0]).toMatchObject({ path: '/docs/handbook.pdf' });
    expect((await ok(client, 'ws_search', { query: 'ferry Isla Yacyretá Tuesday dawn' })).passages[0]).toMatchObject({ path: '/docs/memo.docx' });
    const pages = await db().select({ locator: schema.workspacePassage.locator }).from(schema.workspacePassage).innerJoin(schema.workspaceEntry, eq(schema.workspaceEntry.id, schema.workspacePassage.entryId)).where(eq(schema.workspaceEntry.path, '/docs/handbook.pdf'));
    expect(pages.some((row) => row.locator.page === 3)).toBe(true);
    /* An image is never indexed; a PDF with nothing to read says so. */
    expect(await ok(client, 'ws_stat', { path: '/docs/photo.png' })).toMatchObject({ index: null });
    await send('/docs/empty.pdf', makePdf([['']]));
    await index.runIndexQueue(new Date(Date.now() + 3 * 60_000), { limit: 100 });
    expect(await ok(client, 'ws_stat', { path: '/docs/empty.pdf' })).toMatchObject({ index: 'unreadable' });
  });
});

describeWithDb('the web: upload, download, compare', () => {
  it('uploads through the web route, downloads any version, and compares text versions', async () => {
    const userId = await person();
    signedIn.id = userId;
    const scope = await workspace.webScope(userId);
    const made = await webUpload.POST(new NextRequest('http://localhost/api/files/upload', { method: 'POST', body: JSON.stringify({ path: '/w/a.bin', size: 300 }) }));
    expect(made.status).toBe(201);
    const ticket = (await made.json()) as { url: string };
    const bytes = binary(300, 9);
    expect((await put(ticket.url, bytes)).status).toBe(200);
    const raw = await rawRoute.GET(new NextRequest('http://localhost/api/files/raw?path=/w/a.bin'));
    expect(raw.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(sha(await bytesOf(raw))).toBe(sha(bytes));

    await workspace.writeFile(scope, { path: '/w/plan.md', content: 'one\ntwo\nthree\n' });
    const [first] = (await workspace.fileHistory(scope, { path: '/w/plan.md' })).versions;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await db().update(schema.workspaceRevision).set({ runStartedAt: new Date(Date.now() - 120_000) }).where(eq(schema.workspaceRevision.id, first!.revision));
    await workspace.writeFile(scope, { path: '/w/plan.md', content: 'one\n2\nthree\nfour\n' });
    const diff = await workspace.compareVersions(scope, '/w/plan.md', first!.revision);
    expect(diff.lines!.filter((line) => line.kind !== 'same').map((line) => `${line.kind}:${line.text}`)).toEqual(['removed:two', 'added:2', 'added:four']);
    const old = await rawRoute.GET(new NextRequest(`http://localhost/api/files/raw?path=/w/plan.md&revision=${first!.revision}`));
    expect(await old.text()).toBe('one\ntwo\nthree\n');
  });
});
