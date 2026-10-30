import { ConsoleButton, ConsolePageHeader, Panel } from '@/components/admin/ui';
import { ChevronLeftIcon } from '@/components/ui/icons';
import { getMessages } from '@/lib/i18n/server';

/**
 * What an unknown asset id renders.
 *
 * Inside the console shell rather than the site-wide 404: the operator is
 * signed in and where they meant to be, and the only thing wrong is the id.
 * The likelier cause is named, because it is a real one: the id of a *user*
 * asset pasted into this route lands here, and that asset exists -- it is
 * just handled on a different screen, by a different set of rules.
 */
export default async function PlatformAssetNotFound() {
  const t = await getMessages();
  const d = t.admin.platformAssetDetail;

  return (
    <div className="flex flex-col gap-[18px]">
      <ConsolePageHeader
        eyebrow={d.eyebrow}
        title={d.title}
        description={d.notFound}
        action={
          <ConsoleButton href="/admin/platform-assets">
            <ChevronLeftIcon size={14} />
            {d.notFoundBack}
          </ConsoleButton>
        }
      />
      <Panel className="px-[19px] py-9">
        <p className="text-[13px] leading-[1.6] tracking-[-0.023em] text-muted">
          {d.notFoundNote}
        </p>
      </Panel>
    </div>
  );
}
