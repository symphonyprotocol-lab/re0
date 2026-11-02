import { Icon } from '@/components/ui/icons';

/** The six default colors (prototype styles.css `.dot-avatar.*`). */
const COLORS: Record<string, string> = {
  default: 'bg-soft text-blue border-[#e0eafa]',
  lilac: 'bg-[#f1edfb] text-[#9275bf] border-[#e8e1f5]',
  sand: 'bg-[#f9f4ec] text-[#a18a60] border-[#eee7da]',
  sage: 'bg-[#eaf4f0] text-[#5b8e7e] border-[#dfebe5]',
  rose: 'bg-[#faf0f0] text-[#b47e81] border-[#f2e5e5]',
  slate: 'bg-[#edf0f6] text-[#7589a9] border-[#e0e6ef]',
};

const SIZES = {
  sm: 'size-8 rounded-[9px] [&_svg]:size-[18px]',
  md: 'size-11 rounded-xl [&_svg]:size-[23px]',
  lg: 'size-16 rounded-2xl [&_svg]:size-8',
  xl: 'size-24 rounded-3xl [&_svg]:size-12',
};

/** `avatars/…` pathnames are served by /media; anything else is an external URL (OAuth). */
export function imageUrl(avatar: string | null | undefined): string | null {
  if (!avatar) return null;
  return avatar.startsWith('avatars/') ? `/media/${avatar}` : avatar;
}

export function ReeAvatar({
  avatar,
  color,
  size = 'md',
  className = '',
}: {
  avatar?: string | null;
  color?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const src = imageUrl(avatar);
  return (
    <span
      className={`relative inline-flex flex-none items-center justify-center overflow-hidden border ${COLORS[color ?? 'default'] ?? COLORS.default} ${SIZES[size]} ${className}`}
      aria-hidden="true"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src ? <img src={src} alt="" className="size-full object-cover" /> : <Icon name="ree" />}
    </span>
  );
}

export function UserAvatar({ avatar, name, className = 'size-8' }: { avatar?: string | null; name: string; className?: string }) {
  const src = imageUrl(avatar);
  const initials = Array.from(name.trim()).slice(0, 2).join('').toUpperCase() || 'R';
  return (
    <span className={`inline-flex flex-none items-center justify-center overflow-hidden rounded-full bg-soft text-[11px] font-bold text-blue ${className}`} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src ? <img src={src} alt="" className="size-full object-cover" referrerPolicy="no-referrer" /> : initials}
    </span>
  );
}
