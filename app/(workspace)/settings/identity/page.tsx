import type { Metadata } from 'next';
import Link from 'next/link';
import { reportingDate } from '@/lib/domain/statistics';
import { currentUser } from '@/lib/http/session';
import { kycOverview } from '@/lib/services/kyc';
import { serverMessages } from '@/i18n/server';
import { Topbar } from '@/components/shell/topbar';
import { Icon } from '@/components/ui/icons';
import { IdentityForm } from '@/components/payouts/identity-form';

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
      <main className="mx-auto max-w-[1040px] px-4 py-8 md:px-8">
        {official ? (
          <section className="card mx-auto max-w-[560px] bg-[#fbfaff] p-6 text-center">
            <span className="mx-auto inline-flex size-10 items-center justify-center rounded-xl bg-white text-[#7255bd]">
              <Icon name="globe" />
            </span>
            <h1 className="mt-3 text-[17px] font-bold">{f.officialTitle}</h1>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">{f.officialBody}</p>
            <Link href="/settings?tab=billing" className="btn-secondary mt-5">
              {f.back}
            </Link>
          </section>
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
