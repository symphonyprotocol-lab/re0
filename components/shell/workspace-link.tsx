'use client';

import NextLink, { useLinkStatus } from 'next/link';
import type { ComponentProps } from 'react';
import { Icon, type IconName } from '@/components/ui/icons';
import { useLocaleHref } from '@/i18n/client';

/**
 * Link status comes from Next so canceled and failed navigations cannot
 * leave a stale highlight. A link to a public page goes straight to its
 * URL in the page's language (i18n/paths.ts), not through the redirect.
 */
export function WorkspaceLink({ children, className = '', icon, href, onClick, ...props }: ComponentProps<typeof NextLink> & { icon?: IconName }) {
  const target = useLocaleHref()(typeof href === 'string' ? href : '');
  return (
    <NextLink
      {...props}
      href={typeof href === 'string' ? target.href : href}
      onClick={(event) => {
        onClick?.(event);
        /* A page in another language needs a fresh root layout (useLocaleHref); modified clicks keep their default. */
        if (target.reload && !event.defaultPrevented && event.button === 0 && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) {
          event.preventDefault();
          window.location.assign(target.href);
        }
      }}
      className={`workspace-link ${className}`}
    >
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
