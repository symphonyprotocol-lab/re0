import type { ReactNode } from 'react';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { ReeIdentityCover } from '@/components/rees/ree-identity-cover';
import type { IntroProps } from '@/lib/domain/video';

export function ReeCardCover({ ree, href, label, video, children }: {
  ree: { name: string; avatarBlob: string | null; coverBlob: string | null; color: string };
  href: string;
  label: string;
  video?: IntroProps | null;
  children?: ReactNode;
}) {
  return (
    <div className="ree-card-cover">
      <Link href={href} className="ree-card-cover-link" aria-label={label}>
        <ReeIdentityCover
          src={ree.coverBlob ? `/media/${ree.coverBlob}` : null}
          avatar={ree.avatarBlob}
          color={ree.color}
          video={video}
          compact
        />
        <span className="ree-card-cover-title">{ree.name}</span>
      </Link>
      {children}
    </div>
  );
}
