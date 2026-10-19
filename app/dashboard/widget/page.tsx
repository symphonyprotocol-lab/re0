import type { Metadata } from 'next';
import Link from 'next/link';
import { CopyButton } from '@/components/dashboard/copy-button';
import {
  ActionButton,
  ArrowLink,
  Badge,
  ListHeader,
  Notice,
  PANEL,
  PageHeader,
  PanelHeading,
  StatTile,
  StatusLabel,
} from '@/components/dashboard/ui';
import {
  CircleCheckIcon,
  ClockIcon,
  GlobeIcon,
  KeyIcon,
  MessagesSquareIcon,
  TerminalIcon,
} from '@/components/ui/icons';
import { listWorkspaceWidgetSites, SITE_KEYS_PER_LIBRARY } from '@/lib/application/embed';
import { countWorkspaceLibraries } from '@/lib/application/libraries';
import { embedSnippet } from '@/lib/domain/site-key';
import { requireSession } from '@/lib/http/session';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';
import { publicUrl } from '@/lib/site/origin';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.widget.metaTitle };
}

/** What the snippet shows before the workspace has a key of its own. */
const SITE_KEY_PLACEHOLDER = 'mm_site_YOUR_KEY';

const GRID = 'grid grid-cols-[minmax(0,1fr)_120px_84px_84px_150px] items-center gap-2.5';

/**
 * The workspace's website widget in one place (requirement.md 9.4): how to
 * install it, and where it is. Keys are minted on each library's page, since
 * a key answers from one library; this screen is the view across all of
 * them, so an owner with three sites does not open three library pages to
 * learn which of them has pasted the snippet.
 *
 * "Integrated" is a fact observed, not a setting: an origin counts as reached
 * once the widget page has been served to a parent at that origin
 * (lib/application/embed/origins.ts). Until then the row says the owner has
 * allowed the site and is waiting for the snippet to go live.
 */
