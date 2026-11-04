import type { Metadata } from 'next';
import { VIDEO_PAGE_SIZES } from '@/lib/constants';
import { param } from '@/lib/domain/list';
import { currentUser } from '@/lib/http/session';
import { listVideos } from '@/lib/services/video';
import { serverMessages } from '@/i18n/server';
import { Topbar } from '@/components/shell/topbar';
import { VideoLibrary } from '@/components/video/video-library';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.video.library.title };
}

/**
 * `/videos` (prototype `#/videos` "视频工作室"): every Ree of the owner with
 * its introduction -- generated ones play in a dialog -- and the way into
 * each editor. `q`, `size` (12 / 24 / 48) and `page` in the URL (8.1).
 */
export default async function VideosPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = (await currentUser())!;
  const search = await searchParams;
  const size = Number(param(search, 'size'));
  const page = Number(param(search, 'page'));
  const query = {
    q: param(search, 'q').trim().slice(0, 200),
    size: (VIDEO_PAGE_SIZES as readonly number[]).includes(size) ? size : VIDEO_PAGE_SIZES[0],
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
  const [{ t }, result] = await Promise.all([serverMessages(), listVideos(user.id, query)]);
  return (
    <>
      <Topbar crumbs={[{ label: t.rees.title, href: '/rees' }, { label: t.video.library.title }]} />
      <VideoLibrary result={JSON.parse(JSON.stringify(result))} q={query.q} />
    </>
  );
}
