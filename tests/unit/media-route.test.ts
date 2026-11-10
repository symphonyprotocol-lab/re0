import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/media/[...path]/route';
import { assertBlobPathname, streamBlob } from '@/lib/infra/blob';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

/**
 * `get` builds its URL exactly as @vercel/blob 2.8 does (`constructBlobUrl`:
 * the pathname pasted raw after the store host) and records the path the
 * fetch would actually request once URL parsing has normalised it.
 */
const net = vi.hoisted(() => ({ fetched: [] as string[], contentType: 'image/webp' }));
const fetched = net.fetched;
vi.mock('@vercel/blob', async (original) => ({
  ...(await original<typeof import('@vercel/blob')>()),
  get: async (pathname: string) => {
    net.fetched.push(new URL(`https://teststore.private.blob.vercel-storage.com/${pathname}`).pathname);
    return { statusCode: 200, stream: new Response('bytes').body, headers: new Headers(), blob: { contentType: net.contentType } };
  },
}));

const user = '6f1c3a52-6c55-4a8e-9d0e-2f6ad0c1a111';
const file = '0c8f4f43-1f0a-4cf5-9f44-8a4c7bd5e222';
const reeId = '1d2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';

beforeEach(() => {
  fetched.length = 0;
  net.contentType = 'image/webp';
  vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'vercel_blob_rw_teststore_secret');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function get(...segments: string[]) {
  return GET(new NextRequest(`http://localhost:3000/media/${segments.map(encodeURIComponent).join('/')}`), {
    params: Promise.resolve({ path: segments }),
  });
}

describe('/media avatars', () => {
  it('serves an avatar at the shape the uploader writes', async () => {
    const response = await get('avatars', user, `${file}.webp`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(fetched).toEqual([`/avatars/${user}/${file}.webp`]);
  });

  it('refuses an encoded traversal into another prefix before reaching the store', async () => {
    /* `/media/avatars/%252e%252e/videos%2F…` arrives decoded once as these segments. */
    const response = await get('avatars', '%2e%2e', `videos/${reeId}/${file}.mp4`);
    expect(response.status).toBe(404);
    expect(fetched).toEqual([]);
  });

  it('refuses anything but the uploader’s shape', async () => {
    for (const segments of [
      ['avatars', user, `${file}.mp4`],
      ['avatars', 'not-a-uuid', `${file}.png`],
      ['avatars', user, `${file}.png?x`],
      ['avatars', user, `${file}.png#x`],
      ['avatars', user, `..\\${file}.png`],
      ['avatars', user, `${file}%2epng`],
    ]) {
      expect((await get(...segments)).status).toBe(404);
    }
    expect(fetched).toEqual([]);
  });

  it('serves only image content types', async () => {
    net.contentType = 'text/html';
    expect((await get('avatars', user, `${file}.png`)).status).toBe(404);
  });

  it('refuses a percent sign in any branch', async () => {
    expect((await get('videos', reeId, `${file}%2e.mp4`)).status).toBe(404);
    expect((await get('ree-covers', reeId, `${file}%2e.png`)).status).toBe(404);
    expect(fetched).toEqual([]);
  });
});

describe('blob pathname guard', () => {
  it('rejects traversal and URL syntax for every caller', async () => {
    for (const pathname of ['a/../b', 'a/%2e%2e/b', 'a/%2F/b', 'a//b', '/a', 'a\\b', 'a?b', 'a#b', 'https://x.test/a', 'a/./b', '']) {
      expect(() => assertBlobPathname(pathname), pathname).toThrow();
    }
    await expect(streamBlob('avatars/%2e%2e/videos/x.mp4')).rejects.toThrow();
    expect(fetched).toEqual([]);
    expect(() => assertBlobPathname(`knowledge/${user}/${file}/报告 (1).pdf`)).not.toThrow();
    /* A literal % that decodes to nothing (a file named "100%.pdf") stays readable. */
    expect(() => assertBlobPathname(`knowledge/${user}/${file}/100%.pdf`)).not.toThrow();
  });
});

describe('stored avatar pathnames', () => {
  it('only the uploader’s shape becomes a /media URL', async () => {
    const { avatarImageUrl, isAvatarPath } = await import('@/lib/domain/ree');
    expect(isAvatarPath(`avatars/${user}/${file}.png`, user)).toBe(true);
    expect(isAvatarPath(`avatars/${user}/${file}.png`, reeId)).toBe(false);
    expect(avatarImageUrl(`avatars/${user}/${file}.png`)).toBe(`/media/avatars/${user}/${file}.png`);
    expect(avatarImageUrl(`avatars/${user}/../../api/account`)).toBeNull();
    expect(avatarImageUrl('https://avatars.githubusercontent.com/u/1')).toBe('https://avatars.githubusercontent.com/u/1');
  });
});
