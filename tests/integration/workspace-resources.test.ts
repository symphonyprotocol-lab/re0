/**
 * The workspace's MCP resources (docs/design/agent-workspace-p4.md §3,
 * lib/http/mcp-resources.ts) through the MCP route and the official client:
 * which keys declare them, the list (newest first, paged, capped), reads of
 * text and small images and the refusals of everything else, path
 * completion, a key's root, the read limit, and the resource_link parts on
 * ws_read and ws_list. Blob is the local store in a temporary folder.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { freezeDateAtWindowStart, TEST_DATABASE_URL, uniqueName } from './setup';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const blobDir = mkdtempSync(join(tmpdir(), 're0-ws-resources-'));
process.env.WORKSPACE_BLOB_DIR = blobDir;

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const apiKeys = await import('@/lib/services/api-keys');
const workspace = await import('@/lib/services/workspace');
const uploads = await import('@/lib/services/workspace-upload');
const resources = await import('@/lib/services/workspace-resources');
const route = await import('@/app/api/mcp/route');
const { db, schema } = await import('@/lib/infra/db');
const { forgetRateLimitSettings } = await import('@/lib/services/rate-limit-settings');
const { WORKSPACE_UPLOAD_PART } = await import('@/lib/constants');

afterAll(() => rmSync(blobDir, { recursive: true, force: true }));
afterEach(() => {
  vi.useRealTimers();
});

const URL_ = 'http://localhost:3000/api/mcp';

const routeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const handler = { GET: route.GET, POST: route.POST, DELETE: route.DELETE }[request.method as 'GET' | 'POST' | 'DELETE'];
  if (!handler) return new Response(null, { status: 405 });
  return handler(request as Parameters<typeof route.POST>[0]);
};

async function person() {
  const subject = uniqueName('wsr');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: subject, avatarUrl: null }, 'en', '/');
  return userId;
}

type KeyOptions = { kind?: 'account' | 'workspace'; workspaceAccess?: 'none' | 'read' | 'write'; workspaceRoot?: string };

async function connectWithKey(userId: string, options: KeyOptions = {}) {
  const { secret, key } = await apiKeys.createApiKey(userId, { name: 'k', canWrite: false, kind: options.kind, workspaceAccess: options.workspaceAccess, workspaceRoot: options.workspaceRoot });
  const client = new Client({ name: 're0-tests', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { fetch: routeFetch, requestInit: { headers: { authorization: `Bearer ${secret}` } } }));
  return { client, keyId: key.id };
}

const connect = async (userId: string, options: KeyOptions = {}) => (await connectWithKey(userId, options)).client;

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text?: string; uri?: string; name?: string; mimeType?: string }[] };

async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`);
  return result;
}

async function upload(scope: Awaited<ReturnType<typeof workspace.webScope>>, path: string, bytes: Uint8Array) {
  const ticket = await uploads.createUpload(scope, { path, size: bytes.length });
  const token = ticket.url.split('/').pop()!;
  let result;
  for (let n = 1; n <= ticket.parts; n += 1) {
    const part = bytes.slice((n - 1) * WORKSPACE_UPLOAD_PART, n * WORKSPACE_UPLOAD_PART);
    result = await uploads.receivePart(token, { part: ticket.parts === 1 ? null : String(n), contentLength: String(part.length), body: new Response(Buffer.from(part)).body });
  }
  expect(result).toMatchObject({ done: true });
}

const { McpServer, completable } = await import('@modelcontextprotocol/server');
const { registerWorkspaceResources } = await import('@/lib/http/mcp-resources');
const { z } = await import('zod');

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4, 0, 255]);

/** Moves every file's change time apart, oldest first in `paths` order, so "newest first" has one answer. */
async function stagger(workspaceId: string, paths: string[]) {
  for (const [n, path] of paths.entries()) {
    await db().execute(sql`update agent_workspace_entry set updated_at = now() - make_interval(secs => ${paths.length - n}) where workspace_id = ${workspaceId} and path = ${path}`);
  }
}

