'use client';

import NextLink, { useLinkStatus } from 'next/link';
import type { ComponentProps } from 'react';
import { Icon, type IconName } from '@/components/ui/icons';
import { useI18n } from '@/i18n/client';
import { localizeHref } from '@/i18n/paths';

/**
 * Link status comes from Next so canceled and failed navigations cannot
 * leave a stale highlight. A link to a public page goes straight to its
 * URL in the page's language (i18n/paths.ts), not through the redirect;
 * one into the other language reloads (components/shell/locale-boundary.tsx).
 */
export function WorkspaceLink({ children, className = '', icon, href, ...props }: ComponentProps<typeof NextLink> & { icon?: IconName }) {
  const { locale } = useI18n();
  return (
    <NextLink {...props} href={typeof href === 'string' ? localizeHref(locale, href) : href} className={`workspace-link ${className}`}>
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
