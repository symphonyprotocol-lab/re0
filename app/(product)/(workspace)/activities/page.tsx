import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { invitePanelCopy, inviteLink } from '@/lib/domain/invites';
import { appBaseUrl } from '@/lib/http/cookies';
import { currentUser } from '@/lib/http/session';
import { invitePanel } from '@/lib/services/invites';
import { activities } from '@/lib/services/task-rewards';
import { serverMessages } from '@/i18n/server';
import { Topbar } from '@/components/shell/topbar';
import { ActivitiesView } from '@/components/activities/activities-view';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.invites.activities.title };
}

/** `/activities`: the daily check-in, the starter tasks and a short invite block (docs/design/invitations.md). */
export default async function ActivitiesPage() {
  const [user, { t }] = await Promise.all([currentUser(), serverMessages()]);
  if (!user) redirect('/login?returnTo=%2Factivities');
  const [data, panel] = await Promise.all([activities(user.id), invitePanel(user.id)]);
  return (
    <>
      <Topbar crumbs={[{ label: t.invites.activities.title }]} />
      <ActivitiesView
        activities={data}
        invite={{ credits: panel.inviteCredits, link: inviteLink(appBaseUrl(), panel.code), copy: invitePanelCopy(panel), ownWithdrawable: panel.ownWithdrawable, ownCap: panel.ownCap }}
      />
    </>
  );
}