describeWithDb('workspace resources: who sees them', () => {
  it('are declared only to keys that reach the workspace, without subscriptions', async () => {
    const userId = await person();
    const none = await connect(userId, { workspaceAccess: 'none' });
    expect(none.getServerCapabilities()?.resources).toBeUndefined();
    /* The client returns an empty list for a server without resources. */
    expect((await none.listResources()).resources).toEqual([]);

    for (const options of [{ workspaceAccess: 'read' as const }, { kind: 'workspace' as const, workspaceAccess: 'read' as const }]) {
      const client = await connect(userId, options);
      expect(client.getServerCapabilities()?.resources).toEqual({ subscribe: false, listChanged: false });
      expect(client.getServerCapabilities()?.completions).toEqual({});
      const { resourceTemplates } = await client.listResourceTemplates();
      expect(resourceTemplates.map((template) => template.uriTemplate)).toEqual(['re0://ws/{+path}']);
    }
  });
});

describeWithDb('workspace resources: list', () => {
  it('lists the files ws_list shows, newest first, a page at a time', async () => {
    const userId = await person();
    const client = await connect(userId, { workspaceAccess: 'write' });
    await tool(client, 'ws_write', { path: '/notes/a.md', content: '# a' });
    await tool(client, 'ws_write', { path: '/notes/b b.md', content: 'b' });
    await tool(client, 'ws_write', { path: '/top.txt', content: 'top' });
    await tool(client, 'ws_mkdir', { path: '/empty' });
    const scope = await workspace.webScope(userId);
    await stagger(scope.workspaceId, ['/notes/a.md', '/notes/b b.md', '/top.txt']);

    const { resources: listed, nextCursor } = await client.listResources();
    expect(nextCursor).toBeUndefined();
    expect(listed.map((resource) => resource.uri)).toEqual(['re0://ws/top.txt', 're0://ws/notes/b%20b.md', 're0://ws/notes/a.md']);
    expect(listed[1]).toMatchObject({ name: 'b b.md', title: '/notes/b b.md', mimeType: 'text/markdown', size: 1 });
    expect(Date.parse(listed[0]!.annotations!.lastModified!)).not.toBeNaN();

    const files = ((await tool(client, 'ws_list', { recursive: true })).structuredContent!.entries as { path: string; kind: string }[]).filter((entry) => entry.kind === 'file');
    expect(listed.map((resource) => resource.title).sort()).toEqual(files.map((entry) => entry.path).sort());
  });

  it('pages by cursor, stops after RESOURCE_PAGES pages and refuses a cursor it did not give', async () => {
    const userId = await person();
    const scope = await workspace.webScope(userId);
    const total = resources.RESOURCE_PAGE + 5;
    for (let n = 0; n < total; n += 1) await workspace.writeFile(scope, { path: `/many/f${String(n).padStart(3, '0')}.txt`, content: String(n) });
    /* Many share a timestamp to the microsecond's neighbourhood: the id breaks ties, so no file is listed twice or skipped. */
    const first = await resources.listResources(scope);
    expect(first.resources).toHaveLength(resources.RESOURCE_PAGE);
    expect(first.nextCursor).toBeTruthy();
    const second = await resources.listResources(scope, first.nextCursor);
    expect(second.resources).toHaveLength(5);
    expect(second.nextCursor).toBeUndefined();
    expect(new Set([...first.resources, ...second.resources].map((resource) => resource.uri)).size).toBe(total);

    /* The client walks the pages itself when given no cursor, and passes one through when given it. */
    const client = await connect(userId, { workspaceAccess: 'read' });
    expect((await client.listResources()).resources).toHaveLength(total);
    expect((await client.listResources({ cursor: first.nextCursor })).resources.map((resource) => resource.uri)).toEqual(second.resources.map((resource) => resource.uri));

    /* The page count is in the signed cursor: past RESOURCE_PAGES nothing more, and the last page gives no cursor. */
    const last = resources.encodeCursor(scope, { t: '2026-01-01 00:00:00+00', i: '00000000-0000-0000-0000-000000000000', p: resources.RESOURCE_PAGES });
    expect((await resources.listResources(scope, last)).resources).toEqual([]);
    const penultimate = resources.encodeCursor(scope, { t: '2999-01-01 00:00:00+00', i: '00000000-0000-0000-0000-000000000000', p: resources.RESOURCE_PAGES - 1 });
    const lastPage = await resources.listResources(scope, penultimate);
    expect(lastPage.resources).toHaveLength(resources.RESOURCE_PAGE);
    expect(lastPage.nextCursor).toBeUndefined();
    await expect(client.listResources({ cursor: 'not-a-cursor' })).rejects.toThrow(/cursor/);
    /* Writes 100+ files one by one: slow under the full suite's load. */
  }, 60_000);
});

