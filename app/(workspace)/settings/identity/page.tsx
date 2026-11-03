import type { Metadata } from 'next';
import { reportingDate } from '@/lib/domain/statistics';
import { currentUser } from '@/lib/http/session';
import { kycOverview } from '@/lib/services/kyc';
import { serverMessages } from '@/i18n/server';
import { Topbar } from '@/components/shell/topbar';
import { IdentityForm } from '@/components/payouts/identity-form';
import { OfficialNotice } from '@/components/settings/role-tab';
import '@/components/settings/settings.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.payouts.identity.title };
}

/**
 * `/settings/identity` (8.2: the KYC page stands on its own; prototype
 * `#/settings/identity`). Official accounts do not verify identity and see
 * a notice instead of the form.
 */
export default async function IdentityPage() {
  const user = (await currentUser())!;
  const { t } = await serverMessages();
  const f = t.payouts.identity;
  const { state, official, record } = await kycOverview(user.id);
  return (
    <>
      <Topbar
        crumbs={[
          { label: t.dashboard.title, href: '/dashboard' },
          { label: t.settings.tabs.billing, href: '/settings?tab=billing' },
          { label: f.crumb },
        ]}
      />
      <main className="settings-page kyc-page">
        {official ? (
          <OfficialNotice t={t} />
        ) : (
          <IdentityForm
            state={state}
            today={reportingDate()}
            record={
              record && {
                legalName: record.legalName,
                country: record.country,
                documentKind: record.documentKind,
                documentLast4: record.documentLast4,
                documentExpires: record.documentExpires,
                taxForm: record.taxForm,
                declared: Boolean(record.taxDeclaredAt),
                reason: record.reason,
                createdAt: record.createdAt.toISOString(),
                decidedAt: record.decidedAt?.toISOString() ?? null,
                hasDocument: record.hasDocument,
                hasSelfie: record.hasSelfie,
                filesDeleted: Boolean(record.filesDeletedAt),
              }
            }
          />
        )}
      </main>
    </>
  );
}
