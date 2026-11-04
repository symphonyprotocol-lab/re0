import type { Metadata } from 'next';
import { REE_PAGE_SIZES } from '@/lib/constants';
import { param } from '@/lib/domain/list';
import { currentUser } from '@/lib/http/session';
import { listRees, reeTotals, REE_VISIBILITIES, type ReeSort, type ReeVisibility } from '@/lib/services/rees';
import { serverMessages } from '@/i18n/server';
import { Topbar } from '@/components/shell/topbar';
import { ReeList } from '@/components/rees/ree-list';
import { introsFor } from '@/lib/services/video';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.rees.title };
}

type Search = Record<string, string | string[] | undefined>;

/** Prototype URL: `q`, `visibility`, `sort=name|sources|answers` + `order`, `view=list`, `size`, `page`. */
function readQuery(search: Search) {
  const visibility = (REE_VISIBILITIES as readonly string[]).includes(param(search, 'visibility'))
    ? (param(search, 'visibility') as ReeVisibility)
    : 'all';
  const by = param(search, 'sort');
  const order = param(search, 'order');
  const sort: ReeSort =
    by === 'name' ? (order === 'desc' ? 'name_desc' : 'name_asc')
    : by === 'sources' ? (order === 'asc' ? 'sources_asc' : 'sources_desc')
    : by === 'answers' ? (order === 'asc' ? 'answers_asc' : 'answers_desc')
    : 'default';
  const size = Number(param(search, 'size'));
  const page = Number(param(search, 'page'));
  return {
    q: param(search, 'q').trim().slice(0, 200),
    visibility,
    sort,
    size: (REE_PAGE_SIZES as readonly number[]).includes(size) ? size : REE_PAGE_SIZES[0],
    page: Number.isInteger(page) && page > 0 ? page : 1,
    view: param(search, 'view') === 'list' ? ('list' as const) : ('cards' as const),
  };
}

export default async function ReesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = (await currentUser())!;
  const query = readQuery(await searchParams);
  const { t } = await serverMessages();
  const [result, totals] = await Promise.all([listRees(user.id, query), reeTotals(user.id)]);
  /* Step 7: the page's introductions, for the 16:9 covers and their play dialog. */
  const videos = Object.fromEntries(await introsFor(result.items.map((ree) => ree.id)));
  return (
    <>
      <Topbar crumbs={[{ label: t.rees.title }]} />
      <ReeList
        result={JSON.parse(JSON.stringify(result))}
        totals={totals}
        query={query}
        videos={videos}
      />
    </>
  );
}
