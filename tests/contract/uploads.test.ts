/**
 * The rules around uploaded PDFs: which manifests a create request may post
 * (requirement.md 6.1 reserves `/docs/slug` for uploads; architecture.md 7
 * keeps user input out of object keys), and what `prepareUploads` hands back.
 */
import { describe, expect, it } from 'vitest';
import { memoryObjectStore } from '@/lib/application/ingestion';
import { prepareUploads } from '@/lib/application/assets';
import {
  normalizeLocation,
  normalizePublicId,
  parseUploadManifest,
  uploadFileName,
  uploadKey,
  UPLOAD_LIMITS,
} from '@/lib/domain/asset';

const WS = '018f0000-0000-7000-8000-000000000001';
const BATCH = '018f0000-0000-7000-8000-000000000002';
const FILE = '018f0000-0000-7000-8000-000000000003';

describe('upload manifest', () => {
  it('accepts a manifest and roots every key in the workspace', () => {
    const parsed = parseUploadManifest(
      { batchId: BATCH, files: [{ id: FILE, name: 'Handbook', size: 1234 }] },
      WS,
    );
    expect(parsed).toEqual({
      batchId: BATCH,
      files: [{ id: FILE, name: 'Handbook.pdf', size: 1234, key: uploadKey(WS, BATCH, FILE) }],
    });
    expect(parsed?.files[0]?.key).toBe(`uploads/${WS}/${BATCH}/${FILE}.pdf`);
  });

  it('refuses ids that are not uuids, so a key can never be steered', () => {
    expect(parseUploadManifest({ batchId: '../other', files: [{ id: FILE, name: 'a', size: 1 }] }, WS)).toBeNull();
    expect(parseUploadManifest({ batchId: BATCH, files: [{ id: 'x/y', name: 'a', size: 1 }] }, WS)).toBeNull();
  });

  it('accepts an empty manifest: a PDF asset may be created before its files', () => {
    expect(parseUploadManifest({ batchId: BATCH, files: [] }, WS)).toEqual({ batchId: BATCH, files: [] });
  });

  it('refuses oversized and over-long manifests', () => {
    expect(
      parseUploadManifest(
        { batchId: BATCH, files: [{ id: FILE, name: 'a', size: UPLOAD_LIMITS.maxFileBytes + 1 }] },
        WS,
      ),
    ).toBeNull();
    const many = Array.from({ length: UPLOAD_LIMITS.maxFiles + 1 }, (_, i) => ({
      id: `018f0000-0000-7000-8000-${String(i).padStart(12, '0')}`,
      name: 'a',
      size: 1,
    }));
    expect(parseUploadManifest({ batchId: BATCH, files: many }, WS)).toBeNull();
  });

  it('keeps a shown name to its base name and gives it the extension', () => {
    expect(uploadFileName('C:\\docs\\Manual v2.PDF')).toBe('Manual v2.PDF');
    expect(uploadFileName('../../etc/passwd')).toBe('passwd.pdf');
    expect(uploadFileName('  ')).toBeNull();
  });

  it('publishes a pdf source under /docs and locates it at its upload prefix', () => {
    expect(normalizePublicId('pdf', '/docs/handbook')).toBe('/docs/handbook');
    expect(normalizeLocation('pdf', `uploads/${WS}/${BATCH}`)).toBe(`uploads/${WS}/${BATCH}`);
    expect(normalizeLocation('pdf', 'https://example.com/a.pdf')).toBeNull();
  });
});

describe('prepareUploads', () => {
  it('mints one presigned PUT per file inside the workspace prefix', async () => {
    const result = await prepareUploads({
      workspaceId: WS,
      role: 'owner',
      files: [
        { name: 'a.pdf', size: 10 },
        { name: 'b', size: 20 },
      ],
      store: memoryObjectStore(),
    });
    expect(result.files).toHaveLength(2);
    expect(result.files[1]?.name).toBe('b.pdf');
    for (const file of result.files) {
      expect(file.ticket).toEqual({
        kind: 'put',
        url: `memory://uploads/${WS}/${result.batchId}/${file.id}.pdf?upload`,
      });
    }
  });

  it('joins an existing batch when asked', async () => {
    const result = await prepareUploads({
      workspaceId: WS,
      role: 'admin',
      files: [{ name: 'a.pdf', size: 10 }],
      batchId: BATCH,
      store: memoryObjectStore(),
    });
    expect(result.batchId).toBe(BATCH);
  });

  it('refuses a viewer, an oversized file and an empty pick', async () => {
    const store = memoryObjectStore();
    await expect(
      prepareUploads({ workspaceId: WS, role: 'viewer', files: [{ name: 'a.pdf', size: 1 }], store }),
    ).rejects.toMatchObject({ code: 'access_denied' });
    await expect(
      prepareUploads({
        workspaceId: WS,
        role: 'owner',
        files: [{ name: 'a.pdf', size: UPLOAD_LIMITS.maxFileBytes + 1 }],
        store,
      }),
    ).rejects.toMatchObject({ code: 'library_size_exceeded' });
    await expect(prepareUploads({ workspaceId: WS, role: 'owner', files: [], store })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});
