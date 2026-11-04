'use client';

import NextLink, { useLinkStatus } from 'next/link';
import type { ComponentProps } from 'react';
import { Icon, type IconName } from '@/components/ui/icons';

/** Link status comes from Next so canceled and failed navigations cannot leave a stale highlight. */
export function WorkspaceLink({ children, className = '', icon, ...props }: ComponentProps<typeof NextLink> & { icon?: IconName }) {
  return (
    <NextLink {...props} className={`workspace-link ${className}`}>
      {icon ? <IconLinkContent icon={icon}>{children}</IconLinkContent> : <>{children}<LinkFeedback /></>}
    </NextLink>
  );
}

/** Tabs swap their icon for a spinner without changing their label or width. */
function IconLinkContent({ icon, children }: { icon: IconName; children: ComponentProps<typeof NextLink>['children'] }) {
  const { pending } = useLinkStatus();
  return (
    <>
      <span className="workspace-link-icon" aria-hidden="true">
        <Icon name={icon} className="" />
        <span className="workspace-link-progress" data-pending={pending} />
      </span>
      {children}
    </>
  );
}

function LinkFeedback() {
  const { pending } = useLinkStatus();
  return <span className="workspace-link-progress" data-pending={pending} aria-hidden="true" />;
}