export default async function DashboardWidgetPage() {
  const [session, { locale, t }] = await Promise.all([
    requireSession('/dashboard/widget'),
    translations(),
  ]);
  const w = t.dashboard.widget;
  const workspaceId = session.workspace.id;

  const [keys, libraryCount] = await Promise.all([
    listWorkspaceWidgetSites(workspaceId),
    countWorkspaceLibraries(workspaceId),
  ]);

  const number = new Intl.NumberFormat(locale);
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  const origins = keys.flatMap((key) => key.origins);
  const reached = origins.filter((origin) => origin.lastSeenAt !== null);
  const questions = origins.reduce((sum, origin) => sum + origin.questions, 0);

  const stats = [
    { key: 'keys', value: number.format(keys.length), label: w.stats.keys, Icon: KeyIcon },
    { key: 'reached', value: number.format(reached.length), label: w.stats.reached, Icon: CircleCheckIcon },
    {
      key: 'waiting',
      value: number.format(origins.length - reached.length),
      label: w.stats.waiting,
      Icon: ClockIcon,
    },
    { key: 'questions', value: number.format(questions), label: w.stats.questions, Icon: MessagesSquareIcon },
  ];

  /* The snippet is real as soon as there is a key to put in it. */
  const first = keys[0] ?? null;
  const loader = publicUrl('/widget.js');
  const snippet = embedSnippet(loader, first ? first.key : SITE_KEY_PLACEHOLDER);
  const snippetNote = first
    ? fill(w.how.snippetKeyNote, { name: first.name, library: first.library.title })
    : fill(w.how.snippetPlaceholderNote, { placeholder: SITE_KEY_PLACEHOLDER });

  /* A key is minted on its library's page; send the owner to the right one. */
  const action =
    libraryCount === 0 ? (
      <ActionButton href="/dashboard/libraries/new">{w.createLibrary}</ActionButton>
    ) : (
      <ActionButton href="/dashboard/libraries" variant={first ? 'outline' : 'primary'}>
        {w.pickLibrary}
      </ActionButton>
    );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader eyebrow={session.workspace.name} title={w.title} description={w.description} action={action} />

      <section className="grid grid-cols-2 gap-[9px] sm:grid-cols-4">
        {stats.map(({ key, value, label, Icon }) => (
          <StatTile key={key} icon={<Icon size={17} />} value={value} label={label} />
        ))}
      </section>

      {/* How to integrate: the three steps, then the snippet they lead to. */}
      <section className={`${PANEL} flex flex-col gap-5 p-[30px]`}>
        <PanelHeading
          title={w.how.title}
          description={fill(w.how.description, { max: SITE_KEYS_PER_LIBRARY })}
        />
        <ol className="grid gap-4 md:grid-cols-3">
          {w.how.steps.map((step, index) => (
            <li key={step.title} className="flex flex-col gap-2 rounded-md border border-line bg-subtle/60 p-4">
              <span className="flex size-6 items-center justify-center rounded-full bg-brandsoft text-[11px] font-medium text-brandink">
                {index + 1}
              </span>
              <p className="text-[13px] font-medium text-ink">{step.title}</p>
              <p className="text-[11.5px] leading-[1.6] text-muted">{step.body}</p>
            </li>
          ))}
        </ol>

        <div className="flex flex-col gap-2">
          <div className="flex min-h-[52px] items-center gap-2.5 rounded-lg bg-terminal px-3.5 py-3">
            <TerminalIcon size={16} className="shrink-0 text-brandink" />
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12.5px] text-white">
              {snippet}
            </code>
            <CopyButton value={snippet} label={w.how.snippetLabel} className="shrink-0 text-faint hover:bg-white/10" />
          </div>
          <p className="text-[12px] text-muted">{snippetNote}</p>
        </div>

        <div className="flex flex-col gap-1.5 border-t border-line pt-4">
          <p className="text-[12px] font-medium text-steel">{w.how.attributesTitle}</p>
          <ul className="flex flex-col gap-1 pl-4 text-[11.5px] leading-[1.6] text-muted marker:text-muted">
            {w.how.attributes.map((line) => (
              <li key={line}>
                <code className="font-mono text-[11px] text-steel">{line.split(/[:：]/)[0]}</code>
                {line.slice(line.search(/[:：]/))}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <Notice tone="brand" icon={<GlobeIcon size={18} />} title={w.tip.title} body={w.tip.body} />

      {/* Integrated sites: every key, every origin it allows, and what was seen there. */}
      <section className={`${PANEL} overflow-hidden p-0.5`}>
        <ListHeader title={w.sites.title} description={w.sites.description} />

        {keys.length === 0 ? (
          <p className="border-t border-line px-5 py-10 text-center text-[13px] text-muted">{w.sites.empty}</p>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[640px]">
              <div className={`${GRID} border-t border-line bg-subtle px-5 py-[11px] text-[11px] font-medium text-muted`}>
                {w.sites.columns.map((column) => (
                  <span key={column}>{column}</span>
                ))}
              </div>

              {keys.map((key) => {
                const keySnippet = embedSnippet(loader, key.key);
                const manageHref = `/dashboard/libraries/${key.library.id}#widget`;
                return (
                  <div key={key.id} className="border-t border-line">
                    <div className="flex flex-wrap items-center justify-between gap-3 bg-subtle/50 px-5 py-3">
                      <div className="flex min-w-0 flex-wrap items-center gap-2 text-[12px]">
                        <span
                          aria-hidden
                          className="inline-block size-3 shrink-0 rounded-full border border-line"
                          style={{ background: key.accent }}
                        />
                        <Link href={manageHref} className="font-medium text-ink hover:text-brandink">
                          {key.library.title}
                        </Link>
                        <span className="text-muted">·</span>
                        <span className="text-steel">{key.name}</span>
                        <span className="text-muted">·</span>
                        <span className="text-muted">{fill(w.sites.perDay, { n: number.format(key.dailyLimit) })}</span>
                        {!key.library.ready ? (
                          <span title={w.sites.notReadyHint}>
                            <Badge tone="neutral">{w.sites.notReady}</Badge>
                          </span>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        <CopyButton value={keySnippet} label={w.sites.snippet} className="text-muted hover:bg-mutedbg" />
                        <ArrowLink href={manageHref}>{w.sites.manage}</ArrowLink>
                      </div>
                    </div>

                    {key.origins.map((origin) => {
                      const seen = origin.lastSeenAt !== null;
                      return (
                        <div key={origin.origin} className={`${GRID} border-t border-line px-5 py-3.5`}>
                          <span className="flex min-w-0 items-center gap-2.5">
                            <GlobeIcon size={14} className="shrink-0 text-muted" />
                            <code className="truncate font-mono text-[12px] text-ink">{origin.origin}</code>
                          </span>
                          <StatusLabel tone={seen ? 'live' : 'pending'}>
                            {seen ? w.sites.reached : w.sites.waiting}
                          </StatusLabel>
                          <span className="text-[12px] text-steel">{seen ? number.format(origin.loads) : '—'}</span>
                          <span className="text-[12px] text-steel">{seen ? number.format(origin.questions) : '—'}</span>
                          <span className="flex flex-col gap-0.5">
                            <span className="text-[11px] text-steel">
                              {origin.lastSeenAt ? dateTime.format(new Date(origin.lastSeenAt)) : '—'}
                            </span>
                            {origin.firstSeenAt ? (
                              <span className="text-[10px] text-muted">
                                {fill(w.sites.firstSeen, { time: dateTime.format(new Date(origin.firstSeenAt)) })}
                              </span>
                            ) : null}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