describeWithDb('workspace resources: read', () => {
  it('reads text whole and byte-exact, and a small image as base64', async () => {
    const userId = await person();
    const client = await connect(userId, { workspaceAccess: 'write' });
    const text = 'line one\r\n\ttabbed — ünïcode 😀\n\n';
    await tool(client, 'ws_write', { path: '/dir/exact.md', content: text });
    const { contents } = await client.readResource({ uri: 're0://ws/dir/exact.md' });
    expect(contents).toEqual([{ uri: 're0://ws/dir/exact.md', mimeType: 'text/markdown', text }]);

    await upload(await workspace.webScope(userId), '/img/dot.png', PNG);
    const image = await client.readResource({ uri: 're0://ws/img/dot.png' });
    expect(image.contents[0]).toMatchObject({ uri: 're0://ws/img/dot.png', mimeType: 'image/png' });
    expect(Buffer.from((image.contents[0] as { blob: string }).blob, 'base64')).toEqual(Buffer.from(PNG));

    /* Percent-encoded names read the file they name. */
    await tool(client, 'ws_write', { path: '/a b/c#d.md', content: 'x' });
    const encoded = (await client.listResources()).resources.find((resource) => resource.title === '/a b/c#d.md')!;
    expect(encoded.uri).toBe('re0://ws/a%20b/c%23d.md');
    expect((await client.readResource({ uri: encoded.uri })).contents[0]).toMatchObject({ text: 'x' });
  });

  it('refuses folders, missing files, big images, PDFs and text over 1 MB, saying where to get them', async () => {
    const userId = await person();
    const client = await connect(userId, { workspaceAccess: 'write' });
    const scope = await workspace.webScope(userId);
    await tool(client, 'ws_mkdir', { path: '/folder' });
    await upload(scope, '/big.png', Uint8Array.from({ length: resources.RESOURCE_IMAGE_MAX + 1 }, (_, n) => (n < PNG.length ? PNG[n]! : n % 251)));
    await upload(scope, '/doc.pdf', new TextEncoder().encode('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n'));
    await upload(scope, '/huge.txt', new TextEncoder().encode('a'.repeat(1024 * 1024 + 10)));

    await expect(client.readResource({ uri: 're0://ws/folder' })).rejects.toThrow(/is a folder/);
    await expect(client.readResource({ uri: 're0://ws/nothing.md' })).rejects.toThrow(/Nothing at \/nothing\.md/);
    await expect(client.readResource({ uri: 'https://example.com/x' })).rejects.toThrow(/not a workspace resource/);
    await expect(client.readResource({ uri: 're0://ws/big.png' })).rejects.toThrow(/ws_download_url/);
    await expect(client.readResource({ uri: 're0://ws/doc.pdf' })).rejects.toThrow(/binary file.*ws_download_url/);
    await expect(client.readResource({ uri: 're0://ws/huge.txt' })).rejects.toThrow(/more than the 1048576/);
  });

  it('counts reads, lists and completions against the workspace read limit', async () => {
    const userId = await person();
    const client = await connect(userId, { workspaceAccess: 'write' });
    await tool(client, 'ws_write', { path: '/r.md', content: 'r' });
    freezeDateAtWindowStart(60);
    await db().insert(schema.rateLimitSetting).values({ name: 'workspaceRead', perMinute: 3, perHour: 1000 }).onConflictDoUpdate({ target: schema.rateLimitSetting.name, set: { perMinute: 3, perHour: 1000 } });
    forgetRateLimitSettings();
    try {
      await client.readResource({ uri: 're0://ws/r.md' });
      await client.listResources();
      await client.complete({ ref: { type: 'ref/resource', uri: 're0://ws/{+path}' }, argument: { name: 'path', value: 'r' } });
      await expect(client.readResource({ uri: 're0://ws/r.md' })).rejects.toThrow(/Too many workspace calls/);
    } finally {
      await db().delete(schema.rateLimitSetting).where(eq(schema.rateLimitSetting.name, 'workspaceRead'));
      forgetRateLimitSettings();
    }
  });
});

