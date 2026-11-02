import type { Messages } from '@/i18n';
import { Icon } from '@/components/ui/icons';

const ORDER = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'] as const;

/** The shared questions (prototype `faqItems`); the home page shows the first four, pricing from the third on. */
export function Faq({ t, from = 0, to = ORDER.length }: { t: Messages; from?: number; to?: number }) {
  return (
    <div className="divide-y divide-line border-y border-line">
      {ORDER.slice(from, to).map((key) => (
        <details key={key} className="group py-4">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[15px] font-semibold [&::-webkit-details-marker]:hidden">
            {t.site.faq[key].q}
            <Icon name="plus" className="size-4 flex-none text-muted transition group-open:rotate-45" />
          </summary>
          <p className="mt-3 text-[13px] leading-relaxed text-muted">{t.site.faq[key].a}</p>
        </details>
      ))}
    </div>
  );
}
