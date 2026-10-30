import {
  PlatformProfileRebuildControl,
  type PlatformAssetTarget,
} from '@/components/admin/platform-asset-controls';
import { Fact, Panel, PanelHead, Pill } from '@/components/admin/ui';
import type { PlatformProfileView } from '@/lib/application/administration';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { fill } from '@/lib/i18n/format';
import type { PlatformAction } from './platform-asset-shared';

/**
 * The routing profile of the current version, on the platform-asset detail
 * page.
 *
 * Everything `resolve-asset-id` knows about an asset is on this row
 * (architecture.md 9.6), and until now none of it was on any screen. The two
 * faults an operator can act on both show at the head of the term list: a
 * crawl that escaped its section brings the site's other sections' vocabulary
 * with it, and an extractor that let navigation text through puts "new",
 * "opens", "tab" ahead of every real term. The sample titles show the first
 * of the two directly.
 */
export function PlatformProfilePanel({
  profile,
  target,
  action,
  stamp,
  t,
}: {
  profile: PlatformProfileView | null;
  target: PlatformAssetTarget;
  action: PlatformAction;
  /** The page's own timestamp formatter, so this panel matches its neighbours. */
  stamp: (value: Date) => string;
  t: Dictionary['admin']['platformAssetDetail'];
}) {
  const p = t.profile;
  const number = (value: number) => value.toLocaleString('en-US');

  return (
    <Panel className="overflow-hidden">
      <PanelHead
        title={p.title}
        description={p.description}
        action={
          <PlatformProfileRebuildControl
            action={action}
            target={target}
            disabled={profile === null}
          />
        }
      />
      {profile === null ? (
        <p className="px-[19px] py-8 text-center text-[13px] tracking-[-0.023em] text-steel">
          {p.empty}
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-x-6 px-[19px] py-1.5 sm:grid-cols-2">
            <Fact
              label={p.extractor}
              value={
                <span className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-[11px]">{profile.extractorVersion}</code>
                  <Pill tone={profile.stale ? 'warn' : 'ok'}>
                    {profile.stale ? p.extractorStale : p.extractorCurrent}
                  </Pill>
                </span>
              }
            />
            <Fact label={p.built} value={`${stamp(profile.createdAt)} UTC`} />
            <Fact label={p.titles} value={number(profile.titleCount)} />
            <Fact
              label={p.vectors}
              value={fill(p.vectorsValue, {
                centroids: number(profile.centroids),
                terms: number(profile.termCount),
              })}
            />
          </dl>

          <div className="flex flex-col gap-1.5 border-t-2 border-line px-[19px] py-3">
            <p className="text-[11px] font-bold tracking-[0.02em] text-faint">
              {fill(p.termsHead, { shown: number(profile.topTerms.length) })}
            </p>
            <p className="text-[11px] leading-[1.5] tracking-[-0.023em] text-muted">
              {p.termsNote}
            </p>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {profile.topTerms.map((term) => (
                <li
                  key={term}
                  className="rounded-[6px] border border-line bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-steel"
                >
                  {term}
                </li>
              ))}
            </ul>
          </div>

        </>
      )}
    </Panel>
  );
}