describeWithDb('workspace resources: a key limited to a folder', () => {
  it('lists, reads and completes only inside its root, with paths relative to it', async () => {
    const userId = await person();
    const scope = await workspace.webScope(userId);
    await workspace.writeFile(scope, { path: '/proj/in.md', content: 'inside' });
    await workspace.writeFile(scope, { path: '/proj/sub/deep.md', content: 'deep' });
    await workspace.writeFile(scope, { path: '/projX/out.md', content: 'outside, same prefix' });
    await workspace.writeFile(scope, { path: '/secret.md', content: 'outside' });
    const client = await connect(userId, { kind: 'workspace', workspaceAccess: 'read', workspaceRoot: '/proj' });

    const titles = (await client.listResources()).resources.map((resource) => resource.title).sort();
    expect(titles).toEqual(['/in.md', '/sub/deep.md']);
    expect((await client.readResource({ uri: 're0://ws/in.md' })).contents[0]).toMatchObject({ text: 'inside' });
    await expect(client.readResource({ uri: 're0://ws/secret.md' })).rejects.toThrow(/Nothing at/);
    await expect(client.readResource({ uri: 're0://ws/../secret.md' })).rejects.toThrow();
    await expect(client.readResource({ uri: 're0://ws/%2E%2E/secret.md' })).rejects.toThrow();

    const all = await client.complete({ ref: { type: 'ref/resource', uri: 're0://ws/{+path}' }, argument: { name: 'path', value: '' } });
    expect([...all.completion.values].sort()).toEqual(['in.md', 'sub/', 'sub/deep.md']);
    const none = await client.complete({ ref: { type: 'ref/resource', uri: 're0://ws/{+path}' }, argument: { name: 'path', value: '../' } });
    expect(none.completion.values).toEqual([]);
  });
});

describeWithDb('workspace resources: completion', () => {
  it('completes a typed prefix, ignoring case and LIKE wildcards, folders ending in a slash, and says when there is more', async () => {
    const userId = await person();
    const scope = await workspace.webScope(userId);
    await workspace.writeFile(scope, { path: '/Reports/Q4.md', content: '4' });
    await workspace.writeFile(scope, { path: '/reports_x.md', content: 'x' });
    await workspace.writeFile(scope, { path: '/repo%rt.md', content: '%' });
    for (let n = 0; n < resources.RESOURCE_COMPLETIONS + 2; n += 1) await workspace.writeFile(scope, { path: `/many/n${String(n).padStart(2, '0')}.md`, content: String(n) });
    const client = await connect(userId, { workspaceAccess: 'read' });
    const complete = (value: string) => client.complete({ ref: { type: 'ref/resource', uri: 're0://ws/{+path}' }, argument: { name: 'path', value } });

    /* Sorted by Postgres's collation; compared as a set. */
    expect([...(await complete('rep')).completion.values].sort()).toEqual(['Reports/', 'Reports/Q4.md', 'repo%rt.md', 'reports_x.md']);
    expect((await complete('reports/q')).completion.values).toEqual(['Reports/Q4.md']);
    expect((await complete('repo%')).completion.values).toEqual(['repo%rt.md']);
    expect((await complete('reports_')).completion.values).toEqual(['reports_x.md']);
    const many = await complete('many/');
    expect(many.completion.values).toHaveLength(resources.RESOURCE_COMPLETIONS);
    expect(many.completion.hasMore).toBe(true);
    /* Another template or argument gets nothing rather than an error. */
    expect((await client.complete({ ref: { type: 'ref/resource', uri: 're0://ws/{+path}' }, argument: { name: 'other', value: 'r' } })).completion.values).toEqual([]);
  });
});

