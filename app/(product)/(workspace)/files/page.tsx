import type { Metadata } from 'next';
import { currentUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { serverMessages } from '@/i18n/server';
import type { Messages } from '@/i18n';
import { fill, formatBytes, formatDateTime } from '@/i18n/format';
import { nameOf, normalizePath, parentOf } from '@/lib/domain/workspace';
import { fileHistory, fileText, folderPaths, kindAt, listEntries, webScope, type WorkspaceScope } from '@/lib/services/workspace';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { Icon } from '@/components/ui/icons';
import { CopyButton, RestoreVersionButton, TrashButton } from '@/components/files/file-actions';
import { CreateReeButton } from '@/components/files/workspace-ui';
import { reesUsingEntry } from '@/lib/services/workspace-rees';
import { liveEntry } from '@/lib/services/workspace';
import { filesHref, FilesTopbar, PathCrumbs, StorageStrip, WriterChip } from '@/components/files/files-parts';
import '@/components/knowledge/knowledge.css';
import '@/components/files/files.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.files.title };
}

/**
 * `/files?path=…`: the agent workspace (docs/design/agent-workspace.md) --
 * a folder's files with the tree beside them, or one file's text with its
 * versions. The owner sees the whole default workspace.
 */
export default async function FilesPage({ searchParams }: { searchParams: Promise<{ path?: string }> }) {
  const user = (await currentUser())!;
  const { t, locale } = await serverMessages();
  const scope = await webScope(user.id);
  const path = normalizePath((await searchParams).path ?? '/') ?? '/';
  const kind = await kindAt(scope, path);
  const crumbs = path === '/' ? [] : path.split('/').filter(Boolean).map((part, index, parts) => ({ label: part, href: index < parts.length - 1 ? filesHref(`/${parts.slice(0, index + 1).join('/')}`) : undefined }));
  return (
    <>
      <FilesTopbar t={t} tab="files" crumbs={crumbs} />
      <main className="knowledge-ui files-ui">
        <div className="km-page">
          {kind === 'file' ? (
            <FileView t={t} locale={locale} scope={scope} path={path} />
          ) : (
            <FolderView t={t} locale={locale} scope={scope} path={kind === 'folder' ? path : '/'} missing={kind === null} userId={user.id} />
          )}
        </div>
      </main>
    </>
  );
}

