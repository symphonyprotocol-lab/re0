'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useEffect, useRef, useState } from 'react';
import { AUDIO_MAX_SECONDS, KNOWLEDGE_URL_MAX, M4A_MAX_SECONDS } from '@/lib/constants';
import { holdFor, ADD_KNOWLEDGE_KINDS, audioFormat, audioProblem, validDocument, type AddKnowledgeKind } from '@/lib/domain/knowledge';
import { parseGithubRepo, parseWebUrl } from '@/lib/domain/sources';
import { api, uploadToBlob } from '@/lib/client/upload';
import { audioFileSeconds } from '@/lib/client/audio';
import { useI18n } from '@/i18n/client';
import { fill, formatBytes, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { Modal } from '@/components/knowledge/modal';
import { GithubRepositoryPicker } from '@/components/knowledge/github-repository-picker';
import { errorText, SOURCE_ICONS } from '@/components/knowledge/shared';

/** What a new source would reserve, from what the form holds so far (8.2). */
export function estimateFor(kind: AddKnowledgeKind, input: { bytes?: number }): number {
  if (kind === 'audio') return holdFor('audio', input.bytes ?? 0);
  return holdFor(kind);
}

/** The error a link can fix, with where to fix it. */
export function FixLink({ code }: { code: string | undefined }) {
  const { t } = useI18n();
  if (code === 'insufficient_credits') {
    return (
      <Link href="/settings?tab=balance" className="font-semibold underline">
        {t.chat.insufficient.topUp}
      </Link>
    );
  }
  if (code === 'github_not_connected' || code === 'domain_unverified') {
    return (
      <Link href="/settings?tab=connections" className="font-semibold underline">
        {code === 'github_not_connected' ? t.knowledge.addModal.connect : t.knowledge.addModal.verify}
      </Link>
    );
  }
  return null;
}

/**
 * "给 Ree 一些知识。" -- the five source choices: documents and audio go
 * straight to Blob and are then submitted, repositories, pages and websites
 * by URL. The estimate is the initial reservation; the real price is
 * settled after processing. Opened inside a folder, the source lands there.
 */
export function AddKnowledgeModal({
  open,
  reeId,
  folder,
  onClose,
  onAdded,
}: {
  open: boolean;
  reeId: string;
  folder?: { id: string; name: string } | null;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { t, locale } = useI18n();
  const m = t.knowledge.addModal;
  const [kind, setKind] = useState<AddKnowledgeKind>('document');
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<{ text: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /* The knowledge POST is on the wire: it cannot be taken back, so the dialog stays open until it answers. */
  const [registering, setRegistering] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  /* The submission in flight: Cancel, Escape and reset abort it, so nothing is uploaded or registered after. */
  const submission = useRef<AbortController | null>(null);
  useEffect(() => () => submission.current?.abort(), []);
  const [dragging, setDragging] = useState(false);
  /* Bumped by every pick, reset and kind change: an audio length read late is dropped. */
  const picking = useRef(0);
  /* The error sits below the cost note; bring it into view in the scrolling dialog. */
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [error]);
  const [githubStatus, setGithubStatus] = useState<'checking' | 'connected' | 'disconnected' | 'unavailable'>('checking');
  const [githubAccessUrl, setGithubAccessUrl] = useState('');
  useEffect(() => {
    if (!open || kind !== 'github' || githubStatus !== 'checking') return;
    let live = true;
    void api<{ connection?: { login: string } | null; repositoryAccess?: { url: string } }>('/api/auth/github/connect').then(
      (result) => {
        if (!live) return;
        if (!result.ok || result.data.connection === undefined) setGithubStatus('unavailable');
        else {
          setGithubStatus(result.data.connection ? 'connected' : 'disconnected');
          setGithubAccessUrl(result.data.repositoryAccess?.url ?? '/settings?tab=connections');
        }
      },
      () => {
        if (live) setGithubStatus('unavailable');
      },
    );
    return () => {
      live = false;
    };
  }, [open, kind, githubStatus]);

  /* A website needs a verified domain: the owner sees which before submitting (prototype app.js "已验证："). */
  const [domains, setDomains] = useState<string[] | null>(null);
  useEffect(() => {
    if (!open || kind !== 'site' || domains !== null) return;
    let live = true;
    void api<{ items?: { domain: string; status: string }[] }>('/api/domains').then((result) => {
      if (live && result.ok) setDomains((result.data.items ?? []).filter((item) => item.status === 'verified').map((item) => item.domain));
    });
    return () => {
      live = false;
    };
  }, [open, kind, domains]);

  const reset = () => {
    submission.current?.abort();
    submission.current = null;
    picking.current += 1;
    setFile(null);
    setConsent(false);
    setUrl('');
    setError(null);
    setBusy(false);
    setRegistering(false);
    setProgress(null);
    setGithubStatus('checking');
  };
  const close = () => {
    if (registering) return;
    reset();
    setDomains(null);
    onClose();
  };
  const choose = (next: AddKnowledgeKind) => {
    if (next !== kind) setGithubStatus('checking');
    picking.current += 1;
    setKind(next);
    setFile(null);
    setError(null);
  };

  const fileKind = kind === 'document' || kind === 'audio';
  const urlKind = kind === 'github' || kind === 'page' || kind === 'site';
  const githubBlocked = kind === 'github' && githubStatus !== 'connected';
  const pick = async (picked: File | undefined) => {
    if (!picked) return;
    const ticket = ++picking.current;
    let problem: 'invalid_document' | 'invalid_audio' | 'm4a_too_long' | 'audio_too_long' | null =
      kind === 'audio' ? audioProblem(picked.name, picked.size) : validDocument(picked.name, picked.size) ? null : 'invalid_document';
    /* Length limits are refused here rather than after the upload: M4A is one call, any audio at most three hours. */
    if (!problem && kind === 'audio') {
      setFile(null);
      const seconds = await audioFileSeconds(picked);
      if (ticket !== picking.current) return;
      if (seconds !== null && audioFormat(picked.name) === 'm4a' && seconds > M4A_MAX_SECONDS) problem = 'm4a_too_long';
      else if (seconds !== null && seconds > AUDIO_MAX_SECONDS) problem = 'audio_too_long';
    }
    setError(problem ? { text: t.knowledge.errors[problem], code: problem } : null);
    setFile(problem ? null : picked);
  };

  const submit = async () => {
    if (busy || githubBlocked) return;
    setError(null);
    let body: Record<string, unknown>;
    const controller = new AbortController();
    const { signal } = controller;
    if (fileKind) {
      if (!file) return setError({ text: t.knowledge.errors[kind === 'audio' ? 'invalid_audio' : 'invalid_document'] });
      if (kind === 'audio' && !consent) return setError({ text: t.knowledge.errors.consent_required });
      submission.current = controller;
      setBusy(true);
      setProgress(0);
      const uploaded = await uploadToBlob(file, { purpose: kind, fileName: file.name, size: file.size }, (percent) => !signal.aborted && setProgress(percent), signal);
      /* Cancelled while uploading: the dialog was reset already; nothing is registered. */
      if (signal.aborted) return;
      setProgress(null);
      if ('error' in uploaded) {
        setBusy(false);
        const code = uploaded.error;
        /* The upload-token route's own limit, not a source's: `rate_limited` among the processing errors means the latter. */
        if (code === 'rate_limited') return setError({ text: t.knowledge.uploadRateLimited });
        return setError(code in t.knowledge.errors ? { text: errorText(t, code), code } : { text: t.reeSetup.messages.upload });
      }
      body = { kind, blobPath: uploaded.pathname, fileName: file.name, consent };
    } else if (urlKind) {
      const ok = kind === 'github' ? parseGithubRepo(url) : parseWebUrl(url);
      if (!ok) return setError({ text: t.knowledge.errors[kind === 'github' ? 'invalid_github_url' : 'invalid_url'] });
      submission.current = controller;
      setBusy(true);
      body = { kind, url: url.trim() };
    } else {
      return;
    }
    if (signal.aborted) return;
    setRegistering(true);
    const result = await api<{ id?: string; error?: string }>(`/api/rees/${reeId}/knowledge`, { method: 'POST', json: { ...body, folderId: folder?.id ?? null } });
    if (submission.current === controller) submission.current = null;
    setRegistering(false);
    setBusy(false);
    if (result.ok) {
      reset();
      onAdded();
      return;
    }
    const code = result.status === 402 ? 'insufficient_credits' : result.data.error;
    if (code === 'github_not_connected') {
      setGithubStatus('disconnected');
      return;
    }
    setError({ text: errorText(t, code), code });
  };

  const estimate = estimateFor(kind, { bytes: file?.size });

  return (
    <Modal
      open={open}
      onClose={close}
      className="add-knowledge-modal"
      title={m.title}
      subtitle={folder ? fill(m.folder, { folder: folder.name }) : m.subtitle}
      footer={
        <>
          <button type="button" className="btn secondary" onClick={close} disabled={registering}>
            {t.common.actions.cancel}
          </button>
          <button type="submit" form="knowledge-form" className="btn" disabled={busy || githubBlocked}>
            {busy && <i className="spinner" />}
            {progress !== null ? fill(m.uploading, { percent: progress }) : m.submit}
          </button>
        </>
      }
    >
      <div className="type-grid" role="radiogroup">
        {ADD_KNOWLEDGE_KINDS.map((value) => (
          <button key={value} type="button" role="radio" aria-checked={kind === value} className={`type-choice ${kind === value ? 'active' : ''}`} onClick={() => choose(value)}>
            <Icon name={SOURCE_ICONS[value]} />
            {t.common.kinds[value]}
          </button>
        ))}
      </div>
      <form
        id="knowledge-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="add-knowledge-source">
          {fileKind && (
            <>
              <label
                className={`dropzone ${dragging ? 'dragover' : ''}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  void pick(event.dataTransfer.files?.[0]);
                }}
              >
                <Icon name={kind === 'audio' ? 'audio' : 'upload'} />
                <strong>{file ? file.name : m.drop}</strong>
                <small>{file ? formatBytes(file.size) : m.limits[kind]}</small>
                <input
                  type="file"
                  accept={kind === 'audio' ? '.mp3,.m4a,.wav' : '.pdf,.docx,.md,.txt'}
                  onChange={(event) => {
                    void pick(event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
              </label>
              {kind === 'audio' && (
                <label className="check-row" style={{ fontSize: 10 }}>
                  <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
                  {m.consent}
                </label>
              )}
            </>
          )}

          {kind === 'github' && !githubBlocked && (
            <GithubRepositoryPicker url={url} accessUrl={githubAccessUrl} onSelect={setUrl} />
          )}
          {urlKind && !githubBlocked && (
            <div className="field">
              <label htmlFor="source-url">{m.urlLabel[kind]}</label>
              <input id="source-url" type="url" inputMode="url" maxLength={KNOWLEDGE_URL_MAX} value={url} placeholder={m.urlPlaceholder[kind]} onChange={(event) => setUrl(event.target.value)} />
            </div>
          )}
          {urlKind && kind !== 'site' && !githubBlocked && <p className="form-hint">{m.urlHint[kind]}</p>}
          {githubBlocked && (
            <div className="info-strip">
              <Icon name="github" />
              <div>
                <div role="status">
                  {githubStatus === 'checking' ? m.githubChecking : githubStatus === 'unavailable' ? m.githubUnavailable : m.githubRequired}
                </div>
                {githubStatus === 'disconnected' && <FixLink code="github_not_connected" />}
                {githubStatus === 'unavailable' && (
                  <button type="button" className="text-link" onClick={() => setGithubStatus('checking')}>
                    {t.common.actions.retry}
                  </button>
                )}
              </div>
            </div>
          )}
          {kind === 'site' && (
            <div className="info-strip">
              <Icon name="shield" />
              <span>
                {m.urlHint.site}
                <br />
                {domains === null ? '' : domains.length ? fill(m.verifiedDomains, { domains: domains.join(', ') }) : m.noVerifiedDomains}{' '}
                <Link href="/settings?tab=connections" className="text-link">
                  {m.verify}
                  <Icon name="arrow" />
                </Link>
              </span>
            </div>
          )}
        </div>

        {!githubBlocked && (
          <>
            <div className="estimate">
              <span>{m.estimate}</span>
              <strong>{fill(m.estimateValue, { credits: formatNumber(estimate, locale) })}</strong>
            </div>
            <p className="form-hint mt16" style={{ fontSize: 11 }}>
              {m.note}
            </p>
          </>
        )}
        {error && (
          <p ref={errorRef} role="alert" className="form-error">
            {error.text} <FixLink code={error.code} />
          </p>
        )}
      </form>
    </Modal>
  );
}
