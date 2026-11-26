import type { Metadata } from 'next';
import { cache } from 'react';
import { after } from 'next/server';
import { appBaseUrl } from '@/lib/http/cookies';
import { countPageView, publicFile as lookup } from '@/lib/services/workspace-publish';
import { serverMessages } from '@/i18n/server';
import { fill, formatBytes, formatDate } from '@/i18n/format';
import { BrandMark } from '@/components/ui/brand-mark';
import { LanguageMenu } from '@/components/ui/language-menu';
import { Icon } from '@/components/ui/icons';
import { CopyLink, ReportForm } from '@/components/files/publish-ui';
import '@/components/files/publish.css';

export const dynamic = 'force-dynamic';

/** Metadata and the page share one lookup per request. */
const publicFile = cache(lookup);

type Props = { params: Promise<{ id: string }> };

/** Not indexed unless its owner allowed it; never for an unavailable one. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const file = await publicFile((await params).id);
  if (!file || file.availability !== 'live') return { title: { absolute: 'RE0' }, robots: { index: false, follow: false } };
  return {
    title: file.title,
    robots: file.indexable ? { index: true, follow: false } : { index: false, follow: false },
    openGraph: { type: 'website', title: file.title, url: `${appBaseUrl()}/f/${file.publicId}`, siteName: 'RE0' },
  };
}

/**
 * `/f/[id]`: a published original (docs/design/agent-workspace-p4.md §2.5) --
 * RE0's own template, the owner sets only the title. What the file is, who
 * published it and when, its sha256, a text or image preview, the download
 * (always an attachment), the public Rees that cite it, and a report form
 * for anyone. Rendered for every request, so a revoked or suspended file is
 * gone at once; an id that never existed and a revoked one look the same.
 */
export default async function PublicFilePage({ params }: Props) {
  const { id } = await params;
  const [file, { t, locale }] = await Promise.all([publicFile(id), serverMessages()]);
  const p = t.publish.page;
  const top = (
    <div className="publish-top">
      <BrandMark size={30} />
      <LanguageMenu />
    </div>
  );
  if (!file || file.availability !== 'live') {
    const [title, body] = !file ? [p.goneTitle, p.goneBody] : file.availability === 'daily_limit' ? [p.dailyLimit, p.dailyLimitBody] : [p.unavailable, p.unavailableBody];
    return (
      <main className="publish-page">
        <div className="publish-page-inner">
          {top}
          <section className="card publish-gone">
            <h1>{title}</h1>
            <p>{body}</p>
          </section>
        </div>
      </main>
    );
  }
  after(() => countPageView(file.publicId).catch(() => undefined));
  const url = `${appBaseUrl()}/f/${file.publicId}`;
  const raw = `/f/${file.publicId}/raw`;
  const type = file.fileName.includes('.') ? file.fileName.slice(file.fileName.lastIndexOf('.') + 1).toUpperCase() : file.mediaType;
  return (
    <main className="publish-page">
      <div className="publish-page-inner">
        {top}
        <section className="card publish-main">
          <div className="publish-head">
            <span className="publish-icon">
              <Icon name={file.image ? 'image' : 'file'} />
            </span>
            <div>
              <p className="eyebrow">{p.eyebrow}</p>
              <h1>{file.title}</h1>
              <p className="publish-meta">{fill(p.meta, { name: file.fileName, type, size: formatBytes(file.size) })}</p>
            </div>
          </div>
          <div className="publish-by">
            <Icon name="user" />
            <span>{fill(p.by, { name: file.owner.name, date: formatDate(file.publishedAt, locale) })}</span>
          </div>
          <div className="publish-cta">
            <a className="btn" href={raw} rel="nofollow">
              <Icon name="download" />
              {p.download}
            </a>
            <CopyLink url={url} />
          </div>
          {file.image ? (
            <div className="publish-preview">
              {/* eslint-disable-next-line @next/next/no-img-element -- the pinned bytes, served as an attachment: next/image would fetch and cache them elsewhere */}
              <img src={raw} alt={fill(p.imageAlt, { name: file.fileName })} />
            </div>
          ) : (
            file.preview && (
              <div className="publish-preview">
                <div className="publish-preview-head">
                  <strong>{p.preview}</strong>
                  <span>{p.previewNote}</span>
                </div>
                <pre>{file.preview}</pre>
              </div>
            )
          )}
          <dl className="publish-facts">
            <div>
              <dt>{p.facts.sha}</dt>
              <dd className="mono">{file.sha256}</dd>
            </div>
            <div>
              <dt>{p.facts.version}</dt>
              <dd>{fill(p.versionAt, { date: formatDate(file.versionAt, locale) })}</dd>
            </div>
            <div>
              <dt>{p.facts.download}</dt>
              <dd>{p.attachment}</dd>
            </div>
          </dl>
        </section>
        {file.rees.map((ree) => (
          <section key={ree.slug} className="card publish-ree">
            <span className="publish-icon">
              <Icon name="chat" />
            </span>
            <div className="grow">
              <strong>{fill(p.citedBy, { ree: ree.name })}</strong>
              <small>{p.citedHint}</small>
            </div>
            <a className="btn-secondary" href={`/s/${ree.slug}`}>
              {p.ask}
            </a>
          </section>
        ))}
        <p className="publish-fine">
          <Icon name="info" />
          <span>{p.fine}</span>
          <ReportForm publicId={file.publicId} />
        </p>
      </div>
    </main>
  );
}
