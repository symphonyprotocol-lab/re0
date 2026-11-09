import type { Metadata } from 'next';
import { listModelConfigs } from '@/lib/services/models';
import { latestReembedJob } from '@/lib/services/reembed';
import { serverMessages } from '@/i18n/server';
import { ModelsBoard, type ReembedJobView } from '@/components/admin/models-board';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.admin.models.title };
}

export default async function ModelsPage() {
  const [{ t }, data, job] = await Promise.all([serverMessages(), listModelConfigs(), latestReembedJob()]);
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: t.console.nav.models }]} />
      <ModelsBoard initial={JSON.parse(JSON.stringify(data))} initialJob={job ? (JSON.parse(JSON.stringify(job)) as ReembedJobView) : null} />
    </ConsolePage>
  );
}
