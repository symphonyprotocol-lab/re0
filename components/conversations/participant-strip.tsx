'use client';

import Link from 'next/link';
import { useI18n } from '@/i18n/client';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { Icon } from '@/components/ui/icons';
import { RoleBadge } from '@/components/discover/role-badge';
import type { Member } from '@/components/conversations/participant-picker';

/** The participants bar under the top bar: each Ree with its owner's role mark, and how many of five are in. */
export function ParticipantStrip({ members, max }: { members: Member[]; max: number }) {
  const { t } = useI18n();
  const r = t.conversations.room;
  return (
    <div className="flex min-w-0 items-center gap-2 px-2" role="group" aria-label={r.participants}>
      <Icon name="users" className="size-4 flex-none text-muted" />
      {members.length === 0 && <span className="text-[12px] text-muted">{r.noParticipants}</span>}
      {members.map((member) => (
        <Link
          key={member.id}
          href={member.isPublic ? `/r/${member.slug}` : `/rees/${member.id}/settings`}
          className="flex flex-none items-center gap-1.5 rounded-full border border-line bg-white py-0.5 pr-2.5 pl-0.5 text-[12px] hover:border-blue"
        >
          <ReeAvatar avatar={member.avatarBlob} color={member.color} size="sm" className="!size-6 !rounded-full [&_svg]:!size-3.5" />
          <span className="max-w-[140px] truncate">{member.name}</span>
          <RoleBadge role={member.role} className="!ml-0" />
        </Link>
      ))}
      <span className="flex-none font-mono text-[11px] text-muted">
        {members.length}/{max}
      </span>
    </div>
  );
}
