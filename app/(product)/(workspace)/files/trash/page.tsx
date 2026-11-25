import type { Metadata } from 'next';
import { currentUser } from '@/lib/http/session';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime } from '@/i18n/format';
import { WORKSPACE_TRASH_DAYS } from '@/lib/constants';
import { parentOf } from '@/lib/domain/workspace';
import { listEntries, webScope } from '@/lib/services/workspace';
import { TrashList, type TrashItem } from '@/components/files/file-actions';
import { FilesTopbar } from '@/components/files/files-parts';
import '@/components/knowledge/knowledge.css';
import '@/components/files/files.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.files.trash.title };
}

/**
 * `/files/trash`: what was deleted from the workspace in the last
 * WORKSPACE_TRASH_DAYS days. Restore here or over MCP; deleting for good
 * only here. What a folder took with it is not listed separately.
 */
export default async function FilesTrashPage() {
  const user = (await currentUser())!;
  const { t, locale } = await serverMessages();
  const tr = t.files.trash;
  const scope = await webScope(user.id);
  const { entries } = await listEntries(scope, { path: '/', trash: true, limit: 500 });
  const deletedFolders = entries.filter((entry) => entry.kind === 'folder');
  /* Only the top of each deletion: an entry deleted with a folder at the same moment comes back with it. */
  const tops = entries.filter((entry) => !deletedFolders.some((folder) => folder !== entry && String(folder.deleted_at) === String(entry.deleted_at) && entry.path.toLowerCase().startsWith(`${folder.path.toLowerCase()}/`)));
  const now = Date.now();
  const items: TrashItem[] = tops
    .sort((a, b) => new Date(b.deleted_at!).getTime() - new Date(a.deleted_at!).getTime())
    .map((entry) => {
      const left = Math.max(0, Math.ceil((new Date(entry.deleted_at!).getTime() + WORKSPACE_TRASH_DAYS * 86_400_000 - now) / 86_400_000));
      return {
        id: entry.trash_id!,
        name: entry.name,
        from: parentOf(entry.path),
        kind: entry.kind,
        writer: entry.updated_by,
        deletedAt: new Date(entry.deleted_at!).toISOString(),
        deletedLabel: formatDateTime(entry.deleted_at!, locale),
        keepLabel: left > 0 ? fill(tr.keepDays, { n: left }) : tr.keepToday,
      };
    });
  return (
    <>
      <FilesTopbar t={t} tab="trash" crumbs={[{ label: tr.title }]} />
      <main className="knowledge-ui files-ui">
        <div className="km-page">
          <div className="km-page-head">
            <div>
              <p className="eyebrow">{tr.eyebrow}</p>
              <h1>
                {tr.title} <span className="mono">{items.length}</span>
              </h1>
              <p>{tr.lede}</p>
            </div>
          </div>
          <TrashList items={items} />
        </div>
      </main>
    </>
  );
}