async function FolderView({ t, locale, scope, path, missing, userId }: { t: Messages; locale: 'zh' | 'en'; scope: WorkspaceScope; path: string; missing: boolean; userId: string }) {
  const f = t.files;
  const [listing, folders] = await Promise.all([listEntries(scope, { path, limit: 500 }), folderPaths(scope)]);
  const entries = [...listing.entries].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1));
  /* The tree: top-level folders, and the folders inside each one on the way to this one. */
  const open = (folder: string) => {
    const parent = parentOf(folder).toLowerCase();
    const here = path.toLowerCase();
    return parent === '/' || here === parent || here.startsWith(`${parent}/`);
  };
  const tree = folders.filter(open);
  return (
    <>
      <div className="km-page-head">
        <div>
          <p className="eyebrow">{f.eyebrow}</p>
          <h1>{f.title}</h1>
          <p>{f.lede}</p>
        </div>
        {path !== '/' && (
          <div className="flex">
            <CreateReeButton path={path} />
          </div>
        )}
      </div>
      <StorageStrip t={t} userId={userId} locale={locale} />
      {missing && <p className="km-failure">{f.notFound}</p>}
      <div className="km-library-layout">
        <aside className="km-folders" aria-label={f.folders}>
          <div className="km-folders-head">
            <strong>{f.folders}</strong>
          </div>
          <nav className="ws-tree">
            <div className={`km-folder-row ${path === '/' ? 'active' : ''}`}>
              <Link className="km-folder-link" href="/files">
                <Icon name="layers" />
                <span>{f.root}</span>
              </Link>
            </div>
            {tree.map((folder) => (
              <div key={folder} className={`km-folder-row ${folder.toLowerCase() === path.toLowerCase() ? 'active' : ''}`} style={{ ['--depth' as string]: folder.split('/').length - 2 }}>
                <Link className="km-folder-link" href={filesHref(folder)} title={folder}>
                  <Icon name="folder" />
                  <span>{nameOf(folder)}</span>
                </Link>
              </div>
            ))}
          </nav>
          <p className="km-folders-hint">{f.foldersHint}</p>
        </aside>
        <div className="km-library-content">
          <div className="km-folder-context">
            <Icon name="folder" />
            <PathCrumbs t={t} path={path} />
            <span>{fill(f.items, { n: entries.length })}</span>
          </div>
          <section className="card km-results">
            <div className="km-scroll">
              <table className="km-table">
                <thead>
                  <tr>
                    <th>{f.columns.name}</th>
                    <th>{f.columns.writer}</th>
                    <th>{f.columns.index}</th>
                    <th className="km-meta-col">{f.columns.size}</th>
                    <th className="km-date-col">{f.columns.updated}</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => {
                    const at = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
                    return (
                      <tr key={at}>
                        <td>
                          <div className="km-source-name">
                            <span className="file-icon">
                              <Icon name={entry.kind === 'folder' ? 'folder' : 'file'} />
                            </span>
                            <span>
                              <Link href={filesHref(at)}>{entry.name}</Link>
                              <small>{entry.kind === 'folder' ? f.folder : `${entry.media_type ?? ''} · ${fill(f.lines, { n: entry.lines ?? 0 })}`}</small>
                            </span>
                          </div>
                        </td>
                        <td>{entry.kind === 'file' ? <WriterChip t={t} writer={entry.updated_by} /> : <span className="ws-muted">—</span>}</td>
                        <td>{entry.index ? <IndexState t={t} state={entry.index} /> : <span className="ws-muted">—</span>}</td>
                        <td className="km-meta-col">{entry.kind === 'file' ? formatBytes(entry.size) : '—'}</td>
                        <td className="km-date-col">{formatDateTime(entry.updated_at, locale)}</td>
                      </tr>
                    );
                  })}
                  {entries.length === 0 && (
                    <tr>
                      <td colSpan={5}>
                        <div className="km-empty">
                          <Icon name="folder" />
                          <h3>{f.emptyTitle}</h3>
                          <p>{f.emptyBody}</p>
                          <Link className="btn" href="/files/connect">
                            <Icon name="link" />
                            {f.connectCta}
                          </Link>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
          <div className="km-page-note">
            <span>
              <Icon name="shield" />
              {f.note}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

async function FileView({ t, locale, scope, path }: { t: Messages; locale: 'zh' | 'en'; scope: WorkspaceScope; path: string }) {
  const f = t.files.file;
  const [file, history] = await Promise.all([fileText(scope, path), fileHistory(scope, { path, limit: 50 })]);
  const lines = file.text === '' ? [] : file.text.split('\n');
  if (file.text.endsWith('\n')) lines.pop();
  const parent = parentOf(file.path);
  const entry = await liveEntry(db(), scope, file.path);
  const rees = entry ? await reesUsingEntry(scope.userId, entry.id) : [];
  return (
    <>
      <div className="ws-file-head">
        <div className="km-source-name">
          <span className="file-icon">
            <Icon name="file" />
          </span>
          <span>
            <h1 className="ws-file-title">{file.name}</h1>
            <small>
              {file.path} · {formatBytes(file.size)} · {fill(t.files.lines, { n: lines.length })} · {file.media_type} · etag <span className="mono">{file.etag}</span>
            </small>
          </span>
        </div>
        <div className="flex">
          <CopyButton text={file.path} label={f.copyPath} />
          <a className="btn secondary sm" href={`/api/files/raw?path=${encodeURIComponent(file.path)}`}>
            <Icon name="download" />
            {f.download}
          </a>
          <TrashButton path={file.path} name={file.name} folder={false} parentHref={filesHref(parent)} />
        </div>
      </div>
      {rees.length > 0 && (
        <div className="ws-notice">
          <Icon name="ree" />
          <span>
            {fill(t.files.usedBy, { rees: rees.map((ree) => ree.name).join('、') })}
            {rees.filter((ree) => ree.awaiting).map((ree) => fill(t.files.waitingIn, { ree: ree.name })).join('')}
            {file.index ? ` ${t.files.index[file.index as keyof typeof t.files.index] ?? ''}` : ''}
          </span>
        </div>
      )}
      <div className="ws-file-layout">
        <section className="card ws-file-body">
          <div className="ws-file-tabs">
            <span className="is-active">{f.content}</span>
            <span className="ws-grow" />
            <small>{fill(f.range, { n: lines.length })}</small>
          </div>
          {lines.length ? (
            <div className="ws-code">
              {lines.map((line, index) => [
                <span key={`n${index}`} className="ws-ln">
                  {index + 1}
                </span>,
                <span key={`l${index}`} className="ws-lc">
                  {line || ' '}
                </span>,
              ])}
            </div>
          ) : (
            <p className="ws-empty-file">{f.empty}</p>
          )}
        </section>
        <aside className="card ws-history">
          <div className="ws-history-head">
            <strong>
              <Icon name="clock" />
              {f.history}
            </strong>
            <small>{fill(f.versions, { n: history.versions.length })}</small>
          </div>
          <ol className="ws-vers">
            {history.versions.map((version, index) => (
              <li key={version.revision} className={`ws-ver ${version.current ? 'is-current' : ''}`}>
                <i className="ws-ver-dot" />
                <div>
                  <div className="ws-ver-head">
                    <strong>#{history.versions.length - index}</strong>
                    <WriterChip t={t} writer={version.written_by} />
                  </div>
                  <small>
                    {f.ops[version.op]} · {formatDateTime(version.updated_at, locale)} · {formatBytes(version.size)}
                  </small>
                  {version.saves > 1 && <small className="ws-squash">{fill(f.merged, { n: version.saves })}</small>}
                </div>
                {version.current ? <span className="tag green">{f.current}</span> : <RestoreVersionButton path={file.path} revision={version.revision} />}
              </li>
            ))}
          </ol>
          <p className="ws-history-note">{f.historyNote}</p>
        </aside>
      </div>
    </>
  );
}

function IndexState({ t, state }: { t: Messages; state: string }) {
  const label = t.files.index[state as keyof typeof t.files.index] ?? state;
  const tone = state === 'indexed' ? 'ready' : state === 'queued' || state === 'stale' ? 'pending' : 'failed';
  return (
    <span className={`ks-status ${tone}`}>
      {tone === 'pending' ? <i className="spinner" /> : <i className="dot" />}
      {label}
    </span>
  );
}
