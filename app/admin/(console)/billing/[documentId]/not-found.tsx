import { ConsoleButton, ConsolePageHeader, Panel } from '@/components/admin/ui';
import { ChevronLeftIcon } from '@/components/ui/icons';
import { getMessages } from '@/lib/i18n/server';
import { paddleConfig } from '@/lib/infrastructure/payment/paddle';

/**
 * What an unknown document id renders.
 *
 * Inside the console shell rather than the site-wide 404: the operator is
 * signed in and where they meant to be, and the only thing wrong is the id.
 * "Never mirrored here" is the likelier cause than "does not exist" -- a
 * document the provider has but no webhook ever delivered has a real id
 * somewhere and none on this side.
 */
export default async function BillingDocumentNotFound() {
  const t = await getMessages();
  const d = t.admin.billingDetail;

  return (
    <div className="flex flex-col gap-[18px]">
      <ConsolePageHeader
        eyebrow={d.eyebrow}
        title={d.title}
        description={d.notFound}
        action={
          <ConsoleButton href="/admin/billing">
            <ChevronLeftIcon size={14} />
            {d.notFoundBack}
          </ConsoleButton>
        }
      />
      {paddleConfig() ? null : (
        <Panel className="px-[19px] py-9">
          <p className="text-[13px] tracking-[-0.023em] text-muted">{t.admin.notReady.billing}</p>
        </Panel>
      )}
    </div>
  );
}