describeWithDb('workspace resources: links in tool results', () => {
  it('ws_read and ws_list carry resource_link parts for the files they name', async () => {
    const userId = await person();
    const client = await connect(userId, { workspaceAccess: 'write' });
    await tool(client, 'ws_write', { path: '/l/one.md', content: '1' });
    await tool(client, 'ws_write', { path: '/l/two.csv', content: 'a,b' });
    await tool(client, 'ws_mkdir', { path: '/l/folder' });

    const read = await tool(client, 'ws_read', { path: '/l/one.md' });
    expect(read.content.filter((part) => part.type === 'resource_link')).toEqual([{ type: 'resource_link', uri: 're0://ws/l/one.md', name: 'one.md', title: '/l/one.md', mimeType: 'text/markdown', size: 1 }]);

    const listed = await tool(client, 'ws_list', { path: '/l' });
    expect(listed.content.filter((part) => part.type === 'resource_link').map((part) => part.uri)).toEqual(['re0://ws/l/one.md', 're0://ws/l/two.csv']);
    /* Every link reads back as a resource. */
    for (const part of listed.content.filter((p) => p.type === 'resource_link')) await client.readResource({ uri: part.uri! });

    await tool(client, 'ws_delete', { path: '/l/two.csv' });
    const trash = await tool(client, 'ws_list', { path: '/l', trash: true });
    expect(trash.content.some((part) => part.type === 'resource_link')).toBe(false);
  });
});

