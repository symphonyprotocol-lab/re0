import type { Metadata } from 'next';
import { DeleteRecordsButton, RetentionForm } from '@/components/dashboard/privacy-controls';
import { PANEL, PageHeader } from '@/components/dashboard/ui';
import { privateAssetRetention, PRIVATE_ASSET_RETENTION_DAYS } from '@/lib/application/privacy';
import { requireSession } from '@/lib/http/session';
import { getMessages, translations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.privacyData.metaTitle };
}

const LINK =
  'inline-flex h-9 items-center rounded-md border border-line px-3.5 text-[12px] text-ink transition-colors hover:bg-subtle';

/**
 * 导出与删除 (agent-first-proposal.md 7.9 part 4, 10): what is kept of the
 * workspace's conversations and A2A tasks, the JSON exports, one-click
 * deletion, and the retention period for private assets.
 */
export default async function PrivacyDataPage() {
  const [session, { t }] = await Promise.all([requireSession('/dashboard/privacy'), translations()]);
  const p = t.dashboard.privacyData;
  const retention = await privateAssetRetention(session.workspace.id);

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader eyebrow={session.workspace.name} title={p.title} description={p.description} />

      <section className={`${PANEL} p-4`}>
        <h2 className="text-[13px] font-medium text-ink">{p.keptTitle}</h2>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-[12px] leading-[1.6] text-muted">
          {p.kept.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <section className={`${PANEL} p-4`}>
        <h2 className="text-[13px] font-medium text-ink">{p.exportTitle}</h2>
        <p className="mt-1 text-[12px] leading-[1.6] text-muted">{p.exportBody}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a href="/dashboard/export/conversations" className={LINK} download>
            {p.exportConversations}
          </a>
          <a href="/dashboard/export/a2a-tasks" className={LINK} download>
            {p.exportTasks}
          </a>
        </div>
      </section>

      <section className={`${PANEL} p-4`}>
        <h2 className="text-[13px] font-medium text-ink">{p.deleteTitle}</h2>
        <p className="mt-1 text-[12px] leading-[1.6] text-muted">{p.deleteBody}</p>
        <div className="mt-3 flex flex-wrap items-start gap-3">
          <DeleteRecordsButton what="conversations" />
          <DeleteRecordsButton what="tasks" />
        </div>
      </section>

      <section className={`${PANEL} p-4`}>
        <h2 className="text-[13px] font-medium text-ink">{p.retentionTitle}</h2>
        <p className="mt-1 mb-3 text-[12px] leading-[1.6] text-muted">{p.retentionBody}</p>
        <RetentionForm current={retention} choices={PRIVATE_ASSET_RETENTION_DAYS} />
      </section>
    </div>
  );
}
