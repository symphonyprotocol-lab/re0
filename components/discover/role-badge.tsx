'use client';

import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';

/**
 * 「认证」/「官方」 beside a Ree or its owner (rebuild-proposal.md 2.7,
 * prototype user-roles.css `.role-badge`). It reads the owner's current
 * `user.role`, so a revoked verification disappears everywhere at once; a
 * normal account shows nothing.
 */
export function RoleBadge({ role, className = '' }: { role: string | null | undefined; className?: string }) {
  const { t } = useI18n();
  if (role !== 'verified' && role !== 'official') return null;
  const label = t.discover.roles[role];
  return (
    <span
      title={fill(t.discover.roles.title, { role: label })}
      className={`ml-1.5 inline-flex flex-none items-center gap-[3px] rounded-[5px] border px-1.5 py-px align-middle text-[9px] leading-[1.5] font-semibold whitespace-nowrap ${
        role === 'official' ? 'border-[#e7defa] bg-[#f2edff] text-[#7255bd]' : 'border-[#dcecff] bg-[#edf5ff] text-[#1676d5]'
      } ${className}`}
    >
      <Icon name={role === 'official' ? 'globe' : 'shield'} className="size-[11px]" />
      {label}
    </span>
  );
}
