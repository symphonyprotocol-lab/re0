/**
 * Downloads larger than a function may answer (4.5 MB on Vercel): a redirect
 * to a URL the store signs for that one object, never the bytes through the
 * function; smaller files still stream through as an attachment. The store's
 * signing is stubbed (the local folder has none; production Blob is not
 * used in tests).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { TEST_DATABASE_URL, uniqueName } from './setup';

const blobDir = mkdtempSync(join(tmpdir(), 're0-ws-download-'));
process.env.WORKSPACE_BLOB_DIR = blobDir;
const signedFor = vi.hoisted(() => [] as { pathname: string; ms: number }[]);
vi.mock('@/lib/infra/workspace-store', async (original) => ({
  ...(await original<typeof import('@/lib/infra/workspace-store')>()),
  signedObjectUrl: async (pathname: string, ms: number) => {
    signedFor.push({ pathname, ms });
    return `https://store.example/${pathname}?signed=1&download=1`;
  },
}));

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
const { createSession } = await import('@/lib/services/auth');
const workspace = await import('@/lib/services/workspace');
const uploads = await import('@/lib/services/workspace-upload');
const { WORKSPACE_DOWNLOAD_INLINE_MAX, WORKSPACE_UPLOAD_PART } = await import('@/lib/constants');

afterAll(() => rmSync(blobDir, { recursive: true, force: true }));

async function owner() {
  const subject = uniqueName('wsd');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: subject, avatarUrl: null }, 'en', '/');
  return workspace.webScope(userId);
}

async function upload(scope: Awaited<ReturnType<typeof owner>>, path: string, bytes: Uint8Array) {
  const ticket = await uploads.createUpload(scope, { path, size: bytes.length });
  const token = ticket.url.split('/').pop()!;
  let result;
  for (let n = 1; n <= ticket.parts; n += 1) {
    const part = bytes.slice((n - 1) * WORKSPACE_UPLOAD_PART, n * WORKSPACE_UPLOAD_PART);
    result = await uploads.receivePart(token, { part: ticket.parts === 1 ? null : String(n), contentLength: String(part.length), body: new Response(Buffer.from(part)).body });
  }
  return result!;
}

describeWithDb('large downloads', () => {
  it('redirects past the inline limit to a store URL signed for that object, and streams smaller files', async () => {
    const scope = await owner();
    const big = new Uint8Array(WORKSPACE_DOWNLOAD_INLINE_MAX + 1).fill(7);
    big[0] = 0;
    expect(await upload(scope, '/big.bin', big)).toMatchObject({ done: true });
    const link = await uploads.downloadUrl(scope, { path: '/big.bin' });
    const response = await uploads.openDownload(link.url.split('/').pop()!);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toMatch(/^https:\/\/store\.example\/workspace\/.+\?signed=1&download=1$/);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(signedFor.at(-1)).toMatchObject({ ms: 60_000 });
    expect(signedFor.at(-1)!.pathname).toMatch(new RegExp(`^workspace/${scope.workspaceId}/[0-9a-f]{64}$`));

    const small = new Uint8Array(2_000).fill(1);
    small[0] = 0;
    await upload(scope, '/small.bin', small);
    const streamed = await uploads.openDownload((await uploads.downloadUrl(scope, { path: '/small.bin' })).url.split('/').pop()!);
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get('content-disposition')).toMatch(/^attachment/);
    expect((await streamed.arrayBuffer()).byteLength).toBe(2_000);
  });
});
