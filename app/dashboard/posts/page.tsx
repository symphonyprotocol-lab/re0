import type { Metadata } from 'next';
import Link from 'next/link';
import { PANEL, PageHeader } from '@/components/dashboard/ui';
import { listWorkspaceChannels } from '@/lib/application/channels';
import { listEditorialAssets } from '@/lib/application/editorial';
import { canManageAssets } from '@/lib/application/assets';
import { EDITORIAL_LIMITS } from '@/lib/domain/editorial';
import { RIGHTS_GENERATIONS, RIGHTS_LICENSES, RIGHTS_ORIGINS } from '@/lib/domain/rights';
import { requireSession } from '@/lib/http/session';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';
import { createEditorialAction, importPostsAction } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).creator.dashboard.posts.metaTitle };
}

const FIELD = 'h-10 w-full rounded-md border border-line bg-field px-3 text-[13px] text-ink';
const BUTTON = 'inline-flex h-10 items-center rounded-md bg-brand px-4 text-[12px] font-medium text-onbrand hover:bg-brand/90';

/**
 * The workspace's articles, episodes and Q&As (agent-first-proposal.md 6.5,
 * 6.6), with the forms that start a post, an episode or an import. Each
 * new one is a draft in no channel; the editor publishes it.
 */
export default async function PostsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, { locale, t }, query] = await Promise.all([requireSession('/dashboard/posts'), translations(), searchParams]);
  const c = t.creator.dashboard.posts;
  const errors = t.creator.errors as Record<string, string>;
  const rights = t.dashboard.assets.rights;
  const kinds = t.channels.kinds as Record<string, string>;
  const [items, channels] = await Promise.all([listEditorialAssets(session.workspace.id), listWorkspaceChannels(session.workspace.id)]);
  const canEdit = canManageAssets(session.workspace.role);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const error = typeof query.error === 'string' ? (errors[query.error] ?? errors.unavailable) : null;
  const notice = query.notice === 'imported' ? fill(c.imported, { count: String(query.count ?? 0) }) : null;

  const rightsSelect = (name: string, key: 'origin' | 'license' | 'generation', options: readonly string[], labels: Record<string, string>) => (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-steel">{rights.labels[key]}</span>
      <select name={name} className={FIELD} defaultValue={options[0]}>
        {options.map((option) => (
          <option key={option} value={option}>
            {labels[option] ?? option}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader eyebrow={session.workspace.name} title={c.title} description={c.description} />
      {error ? <p role="alert" className="text-[12.5px] text-rose">{error}</p> : null}
      {notice ? <p role="status" className="text-[12.5px] text-brandink">{notice}</p> : null}

      {canEdit ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {(['post', 'audio'] as const).map((kind) => (
            <form key={kind} action={createEditorialAction} className={`${PANEL} flex flex-col gap-4 p-6`}>
              <input type="hidden" name="kind" value={kind} />
              <h2 className="text-[15px] font-medium text-ink">{kind === 'post' ? c.newPost : c.newEpisode}</h2>
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium text-steel">{c.titleLabel}</span>
                <input name="title" required maxLength={EDITORIAL_LIMITS.titleMax} className={FIELD} />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium text-steel">{c.slugLabel}</span>
                <input name="slug" maxLength={64} className={FIELD} />
              </label>
              <fieldset className="grid gap-3 sm:grid-cols-3">
                <legend className="mb-1 text-[11px] font-medium text-steel">{c.rightsTitle}</legend>
                {rightsSelect('rightsOrigin', 'origin', RIGHTS_ORIGINS, rights.origins)}
                {rightsSelect('rightsLicense', 'license', RIGHTS_LICENSES, rights.licenses)}
                {rightsSelect('rightsGeneration', 'generation', RIGHTS_GENERATIONS, rights.generations)}
              </fieldset>
              <footer className="flex justify-end border-t border-line pt-4">
                <button type="submit" className={BUTTON}>
                  {c.create}
                </button>
              </footer>
            </form>
          ))}
          <form action={importPostsAction} className={`${PANEL} flex flex-col gap-4 p-6 lg:col-span-2`}>
            <div className="flex flex-col gap-1">
              <h2 className="text-[15px] font-medium text-ink">{c.importTitle}</h2>
              <p className="text-[12px] leading-[1.5] text-muted">{c.importBody}</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_240px_auto] sm:items-end">
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium text-steel">{c.importLabel}</span>
                <input name="url" type="url" required placeholder="https://" className={FIELD} />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium text-steel">{c.channelLabel}</span>
                <select name="channelId" className={FIELD} defaultValue="">
                  <option value="">{c.noChannel}</option>
                  {channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.title}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className={BUTTON}>
                {c.importButton}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <section className={`${PANEL} flex flex-col`}>
        {items.length === 0 ? (
          <p className="px-6 py-10 text-center text-[12.5px] text-muted">{c.empty}</p>
        ) : (
          <table className="w-full text-left text-[12.5px]">
            <thead className="border-b border-line text-[11px] text-muted">
              <tr>
                {c.columns.map((column) => (
                  <th key={column} className="px-5 py-3 font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="px-5 py-3">
                    {item.kind === 'qa' ? (
                      <Link href={`/assets${item.publicId}`} className="font-medium text-ink hover:text-brandink">
                        {item.title}
                      </Link>
                    ) : (
                      <Link href={`/dashboard/posts/${item.id}`} className="font-medium text-ink hover:text-brandink">
                        {item.title}
                      </Link>
                    )}
                    <span className="block font-mono text-[11px] text-muted">{item.publicId}</span>
                  </td>
                  <td className="px-5 py-3 text-steel">
                    {kinds[item.kind] ?? item.kind} · {item.access === 'paid' ? c.paid : c.free}
                  </td>
                  <td className="px-5 py-3 text-steel">{item.channel?.title ?? '—'}</td>
                  <td className="px-5 py-3 text-steel">
                    {item.publishAt
                      ? fill(c.states.scheduled, { date: date.format(item.publishAt) })
                      : item.live
                        ? c.states.live
                        : c.states.draft}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
