import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { currentUser } from '@/lib/http/session';
import { videoStudio, VideoError } from '@/lib/services/video';
import { serverMessages } from '@/i18n/server';
import { ReeTopbar } from '@/components/rees/ree-topbar';
import { VideoStudio } from '@/components/video/video-studio';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.video.title };
}

/**
 * `/rees/[id]/video` (rebuild-proposal.md 8.4 step 7, prototype
 * `#/dots/:id/video`): the Ree's 15-second introduction -- script, shots,
 * style, Player preview, export and sharing. Owner only.
 */
export default async function ReeVideoPage({ params }: { params: Promise<{ id: string }> }) {
  const user = (await currentUser())!;
  const studio = await videoStudio(user.id, (await params).id).catch((error) => {
    if (error instanceof VideoError && error.status === 404) return null;
    throw error;
  });
  if (!studio) notFound();
  const { ree, video, props, readySources, lastExport } = studio;
  return (
    <>
      <ReeTopbar ree={ree} active="video" />
      <VideoStudio
          ree={{ id: ree.id, name: ree.name, slug: ree.slug, avatarBlob: ree.avatarBlob, color: ree.color, isPublic: ree.isPublic && !ree.moderatedAt }}
          readySources={readySources}
          initial={{
            generated: video.generated,
            revision: video.revision,
            template: video.template,
            accentColor: video.accentColor,
            aspect: video.aspect,
            music: video.music,
            scenes: video.scenes,
            exportsCount: video.exportsCount,
          }}
          initialProps={props}
          lastExport={lastExport ? { url: lastExport.url, aspect: lastExport.aspect, cost: lastExport.cost, finishedAt: lastExport.finishedAt?.toISOString() ?? null, current: lastExport.current } : null}
      />
    </>
  );
}
