'use client';

import { useOptimistic, useTransition } from 'react';
import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { Icon } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { safeReturnTo } from '@/lib/domain/auth';

export function ReeFavoriteButton({ ree, favorite, returnTo, labeled = false }: {
  ree: { id: string; name: string };
  /** Omitted for visitors. */
  favorite?: boolean;
  returnTo: string;
  labeled?: boolean;
}) {
  const { t } = useI18n();
  const f = t.rees.favorite;
  const toast = useToast();
  const router = useRouter();
  const [selected, setSelected] = useOptimistic(Boolean(favorite));
  const [pending, start] = useTransition();
  const loginHref = `/login?returnTo=${encodeURIComponent(safeReturnTo(returnTo.length <= 512 ? returnTo : returnTo.split('?')[0]))}`;
  const className = labeled ? 'btn-secondary btn-sm shrink-0' : 'icon-btn';
  const icon = <Icon name="bookmark" className={selected ? 'size-4 fill-current' : 'size-4'} />;

  if (favorite === undefined) {
    const label = fill(f.signIn, { name: ree.name });
    return (
      <Link href={loginHref} className={className} aria-label={label} title={label}>
        {icon}{labeled && f.add}
      </Link>
    );
  }

  function toggle() {
    if (pending) return;
    const next = !selected;
    start(async () => {
      setSelected(next);
      try {
        const response = await fetch(`/api/rees/${ree.id}/favorite`, { method: next ? 'PUT' : 'DELETE' });
        if (response.status === 401) return router.push(loginHref);
        if (response.status === 404) return toast(f.unavailable);
        if (!response.ok) return toast(f.failed);
        toast(next ? f.added : f.removed);
        router.refresh();
      } catch {
        toast(f.failed);
      }
    });
  }

  return (
    <button
      type="button"
      className={`${className} aria-pressed:bg-soft! aria-pressed:text-blue!`}
      aria-label={fill(f.toggle, { name: ree.name })}
      aria-pressed={selected}
      aria-busy={pending || undefined}
      title={selected ? f.remove : f.add}
      disabled={pending}
      onClick={toggle}
    >
      {icon}{labeled && (selected ? f.saved : f.add)}
    </button>
  );
}