describe('workspace resources: URIs', () => {
  it('round-trips paths through URIs and refuses others', () => {
    for (const path of ['/a.md', '/a b/c#d?.md', '/中文/文件.txt', '/x%y.md']) {
      const uri = resources.resourceUri(path);
      expect(uri.startsWith('re0://ws/')).toBe(true);
      expect(uri.slice('re0://ws/'.length)).not.toMatch(/[ #?]/);
      expect(resources.resourcePath(uri)).toBe(path);
    }
    expect(resources.resourcePath('re0://ws/')).toBeNull();
    expect(resources.resourcePath('re0://other/a')).toBeNull();
    expect(resources.resourcePath('re0://ws/a?x=1')).toBeNull();
    expect(resources.resourcePath('re0://ws/%E0%A4%A')).toBeNull();
  });
});

describeWithDb('workspace resources: review fixes', () => {
  const code = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return { code: (error as { code?: number }).code, message: (error as Error).message };
    }
    throw new Error('expected a refusal');
  };

  it('sends text that would escape past 3 MB as base64, and escaping text whole otherwise', async () => {
    const userId = await person();
    const scope = await workspace.webScope(userId);
    const controls = '\u0001'.repeat(1_048_000);
    await workspace.writeFile(scope, { path: '/ansi.log', content: controls });
    const quotes = '"'.repeat(1_048_000);
    await workspace.writeFile(scope, { path: '/quotes.txt', content: quotes });
    const client = await connect(userId, { workspaceAccess: 'read' });

    const read = await client.readResource({ uri: 're0://ws/ansi.log' });
    const part = read.contents[0] as { blob?: string; text?: string };
    expect(part.text).toBeUndefined();
    expect(Buffer.from(part.blob!, 'base64').toString('utf8')).toBe(controls);
    /* What crosses the wire stays far below a function's 4.5 MB. */
    expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThan(1.5 * 1024 * 1024);

    const plain = (await client.readResource({ uri: 're0://ws/quotes.txt' })).contents[0] as { text?: string };
    expect(plain.text).toBe(quotes);
    expect(Buffer.byteLength(JSON.stringify(plain))).toBeLessThan(resources.RESOURCE_TEXT_JSON_MAX);
  });

  it('refuses a cursor it did not sign, or signed for another key’s root, as invalid params', async () => {
    const userId = await person();
    const scope = await workspace.webScope(userId);
    for (let n = 0; n < resources.RESOURCE_PAGE + 1; n += 1) await workspace.writeFile(scope, { path: `/p/f${n}.txt`, content: String(n) });
    const client = await connect(userId, { workspaceAccess: 'read' });
    const forged = Buffer.from(JSON.stringify({ t: 'not-a-time', i: '00000000-0000-0000-0000-000000000000', p: 1 })).toString('base64url');
    for (const cursor of [forged, `${forged}.AAAA`, `${forged}.${'A'.repeat(43)}`, 'a.b.c']) {
      expect(await code(client.listResources({ cursor }))).toMatchObject({ code: -32602, message: expect.stringMatching(/cursor/) });
    }
    /* A real cursor from the whole workspace does not carry over to a key limited to /p. */
    const real = (await resources.listResources(scope)).nextCursor!;
    expect(real).toBeTruthy();
    const narrow = await connect(userId, { kind: 'workspace', workspaceAccess: 'read', workspaceRoot: '/p' });
    expect(await code(narrow.listResources({ cursor: real }))).toMatchObject({ code: -32602 });
    expect((await client.listResources({ cursor: real })).resources.length).toBeGreaterThan(0);
    /* Writes 100+ files one by one: slow under the full suite's load. */
  }, 60_000);

  it('returns an image only when its bytes are that kind of image', async () => {
    const userId = await person();
    const scope = await workspace.webScope(userId);
    const encode = (text: string) => new TextEncoder().encode(text);
    await upload(scope, '/evil.png', encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
    await upload(scope, '/ok.gif', encode('GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;'));
    await upload(scope, '/ok.jpg', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 0xff, 0xd9]));
    await upload(scope, '/ok.webp', new Uint8Array([...encode('RIFF'), 4, 0, 0, 0, ...encode('WEBPVP8 '), 0, 0]));
    const client = await connect(userId, { workspaceAccess: 'read' });
    expect(await code(client.readResource({ uri: 're0://ws/evil.png' }))).toMatchObject({ code: -32602, message: expect.stringMatching(/not that kind of image/) });
    for (const [uri, type] of [['re0://ws/ok.gif', 'image/gif'], ['re0://ws/ok.jpg', 'image/jpeg'], ['re0://ws/ok.webp', 'image/webp']]) {
      expect((await client.readResource({ uri: uri! })).contents[0]).toMatchObject({ mimeType: type, blob: expect.any(String) });
    }
    expect(resources.imageMatches('image/png', PNG)).toBe(true);
    expect(resources.imageMatches('image/png', encode('GIF89a'))).toBe(false);
    expect(resources.imageMatches('image/svg+xml', encode('<svg/>'))).toBe(false);
  });

  it('lists and links only files a read returns: text and small images, not PDFs or big images', async () => {
    const userId = await person();
    const scope = await workspace.webScope(userId);
    await workspace.writeFile(scope, { path: '/mix/a.md', content: 'a' });
    await upload(scope, '/mix/small.png', PNG);
    await upload(scope, '/mix/big.png', Uint8Array.from({ length: resources.RESOURCE_IMAGE_MAX + 1 }, (_, n) => (n < PNG.length ? PNG[n]! : 1)));
    await upload(scope, '/mix/doc.pdf', new TextEncoder().encode('%PDF-1.4\n%%EOF\n'));
    const client = await connect(userId, { workspaceAccess: 'write' });

    const listed = (await client.listResources()).resources;
    expect(listed.map((resource) => resource.title).sort()).toEqual(['/mix/a.md', '/mix/small.png']);
    for (const resource of listed) {
      expect(resource.description).toBe(resources.RESOURCE_NOTE);
      await client.readResource({ uri: resource.uri });
    }
    const links = (await tool(client, 'ws_list', { path: '/mix' })).content.filter((part) => part.type === 'resource_link').map((part) => part.uri);
    expect(links).toEqual(['re0://ws/mix/a.md', 're0://ws/mix/small.png']);
    await tool(client, 'ws_delete', { path: '/mix/a.md' });
    expect((await tool(client, 'ws_list', { path: '/mix', trash: true })).content.filter((part) => part.type === 'resource_link')).toEqual([]);
  });

  it('stops working for a revoked key, an expired key and a disabled account', async () => {
    const userId = await person();
    await workspace.writeFile(await workspace.webScope(userId), { path: '/k.md', content: 'k' });

    const revoked = await connectWithKey(userId, { workspaceAccess: 'read' });
    expect((await revoked.client.listResources()).resources).toHaveLength(1);
    expect(await apiKeys.revokeApiKey(userId, revoked.keyId)).toBe(true);
    await expect(revoked.client.listResources()).rejects.toThrow();
    await expect(revoked.client.readResource({ uri: 're0://ws/k.md' })).rejects.toThrow();

    const expired = await connectWithKey(userId, { workspaceAccess: 'read' });
    await expired.client.readResource({ uri: 're0://ws/k.md' });
    await db().update(schema.apiKey).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.apiKey.id, expired.keyId));
    await expect(expired.client.readResource({ uri: 're0://ws/k.md' })).rejects.toThrow();

    const disabled = await connectWithKey(userId, { workspaceAccess: 'read' });
    await disabled.client.complete({ ref: { type: 'ref/resource', uri: 're0://ws/{+path}' }, argument: { name: 'path', value: 'k' } });
    await db().update(schema.user).set({ disabledAt: new Date() }).where(eq(schema.user.id, userId));
    try {
      await expect(disabled.client.complete({ ref: { type: 'ref/resource', uri: 're0://ws/{+path}' }, argument: { name: 'path', value: 'k' } })).rejects.toThrow();
    } finally {
      await db().update(schema.user).set({ disabledAt: null }).where(eq(schema.user.id, userId));
    }
  });

  it('completes nothing from a sibling folder that shares the root’s prefix, and treats the root case-insensitively', async () => {
    const userId = await person();
    const scope = await workspace.webScope(userId);
    await workspace.writeFile(scope, { path: '/proj/in.md', content: 'in' });
    await workspace.writeFile(scope, { path: '/projX/out.md', content: 'out' });
    await workspace.writeFile(scope, { path: '/proj-old/out.md', content: 'out' });
    for (const root of ['/proj', '/PROJ']) {
      const client = await connect(userId, { kind: 'workspace', workspaceAccess: 'read', workspaceRoot: root });
      const complete = async (value: string) => (await client.complete({ ref: { type: 'ref/resource', uri: 're0://ws/{+path}' }, argument: { name: 'path', value } })).completion.values;
      expect(await complete('')).toEqual(['in.md']);
      expect(await complete('X')).toEqual([]);
      expect(await complete('-old')).toEqual([]);
      expect(await complete('../projX/')).toEqual([]);
      expect((await client.listResources()).resources.map((resource) => resource.title)).toEqual(['/in.md']);
    }
  });

  it('lists and completes through their indexes (recent files; lower(path) text_pattern_ops)', async () => {
    const userId = await person();
    const scope = await workspace.webScope(userId);
    await workspace.writeFile(scope, { path: '/idx/a.md', content: 'a' });
    /* With sequential scans (and sorts) off, a query an index can serve shows that index; on a tiny table the planner would otherwise pick anything. */
    const plan = (query: ReturnType<typeof sql>) =>
      db().transaction(async (tx) => {
        await tx.execute(sql`set local enable_seqscan = off`);
        await tx.execute(sql`set local enable_sort = off`);
        const rows = (await tx.execute(sql`explain ${query}`)) as unknown as { rows?: { 'QUERY PLAN': string }[] } & { 'QUERY PLAN': string }[];
        return (rows.rows ?? rows).map((row) => row['QUERY PLAN']).join('\n');
      });
    const list = await plan(
      sql`select id from agent_workspace_entry where workspace_id = ${scope.workspaceId} and deleted_at is null and kind = 'file' and (updated_at, id) < (now(), '00000000-0000-0000-0000-000000000000'::uuid) order by updated_at desc, id desc limit 101`,
    );
    expect(list).toContain('agent_workspace_entry_recent_idx');
    expect(list).not.toMatch(/Sort/);
    const complete = await plan(
      sql`select path from agent_workspace_entry where workspace_id = ${scope.workspaceId} and deleted_at is null and lower(path) ~>=~ lower(${'/idx/a'}) and lower(path) ~<~ (lower(${'/idx/a'}) || chr(1114111)) limit 21`,
    );
    expect(complete).toContain('agent_workspace_entry_prefix_idx');
    expect(complete).toMatch(/Index Cond: .*~>=~/);
  });

  it('pins that nothing else may set the resource or completion handlers on these servers', () => {
    /* lib/http/mcp-resources.ts sets resources/* and completion/complete itself: the SDK's own helpers would throw on top of it. */
    const server = new McpServer({ name: 't', version: '1' });
    registerWorkspaceResources(server as never);
    expect(() => server.registerResource('static', 're0://other', {}, async (uri) => ({ contents: [{ uri: uri.href, text: '' }] }))).toThrow(/already/i);
    const prompted = new McpServer({ name: 't', version: '1' });
    registerWorkspaceResources(prompted as never);
    expect(() => prompted.registerPrompt('p', { argsSchema: z.object({ x: completable(z.string(), () => []) }) }, async () => ({ messages: [] }))).toThrow(/already/i);
  });
});
