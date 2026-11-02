import type { Metadata } from 'next';
import { listModelConfigs } from '@/lib/services/models';
import { serverMessages } from '@/i18n/server';
import { ModelsBoard } from '@/components/admin/models-board';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.admin.models.title };
}

export default async function ModelsPage() {
  const data = await listModelConfigs();
  return <ModelsBoard initial={JSON.parse(JSON.stringify(data))} />;
}
