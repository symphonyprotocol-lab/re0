import type { Metadata } from 'next';
import { BackLink } from '@/components/dashboard/ui';
import { notFound } from 'next/navigation';
import { DocumentText } from '@/components/document-text';
import { documentPreview, workspaceAssetDetail } from '@/lib/application/assets';
import { requireSession } from '@/lib/http/session';
import { fill } from '@/lib/i18n/format';
import { getMessages } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.assetDetail.documentPreview.metaTitle };
}

/** One indexed document of the owner's own asset, as its chunks. */
export default async function DashboardDocumentPreviewPage({
  params,
}: {
  params: Promise<{ assetId: string; documentId: string }>;
}) {
  const { assetId, documentId } = await params;
  const [session, t] = await Promise.all([
    requireSession(`/dashboard/assets/${assetId}/documents/${documentId}`),
    getMessages(),
  ]);
  const asset = await workspaceAssetDetail({ workspaceId: session.workspace.id, assetId });
  if (!asset) notFound();
  const document = await documentPreview({ assetId: asset.id, documentId });
  if (!document) notFound();
  const d = t.dashboard.assetDetail.documentPreview;
  const tokens = document.chunks.reduce((sum, chunk) => sum + chunk.tokens, 0);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-[5px]">
        <BackLink href={`/dashboard/assets/${asset.id}`}>{d.back}</BackLink>
        <h1 className="mt-1.5 text-[22px] leading-[1.4] font-medium text-ink">
          {document.title}
        </h1>
        <p className="text-[12px] text-muted">
          {fill(d.chunks, { n: document.chunks.length, tokens })} · {d.source}:{' '}
          <a href={document.sourceUrl} target="_blank" rel="noreferrer" className="break-all text-brandink hover:text-brandink">
            {document.sourceUrl}
          </a>
        </p>
      </header>
      <DocumentText chunks={document.chunks} chunkLabel={d.chunk} />
    </div>
  );
}
