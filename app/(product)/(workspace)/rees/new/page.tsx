import type { Metadata } from 'next';
import { newReeDraft } from '@/lib/domain/ree';
import { currentUser } from '@/lib/http/session';
import { getDraft } from '@/lib/services/rees';
import { serverMessages } from '@/i18n/server';
import { SetupWizard } from '@/components/rees/setup-wizard';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.reeSetup.wizard.title };
}

/** `/rees/new?step=1..4`: resumes the saved draft at the requested step, never past the furthest one reached. */
export default async function NewReePage({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const user = (await currentUser())!;
  const draft = (await getDraft(user.id)) ?? newReeDraft();
  const requested = Number((await searchParams).step);
  const step = Math.min(Number.isInteger(requested) && requested >= 1 ? requested : draft.step, draft.reached, 4);
  return <SetupWizard initialDraft={{ ...draft, step }} />;
}
