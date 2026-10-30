import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { DocumentText } from '@/components/document-text';
import { ConsoleButton, ConsolePageHeader, Panel, Pill } from '@/components/admin/ui';
import { ChevronLeftIcon } from '@/components/ui/icons';
import { readReviewDocument } from '@/lib/application/administration';
import { requireAdminCapability } from '@/lib/http/admin';
import { clientAddress } from '@/lib/http/client-address';
import { fill } from '@/lib/i18n/format';
import { getMessages } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).admin.assets.detail.documentPage.metaTitle };
}

/**
 * One document of a public user asset, as its chunks: what a caller would
 * be served from it, for the reviewer to read (review-visibility-proposal.md
 * 4.1). The read is an audit entry, written by the use case. A document of a
 * private or a platform asset is a 404 here, whatever its id.
 */
export default async function ReviewDocumentPage({
  params,
}: {
  params: Promise<{ assetId: string; documentId: string }>;
}) {
  const [session, { assetId, documentId }, t] = await Promise.all([
    requireAdminCapability('assets'),
    params,
    getMessages(),
  ]);
  const document = await readReviewDocument({
    actor: { administratorId: session.administratorId, email: session.email, clientAddress: clientAddress(await headers()) },
    assetId,
    documentId,
  });
  if (!document) notFound();
  const d = t.admin.assets.detail.documentPage;
  const findings = t.admin.assets.detail.safety.findings;
  const tokens = document.chunks.reduce((sum, chunk) => sum + chunk.tokens, 0);

  return (
    <div className="flex flex-col gap-[18px]">
      <ConsolePageHeader
        eyebrow={d.eyebrow}
        title={document.title}
        description={fill(d.chunks, { n: document.chunks.length, tokens })}
        action={
          <ConsoleButton href={`/admin/assets/${assetId}#documents`}>
            <ChevronLeftIcon size={14} />
            {d.back}
          </ConsoleButton>
        }
      />
      <Panel className="flex flex-col gap-2 px-[19px] py-4">
        <p className="text-[12px] tracking-[-0.023em] text-muted">
          {d.source}:{' '}
          <a href={document.sourceUrl} target="_blank" rel="noreferrer" className="break-all text-brandink hover:text-brand">
            {document.sourceUrl}
          </a>
        </p>
        {document.safetyFindings.length > 0 ? (
          <p className="flex flex-wrap items-center gap-1.5 text-[12px] tracking-[-0.023em] text-muted">
            {d.findings}:
            {document.safetyFindings.map((finding) => (
              <Pill key={finding} tone="warn">
                {findings[finding] ?? finding}
              </Pill>
            ))}
          </p>
        ) : null}
        <p className="text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">{d.auditNote}</p>
      </Panel>
      <DocumentText chunks={document.chunks} chunkLabel={d.chunk} />
    </div>
  );
}
