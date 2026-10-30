import { describe, expect, it } from 'vitest';
import { en } from '@/lib/i18n/messages/en';
import { zh } from '@/lib/i18n/messages/zh';
import {
  draftPlatformAsset,
  isPlatformAssetType,
  isPlatformSourceType,
  normalizeLocation,
  parseUploadManifest,
  PLATFORM_ASSET_TYPES,
  PLATFORM_SOURCE_TYPES,
  PLATFORM_UPLOAD_OWNER,
  PlatformAssetRefused,
  uploadKey,
  uploadPrefix,
} from '@/lib/domain/asset';

const BATCH = '01a07497-0000-7000-8000-000000000001';
const FILE = '01a07497-0000-7000-8000-000000000002';

const PDF = {
  title: 'Employee Handbook',
  publicId: '/docs/handbook',
  sourceType: 'pdf',
  location: 'ignored',
  refreshPolicy: 'daily',
  uploads: { batchId: BATCH, files: [{ id: FILE, name: 'handbook.pdf', size: 1234 }] },
};

function refusal(input: Parameters<typeof draftPlatformAsset>[0]): string {
  try {
    draftPlatformAsset(input);
    return 'accepted';
  } catch (error) {
    return error instanceof PlatformAssetRefused ? error.code : 'unexpected';
  }
}

describe('a platform pdf asset', () => {
  it('is an asset type but not a typed-location source type', () => {
    expect([...PLATFORM_ASSET_TYPES]).toEqual([...PLATFORM_SOURCE_TYPES, 'pdf']);
    expect(isPlatformAssetType('pdf')).toBe(true);
    expect(isPlatformSourceType('pdf')).toBe(false);
    expect(isPlatformAssetType('markdown')).toBe(false);
  });

  it('keys its uploads under the platform owner, which no workspace id can be', () => {
    expect(PLATFORM_UPLOAD_OWNER).toBe('platform');
    expect(uploadPrefix(PLATFORM_UPLOAD_OWNER, BATCH)).toBe(`uploads/platform/${BATCH}`);
    expect(uploadKey(PLATFORM_UPLOAD_OWNER, BATCH, FILE)).toBe(`uploads/platform/${BATCH}/${FILE}.pdf`);
    expect(normalizeLocation('pdf', `uploads/platform/${BATCH}`)).toBe(`uploads/platform/${BATCH}`);
    expect(normalizeLocation('pdf', `uploads/staff/${BATCH}`)).toBeNull();
  });

  it('derives location and cadence from the manifest rather than the form', () => {
    const draft = draftPlatformAsset(PDF);
    expect(draft.sourceType).toBe('pdf');
    expect(draft.publicId).toBe('/docs/handbook');
    expect(draft.location).toBe(`uploads/platform/${BATCH}`);
    expect(draft.refreshPolicy).toBe('manual');
    expect(draft.files).toEqual([
      { id: FILE, name: 'handbook.pdf', size: 1234, key: `uploads/platform/${BATCH}/${FILE}.pdf` },
    ]);
  });

  it('may be created empty, with a fresh batch of its own', () => {
    const draft = draftPlatformAsset({ ...PDF, uploads: undefined });
    expect(draft.files).toEqual([]);
    expect(draft.location).toMatch(/^uploads\/platform\/[0-9a-f-]{36}$/);
  });

  it('refuses a manifest it cannot trust, and an id outside /docs', () => {
    expect(refusal({ ...PDF, uploads: { batchId: 'nope', files: [] } })).toBe('invalid_uploads');
    expect(refusal({ ...PDF, uploads: { batchId: BATCH, files: [{ id: FILE, name: 'x.pdf', size: 0 }] } })).toBe('invalid_uploads');
    expect(refusal({ ...PDF, publicId: '/websites/handbook' })).toBe('invalid_public_id');
    /* A workspace manifest parsed under the platform owner keys under platform: the owner is the caller's. */
    expect(parseUploadManifest(PDF.uploads, PLATFORM_UPLOAD_OWNER)?.files[0]?.key).toContain('uploads/platform/');
  });

  it('has words for the new refusals and the files panel in both languages', () => {
    for (const code of ['invalid_uploads', 'nothing_to_change'] as const) {
      expect(en.admin.platformAssets.errors[code]).toBeTruthy();
      expect(zh.admin.platformAssets.errors[code]).toBeTruthy();
    }
    expect(en.admin.audit.actions['platform_library.files']).toBeTruthy();
    expect(zh.admin.audit.actions['platform_library.files']).toBeTruthy();
    expect(en.admin.platformAssetDetail.files.save).toBeTruthy();
    expect(zh.admin.platformAssetDetail.files.save).toBeTruthy();
  });
});

describe('a pdf source added to an existing asset', () => {
  it('is drafted from its manifest, manual, with the platform prefix as its location', async () => {
    const { draftPlatformSource } = await import('@/lib/domain/asset');
    const draft = draftPlatformSource({ type: 'pdf', location: '', refreshPolicy: 'daily', uploads: PDF.uploads });
    expect(draft.type).toBe('pdf');
    expect(draft.refreshPolicy).toBe('manual');
    expect(draft.location).toBe(`uploads/platform/${BATCH}`);
    expect(draft.files.map((file) => file.id)).toEqual([FILE]);
    expect(draftPlatformSource({ type: 'website', location: 'https://x.test/docs', refreshPolicy: 'daily' }).files).toEqual([]);
    expect(() => draftPlatformSource({ type: 'pdf', location: '', refreshPolicy: 'manual', uploads: { batchId: 'x' } })).toThrow(PlatformAssetRefused);
    expect(en.admin.platformAssets.errors.pdf_source_exists).toBeTruthy();
    expect(zh.admin.platformAssets.errors.pdf_source_exists).toBeTruthy();
  });
});
