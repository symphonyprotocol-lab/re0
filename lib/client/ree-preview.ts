'use client';

import { useEffect, useState } from 'react';
import { isUuid } from '@/lib/domain/list';
import type { PublicRee } from '@/lib/services/public-rees';

type PreviewFields = Pick<PublicRee, 'name' | 'description' | 'avatarBlob' | 'color' | 'category' | 'tags' | 'sampleQuestions'> & {
  queryFee: number | null;
};
type ReeIdentity = Pick<PublicRee, 'id' | 'ownerId'>;
type Snapshot = { ree: ReeIdentity; fields: PreviewFields; coverSrc: string | null };

/**
 * A Blob URL carries the snapshot to the preview page with no server write.
 * The preview opens in this tab by client-side navigation, so the document
 * that owns the Blob stays alive. Returns the preview's href.
 */
export function reePreviewHref(ree: ReeIdentity, fields: PreviewFields, cover: File | string | null) {
  const localCover = cover instanceof File ? URL.createObjectURL(cover) : null;
  const coverSrc = typeof cover === 'string' ? `/media/${cover}` : localCover;
  const snapshot: Snapshot = { ree: { id: ree.id, ownerId: ree.ownerId }, fields, coverSrc };
  const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot)], { type: 'application/json' }));
  const id = url.slice(url.lastIndexOf('/') + 1);
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
    if (localCover) URL.revokeObjectURL(localCover);
  }, 15 * 60_000);
  return `/rees/${ree.id}/preview?draft=${id}`;
}

/* Unsaved settings edits, kept in memory while the preview has this tab. */
const keptSettings = new Map<string, unknown>();

export function keepSettingsDraft<T>(reeId: string, draft: T) {
  keptSettings.set(reeId, draft);
}

export function keptSettingsDraft<T>(reeId: string) {
  return keptSettings.get(reeId) as T | undefined;
}

export function dropSettingsDraft(reeId: string) {
  keptSettings.delete(reeId);
}

export function useReePreviewDraft(draftId: string | undefined, { id, ownerId }: ReeIdentity) {
  const [result, setResult] = useState<Snapshot | 'unavailable' | null>(null);
  useEffect(() => {
    if (!draftId) return;
    const controller = new AbortController();
    const { signal } = controller;
    const prefix = `blob:${window.location.origin}/`;
    let localCover: string | null = null;

    async function load() {
      try {
        if (!isUuid(draftId)) throw new Error('Invalid preview reference');
        const response = await fetch(prefix + draftId, { signal });
        if (!response.ok) throw new Error('Missing preview');
        const draft = await response.json() as Snapshot;
        if (draft.ree.id !== id || draft.ree.ownerId !== ownerId) throw new Error('Preview mismatch');
        if (draft.coverSrc?.startsWith(prefix) && isUuid(draft.coverSrc.slice(prefix.length))) {
          const image = await fetch(draft.coverSrc, { signal });
          if (!image.ok) throw new Error('Missing preview cover');
          const file = await image.blob();
          if (signal.aborted) return;
          // The preview owns its copy, so the editor's URL can be revoked on its own schedule.
          localCover = URL.createObjectURL(file);
          draft.coverSrc = localCover;
        }
        if (!signal.aborted) setResult(draft);
      } catch {
        if (!signal.aborted) setResult('unavailable');
      }
    }
    void load();
    return () => {
      controller.abort();
      if (localCover) URL.revokeObjectURL(localCover);
    };
  }, [draftId, id, ownerId]);
  return result;
}
