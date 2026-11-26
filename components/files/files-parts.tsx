/**
 * Server-rendered pieces the workspace pages share: the top bar with its
 * tabs, the storage line, a writer's chip and a path's link.
 */
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { Topbar } from '@/components/shell/topbar';
import { Icon } from '@/components/ui/icons';
import type { Messages } from '@/i18n';
import { fill, formatBytes } from '@/i18n/format';
import { workspaceUsageOf } from '@/lib/services/workspace';

export type FilesTab = 'files' | 'trash' | 'usage' | 'connect';

/** `/files?path=…`: the web's address of a workspace path. */
export function filesHref(path: string): string {
  return path === '/' ? '/files' : `/files?path=${encodeURIComponent(path)}`;
}

export function FilesTopbar({ t, tab, crumbs }: { t: Messages; tab: FilesTab; crumbs: { label: string; href?: string }[] }) {
  const f = t.files;
  return (
    <Topbar
      crumbs={[{ label: f.title, href: '/files' }, ...crumbs]}
      tabsLabel={f.tabs.label}
      tabs={[
        { label: f.tabs.files, href: '/files', active: tab === 'files', icon: 'folder' },
        { label: f.tabs.trash, href: '/files/trash', active: tab === 'trash', icon: 'trash' },
        { label: f.tabs.usage, href: '/files/usage', active: tab === 'usage', icon: 'chart' },
        { label: f.tabs.connect, href: '/files/connect', active: tab === 'connect', icon: 'link' },
      ]}
    />
  );
}

export async function StorageStrip({ t, userId, locale }: { t: Messages; userId: string; locale: 'zh' | 'en' }) {
  const usage = await workspaceUsageOf(userId);
  const share = Math.min(100, (usage.usedBytes / Math.max(1, usage.freeBytes)) * 100);
  return (
    <div className="ws-storage-strip">
      <span>
        <Icon name="folder" /> <strong>{fill(t.files.storage, { used: formatBytes(usage.usedBytes) })}</strong>
      </span>
      <span className="ws-bar" aria-hidden="true">
        <i style={{ width: `${Math.max(share, usage.usedBytes ? 1 : 0)}%` }} />
      </span>
      <span>{fill(t.files.storageFree, { free: formatBytes(usage.freeBytes) })}</span>
      <span>{fill(t.files.storageEntries, { n: usage.entries.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') })}</span>
    </div>
  );
}

const CLIENT_KINDS: [RegExp, string][] = [
  [/claude/i, 'claude'],
  [/codex/i, 'codex'],
  [/cursor/i, 'cursor'],
  [/^web$/i, 'web'],
];

/** Which tool last wrote something: `web` is the owner on this site. */
export function WriterChip({ t, writer }: { t: Messages; writer: string | null }) {
  if (!writer) return <span className="ws-muted">—</span>;
  const label = writer.toLowerCase() === 'web' ? t.files.web : writer;
  const kind = CLIENT_KINDS.find(([pattern]) => pattern.test(writer))?.[1];
  return (
    <span className="ws-client" data-client={kind}>
      <i />
      {label}
    </span>
  );
}

/** `/a/b/c` as links to each folder on the way. */
export function PathCrumbs({ t, path }: { t: Messages; path: string }) {
  const parts = path.split('/').filter(Boolean);
  return (
    <span className="ws-crumbs">
      <Link href="/files">{t.files.root}</Link>
      {parts.map((part, index) => {
        const at = `/${parts.slice(0, index + 1).join('/')}`;
        return index === parts.length - 1 ? (
          <strong key={at}>{part}</strong>
        ) : (
          <Link key={at} href={filesHref(at)}>
            {part}
          </Link>
        );
      })}
    </span>
  );
}
