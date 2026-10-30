import type { Metadata } from 'next';
import { BackLink } from '@/components/dashboard/ui';
import { notFound } from 'next/navigation';
import { AssetFiles } from '@/components/dashboard/asset-files';
import { canManageAssets, assetFiles } from '@/lib/application/assets';
import { requireSession } from '@/lib/http/session';
import { fill } from '@/lib/i18n/format';
import { getMessages } from '@/lib/i18n/server';
import { prepareUploadAction } from '../../new/actions';
import { updateAssetFilesAction } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.assetFiles.metaTitle };
}

/**
 * The files of one upload asset -- PDFs or Markdown/MDX. An asset this
 * workspace does not own, or one
 * that is not built from uploads, is a 404 -- the same answer as one that
 * does not exist, so nothing is confirmed about anyone else's.
 */
export default async function DashboardAssetFilesPage({
  params,
}: {
  params: Promise<{ assetId: string }>;
}) {
  const { assetId } = await params;
  const [session, t] = await Promise.all([
    requireSession(`/dashboard/assets/${assetId}/files`),
    getMessages(),
  ]);
  const view = await assetFiles({ workspaceId: session.workspace.id, assetId });
  if (!view) notFound();
  const f = t.dashboard.assetFiles;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-5">
        <div className="flex flex-col gap-[5px]">
          <BackLink href="/dashboard/assets">{f.back}</BackLink>
          <h1 className="mt-1.5 text-[25px] leading-[1.5] font-medium text-ink">
            {view.kind === 'markdown' ? f.markdown.title : f.title}
          </h1>
          <p className="text-[13px] leading-[1.5] text-muted">
            {fill(f.description, { title: view.asset.title })}
          </p>
          <p className="text-[11px] text-muted">{view.asset.publicId}</p>
        </div>
      </header>

      <AssetFiles
        assetId={view.asset.id}
        files={view.files}
        kind={view.kind}
        building={view.building}
        canEdit={canManageAssets(session.workspace.role)}
        action={updateAssetFilesAction}
        prepare={prepareUploadAction}
      />
    </div>
  );
}
