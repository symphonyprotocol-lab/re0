'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { useEffect } from 'react';
import { KnowledgePreview } from '@/components/knowledge/knowledge-preview';

/**
 * The preview on its own page: ← and → (outside a field) go to the previous
 * and next source, and the chosen page or file stays in the URL as `child`.
 */
export function KnowledgePreviewPage({
  reeId,
  knowledgeId,
  initialTime,
  initialChild,
  previousHref,
  nextHref,
}: {
  reeId: string;
  knowledgeId: string;
  initialTime: number | null;
  initialChild: number;
  previousHref: string | null;
  nextHref: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable="true"], audio, dialog')) return;
      const href = event.key === 'ArrowLeft' ? previousHref : event.key === 'ArrowRight' ? nextHref : null;
      if (!href) return;
      event.preventDefault();
      router.push(href);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previousHref, nextHref, router]);

  return (
    <KnowledgePreview
      reeId={reeId}
      knowledgeId={knowledgeId}
      layout="page"
      initialTime={initialTime}
      initialChild={initialChild}
      onChanged={() => router.refresh()}
      onChildChange={(index) => {
        const params = new URLSearchParams(search.toString());
        params.set('child', String(index));
        router.replace(`${pathname}?${params}`, { scroll: false });
      }}
    />
  );
}
