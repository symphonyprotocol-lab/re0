import type { ReactNode } from 'react';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { IntroCoverFrame } from '@/components/video/intro-cover-frame';
import type { IntroProps } from '@/lib/domain/video';
import './ree-identity-cover.css';

export function ReeIdentityCover({ src, avatar, color, video, alt = '', placeholder, compact = false, children }: {
  src: string | null;
  avatar: string | null;
  color: string;
  video?: IntroProps | null;
  alt?: string;
  placeholder?: string;
  compact?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`ree-identity-preview${compact ? ' ree-identity-preview-compact' : ''}`}>
      <div className="ree-identity-cover">
        {src ? <img src={src} alt={alt} loading={compact ? 'lazy' : undefined} />
          : video ? <IntroCoverFrame video={video} lazy={compact} />
          : placeholder && <span>{placeholder}</span>}
      </div>
      <div className="ree-identity-avatar-row">
        <div className="ree-identity-avatar">
          <ReeAvatar avatar={avatar} color={color} size={compact ? 'sm' : 'lg'} />
        </div>
        {children}
      </div>
    </div>
  );
}
