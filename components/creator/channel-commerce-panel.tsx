import { PANEL } from '@/components/dashboard/ui';
import type { ChannelCommerce } from '@/lib/application/channels/subscriptions';
import type { ChannelStreamItem } from '@/lib/application/channels';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { fill } from '@/lib/i18n/format';
import {
  enableSubscriptionsAction,
  setAssetAccessAction,
  setChannelPlanAction,
  setDailyLimitAction,
} from '@/app/dashboard/channels/commerce-actions';
import { formatUsd } from './format';

const FIELD = 'h-9 rounded-md border border-line bg-field px-3 text-[13px] text-ink';
const SMALL = 'inline-flex h-9 items-center rounded-md border border-line bg-card px-3 text-[12px] font-medium text-steel hover:bg-subtle';
const PRIMARY = 'inline-flex h-9 items-center rounded-md bg-brand px-3.5 text-[12px] font-medium text-onbrand hover:bg-brand/90';

/**
 * The owner's selling controls for one channel (agent-first-proposal.md
 * 6.9-6.11): switch subscriptions on behind the paid-distribution
 * confirmation, price each interval, cap a subscriber's daily reads, and
 * mark assets paid. Server-rendered forms; every rule is the use case's.
 */
export function ChannelCommercePanel({
  channelId,
  commerce,
  stream,
  settings,
  notice,
  t,
  locale,
}: {
  channelId: string;
  commerce: ChannelCommerce;
  stream: ChannelStreamItem[];
  settings: { feeRateBps: number; minPriceMinor: number };
  notice: string | null;
  t: Dictionary;
  locale: string;
}) {
  const c = t.creator.dashboard.commerce;
  const errors = t.creator.errors as Record<string, string>;
  const good = notice !== null && notice in c.notices;
  const message = notice === null ? null : ((c.notices as Record<string, string>)[notice] ?? errors[notice] ?? errors.unavailable);
  const fee = (bps: number) => String(bps / 100);

  return (
    <section id="commerce" className={`${PANEL} flex flex-col gap-4 p-6`}>
      <div className="flex flex-col gap-1">
        <h2 className="text-[15px] font-medium text-ink">{c.title}</h2>
        <p className="text-[12px] leading-[1.5] text-muted">
          {fill(c.description, { fee: fee(settings.feeRateBps), min: formatUsd(settings.minPriceMinor, locale) })}
        </p>
      </div>
      {message ? (
        <p role="status" className={`text-[12.5px] ${good ? 'text-brandink' : 'text-rose'}`}>
          {message}
        </p>
      ) : null}

      {!commerce.subscriptionsEnabled ? (
        <form action={enableSubscriptionsAction} className="flex flex-col gap-3">
          <input type="hidden" name="channelId" value={channelId} />
          <label className="flex items-start gap-2 text-[12.5px] leading-[1.5] text-ink">
            <input type="checkbox" name="confirmRights" value="yes" required className="mt-1" />
            {c.rightsConfirm}
          </label>
          <button type="submit" className={`${PRIMARY} w-fit`}>
            {c.enable}
          </button>
        </form>
      ) : (
        <>
          <p className="text-[12px] text-brandink">
            {c.enabled} · {fill(c.subscribers, { count: String(commerce.activeSubscribers) })}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {(['month', 'year'] as const).map((interval) => {
              const plan = commerce.plans.find((candidate) => candidate.interval === interval);
              return (
                <form key={interval} action={setChannelPlanAction} className="flex flex-col gap-2 rounded-md border border-line p-4">
                  <input type="hidden" name="channelId" value={channelId} />
                  <input type="hidden" name="interval" value={interval} />
                  <p className="text-[13px] font-medium text-ink">{interval === 'month' ? c.monthly : c.yearly}</p>
                  <p className="text-[11.5px] text-muted">
                    {plan ? fill(c.current, { price: formatUsd(plan.priceMinor, locale), fee: fee(plan.feeRateBps) }) : c.none}
                  </p>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] font-medium text-steel">{c.priceLabel}</span>
                    <input name="price" inputMode="decimal" placeholder={(settings.minPriceMinor / 100).toFixed(2)} className={FIELD} />
                  </label>
                  <span className="flex gap-2">
                    <button type="submit" name="intent" value="set" className={PRIMARY}>
                      {c.setPrice}
                    </button>
                    {plan ? (
                      <button type="submit" name="intent" value="retire" formNoValidate className={SMALL}>
                        {c.retire}
                      </button>
                    ) : null}
                  </span>
                </form>
              );
            })}
          </div>
          <p className="text-[11px] text-muted">{c.priceNote}</p>

          <form action={setDailyLimitAction} className="flex flex-wrap items-end gap-3 border-t border-line pt-4">
            <input type="hidden" name="channelId" value={channelId} />
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-steel">{c.dailyLimit}</span>
              <input
                name="limit"
                type="number"
                min={1}
                max={100000}
                placeholder={c.dailyLimitNone}
                defaultValue={commerce.subscriberDailyLimit ?? ''}
                className={FIELD}
              />
            </label>
            <button type="submit" className={SMALL}>
              {c.saveLimit}
            </button>
            <p className="w-full text-[11px] text-muted">{c.dailyLimitHint}</p>
          </form>

          {stream.length > 0 ? (
            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <p className="text-[12.5px] font-medium text-ink">{c.accessTitle}</p>
              <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
                {stream.map((item) => (
                  <li key={item.assetId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <span className="min-w-0 truncate text-[12.5px] text-ink">{item.title}</span>
                    <form action={setAssetAccessAction}>
                      <input type="hidden" name="channelId" value={channelId} />
                      <input type="hidden" name="assetId" value={item.assetId} />
                      <input type="hidden" name="access" value={item.access === 'paid' ? 'free' : 'paid'} />
                      <button type="submit" className={SMALL}>
                        {item.access === 'paid' ? c.makeFree : c.makePaid}
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
