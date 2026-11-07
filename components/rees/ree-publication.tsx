'use client';

import { useState } from 'react';
import { useNavigationRouter } from '@/components/shell/navigation-provider';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { useToast } from '@/components/ui/toast';
import { Icon } from '@/components/ui/icons';
import './ree-publication.css';

type PublicationState = { isPublic: boolean; isPublished: boolean; moderatedAt?: Date | string | null };

export function ReePublicationStatus({ ree }: { ree: PublicationState }) {
  const { t } = useI18n();
  if (!ree.isPublic || ree.moderatedAt) return null;
  return (
    <span className={`ree-publication__status ${ree.isPublished ? 'is-published' : ''}`}>
      <span className="ree-publication__dot" aria-hidden="true" />
      {ree.isPublished ? t.rees.publication.published : t.rees.publication.unpublished}
    </span>
  );
}

/** Publication always uses saved settings and is separate from changing visibility. */
export function ReePublication({ ree, showStatus = true }: {
  ree: PublicationState & { id: string };
  showStatus?: boolean;
}) {
  const { t } = useI18n();
  const p = t.rees.publication;
  const router = useNavigationRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!ree.isPublic || ree.moderatedAt) return null;
  const toggle = async () => {
    setBusy(true);
    setError('');
    const result = await api<{ error?: string }>(`/api/rees/${ree.id}/publication`, { method: 'POST', json: { isPublished: !ree.isPublished } });
    setBusy(false);
    if (!result.ok) {
      setError(result.data.error === 'not_public' ? p.notPublic : result.data.error === 'moderated' ? p.moderated : t.common.errors.generic);
      return;
    }
    toast(ree.isPublished ? p.unpublishedDone : p.publishedDone);
    router.refresh();
  };
  return (
    <div className={`ree-publication ${ree.isPublished ? 'is-published' : 'is-unpublished'}`} aria-busy={busy}>
      {showStatus && <ReePublicationStatus ree={ree} />}
      <button type="button" className="ree-publication__button" disabled={busy} onClick={() => void toggle()}>
        <Icon name={ree.isPublished ? 'pause' : 'upload'} />
        {busy ? p.saving : ree.isPublished ? p.unpublish : p.publish}
      </button>
      {error && <span className="ree-publication__error" role="alert">{error}</span>}
    </div>
  );
}
