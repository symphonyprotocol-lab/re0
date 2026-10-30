/**
 * The redirect behind both platform-file routes: the public one, which only
 * serves published assets, and the console's, which serves drafts too.
 * `lib/infrastructure/connectors/pdf.ts` cites the public route; the object
 * key is not a URL anyone can open, so the file is found by its own id in
 * the `pdf` source that lists it and handed out as a short-lived signed URL
 * (architecture.md 7).
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { uploadedFilesOf } from '@/lib/domain/asset';
import { isObjectStoreConfigured, objectStore } from '@/lib/infrastructure/objects/store';
import { db, schema } from '@/lib/infrastructure/postgres/client';

const DOWNLOAD_TTL_SECONDS = 300;

export async function platformFileRedirect(
  fileId: string,
  options: { includeUnpublished: boolean },
): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/.test(fileId)) return new NextResponse(null, { status: 404 });

  const [row] = await db()
    .select({ config: schema.source.config })
    .from(schema.source)
    .innerJoin(schema.asset, eq(schema.asset.id, schema.source.assetId))
    .where(
      and(
        eq(schema.source.type, 'pdf'),
        eq(schema.asset.isPlatformAsset, true),
        isNull(schema.asset.deletedAt),
        options.includeUnpublished ? undefined : eq(schema.asset.lifecycleStatus, 'published'),
        sql`${schema.source.config} @> ${JSON.stringify({ files: [{ id: fileId }] })}::jsonb`,
      ),
    )
    .limit(1);

  const file = row ? uploadedFilesOf(row.config).find((entry) => entry.id === fileId) : undefined;
  if (!file) return new NextResponse(null, { status: 404 });
  if (!isObjectStoreConfigured()) return new NextResponse(null, { status: 503 });

  return NextResponse.redirect(await objectStore().signedUrl(file.key, DOWNLOAD_TTL_SECONDS), {
    status: 302,
    headers: { 'cache-control': 'no-store' },
  });
}
