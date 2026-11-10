'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PREVIEW_CHILDREN_PAGE_SIZE, TRASH_RETENTION_DAYS } from '@/lib/constants';
import { locatorLabel, type Locator } from '@/lib/domain/answer';
import type { KnowledgeActivity, KnowledgeChild, KnowledgeKind } from '@/lib/domain/knowledge';
import { api } from '@/lib/client/upload';
import { latestRequest } from '@/lib/client/latest';
import { useI18n } from '@/i18n/client';
import { fill, formatBytes, formatDateTime, formatNumber } from '@/i18n/format';
import { Icon, type IconName } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { StatusBadge, failureLabel } from '@/components/knowledge/status-badge';
import { KnowledgeDialogs, reprocessCost, type ActionItem, type Dialog } from '@/components/knowledge/knowledge-dialogs';
import { activityLabel, clock, highlight, Switch } from '@/components/knowledge/shared';

export interface KnowledgeDetail {
  id: string;
  title: string;
  originalTitle: string;
  kind: KnowledgeKind;
  status: string;
  error: string | null;
  enabled: boolean;
  folderId: string | null;
  folderName: string | null;
  source: string | null;
  fileName: string | null;
  fileSize: number | null;
  chars: number;
  content: string | null;
  children: KnowledgeChild[];
  activity: KnowledgeActivity[];
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  chunks: { id: string; ordinal: number; content: string; locator: Locator }[];
  chunkTotal: number;
}

type Tab = 'content' | 'chunks' | 'activity' | 'original';

/** Markdown-ish text as headings and paragraphs, with matches marked (prototype `plain`, `.kp-document`). */
function Document({ title, text, find }: { title?: string; text: string; find: string }) {
  return (
    <article className="kp-document">
      {title && <h2>{title}</h2>}
      {text.split('\n').map((line, index) => {
        if (line.startsWith('### ')) return <h4 key={index}>{highlight(line.slice(4), find)}</h4>;
        if (line.startsWith('## ')) return <h3 key={index}>{highlight(line.slice(3), find)}</h3>;
        if (line.startsWith('# ')) return <h2 key={index}>{highlight(line.slice(2), find)}</h2>;
        if (!line.trim()) return <div key={index} className="kp-paragraph-gap" />;
        return <p key={index}>{highlight(line, find)}</p>;
      })}
    </article>
  );
}

/** A repository file with line numbers (prototype `.kp-code`). */
function Code({ text, find }: { text: string; find: string }) {
  return (
    <div className="kp-code">
      {text.split('\n').map((line, index) => (
        <div key={index}>
          <span className="mono">{index + 1}</span>
          <code>{highlight(line, find)}</code>
        </div>
      ))}
    </div>
  );
}

/**
 * One source, owner only: "内容预览 / 检索片段 / 处理记录" (and the original
 * PDF or audio), find-in-content with highlighted matches, a website's pages
 * and a repository's files with their own search and 30-per-page directory,
 * an audio transcript whose timestamps seek the player, and the source's
 * details and actions. Polls while the source processes.
 */
export function KnowledgePreview({
  reeId,
  knowledgeId,
  initialTime,
  initialChild,
  onChanged,
  onChildChange,
}: {
  reeId: string;
  knowledgeId: string;
  /** Where it is shown; the prototype's CSS lays out both the same way (`.kp-page-card` / `.kp-modal`). */
  layout: 'page' | 'modal';
  /** Seconds to start the audio at (a citation's `?t=`). */
  initialTime?: number | null;
  initialChild?: number;
  /** Something about the source changed (renamed, moved, paused, trashed…). */
  onChanged?: () => void;
  onChildChange?: (index: number) => void;
}) {
  const { t, locale } = useI18n();
  const k = t.knowledge;
  const toast = useToast();
  const [detail, setDetail] = useState<KnowledgeDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [tab, setTab] = useState<Tab>('content');
  const [find, setFind] = useState('');
  const [hit, setHit] = useState(0);
  const [matches, setMatches] = useState(0);
  const [childQ, setChildQ] = useState('');
  const [childPage, setChildPage] = useState(1);
  const [child, setChild] = useState(initialChild ?? 0);
  const [childText, setChildText] = useState<string | null>(null);
  const [activeTime, setActiveTime] = useState<number | null>(initialTime ?? null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const seeded = useRef(false);
  /* A seek asked for before the audio's metadata arrived; applied when it does. */
  const pendingSeek = useRef<number | null>(null);

  /* The 3-second poll and a reload after an action can overlap: only the newest answer lands (review C11). */
  const [detailRequest] = useState(latestRequest);
  const load = useCallback(async () => {
    const current = detailRequest();
    const result = await api<{ knowledge: KnowledgeDetail }>(`/api/rees/${reeId}/knowledge/${knowledgeId}`);
    if (!current()) return;
    if (result.ok) setDetail(result.data.knowledge);
    else if (result.status === 404) setMissing(true);
  }, [reeId, knowledgeId, detailRequest]);

  useEffect(() => {
    setDetail(null);
    setMissing(false);
    setTab('content');
    setFind('');
    setChildQ('');
    setChildPage(1);
    setChild(initialChild ?? 0);
    setChildText(null);
    seeded.current = false;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the source changes
  }, [load]);

  const busy = detail?.status === 'pending' || detail?.status === 'processing';
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [busy, load]);

  const perChild = detail?.kind === 'site' || detail?.kind === 'github';
  useEffect(() => {
    if (!detail || !perChild || detail.status !== 'ready' || detail.children.length === 0) return;
    const index = Math.min(child, detail.children.length - 1);
    setChildText(null);
    let live = true;
    void api<{ content: string }>(`/api/rees/${reeId}/knowledge/${knowledgeId}?child=${index}`).then((result) => live && result.ok && setChildText(result.data.content));
    return () => {
      live = false;
    };
  }, [detail, perChild, child, reeId, knowledgeId]);

  /* Count the marks after each render of the content, and keep the current one in view. */
  useEffect(() => {
    const marks = contentRef.current?.querySelectorAll('mark[data-match]') ?? [];
    setMatches(find ? marks.length : 0);
    marks.forEach((mark, index) => mark.classList.toggle('current', index === hit));
  });

  /* A citation's timestamp: once the transcript is there, seek and show the segment. */
  useEffect(() => {
    if (seeded.current || !detail || detail.kind !== 'audio' || initialTime == null) return;
    seeded.current = true;
    const audio = audioRef.current;
    if (audio && audio.readyState >= 1) audio.currentTime = initialTime;
    else pendingSeek.current = initialTime;
    contentRef.current?.querySelector(`[data-time="${segmentAt(detail.children, initialTime)}"]`)?.scrollIntoView({ block: 'center' });
  }, [detail, initialTime]);

  const item: ActionItem | null = detail
    ? { id: detail.id, title: detail.title, kind: detail.kind, status: detail.status, enabled: detail.enabled, folderId: detail.folderId, fileSize: detail.fileSize, chars: detail.chars, deletedAt: detail.deletedAt }
    : null;

  const toggle = async () => {
    if (!detail) return;
    const result = await api<{ knowledge: KnowledgeDetail }>(`/api/rees/${reeId}/knowledge/${detail.id}`, { method: 'PATCH', json: { enabled: !detail.enabled } });
    if (result.ok) {
      setDetail(result.data.knowledge);
      toast(fill(k.done.scope, { n: 1 }));
      onChanged?.();
    }
  };

  const filteredChildren = useMemo(() => {
    if (!detail) return [];
    const needle = childQ.toLowerCase();
    return detail.children.map((entry, index) => ({ ...entry, index })).filter((entry) => !needle || `${entry.label} ${entry.url ?? ''} ${entry.path ?? ''}`.toLowerCase().includes(needle));
  }, [detail, childQ]);

  const n = (value: number) => formatNumber(value, locale);
  const fileUrl = `/api/rees/${reeId}/knowledge/${knowledgeId}/file`;
  const isPdf = detail?.kind === 'document' && /\.pdf$/i.test(detail.fileName ?? '');
  const tabs: Tab[] = ['content', 'chunks', 'activity', ...(isPdf || detail?.kind === 'audio' ? (['original'] as const) : [])];

  if (missing) {
    return (
      <div className="kp-status-state">
        <Icon name="file" />
        <h3>{k.page.missingTitle}</h3>
        <p>{k.page.missingBody}</p>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="kp-status-state">
        <i className="spinner" />
      </div>
    );
  }

  let body: ReactNode;
  if (busy && tab !== 'activity') {
    body = (
      <div className="kp-status-state">
        <i className="spinner" />
        <h3>{k.busyTitle}</h3>
        <p>{k.busyBody}</p>
        <div className="kp-processing-steps">
          <span>
            <Icon name="check" />
            {k.busySteps.added}
          </span>
          <span className="active">
            <i className="spinner" />
            {k.busySteps.working}
          </span>
          <span>{k.busySteps.waiting}</span>
        </div>
      </div>
    );
  } else if (detail.status === 'failed' && tab !== 'activity') {
    body = (
      <div className="kp-status-state failed">
        <Icon name="info" />
        <h3>{k.failedTitle}</h3>
        <p>{failureLabel(t, detail.error)}</p>
        {!detail.deletedAt && (
          <button type="button" className="btn secondary sm" onClick={() => item && setDialog({ type: 'confirm', action: 'reprocess', items: [item] })}>
            <Icon name="refresh" />
            {fill(k.retry, { credits: n(reprocessCost(item!)) })}
          </button>
        )}
        <small>{k.failedBody}</small>
      </div>
    );
  } else if (tab === 'original') {
    body =
      detail.kind === 'audio' ? (
        <audio controls src={fileUrl} className="kp-audio-player" aria-label={k.audio.player} />
      ) : (
        <iframe src={fileUrl} title={detail.title} className="kp-pdf-frame" />
      );
  } else if (tab === 'chunks') {
    body = (
      <div className="kp-chunks">
        <div className="kp-content-intro">
          <h3>{k.chunksTitle}</h3>
          <p>{k.chunksBody}</p>
        </div>
        {detail.chunks.map((chunk) => (
          <article key={chunk.id}>
            <div>
              <span className="mono">{fill(k.chunk, { n: String(chunk.ordinal + 1).padStart(3, '0') })}</span>
              <span>{[locatorLabel(chunk.locator, locale), `${n(chunk.content.length)} ${t.common.units.chars}`].filter(Boolean).join(' · ')}</span>
            </div>
            <p>{highlight(chunk.content, find)}</p>
          </article>
        ))}
        {detail.chunkTotal > detail.chunks.length && <p className="demo-label">{fill(k.chunksMore, { shown: n(detail.chunks.length), total: n(detail.chunkTotal) })}</p>}
      </div>
    );
  } else if (tab === 'activity') {
    body = (
      <div className="kp-activity">
        <h3>{k.activityTitle}</h3>
        {[...detail.activity].reverse().map((entry, index) => (
          <div key={`${entry.at}-${index}`} className={entry.code === 'failed' ? 'failed' : ''}>
            <Icon name={entry.code === 'failed' ? 'close' : 'check'} />
            <span>
              <strong>{activityLabel(t, locale, entry)}</strong>
              <small>{formatDateTime(entry.at, locale)}</small>
            </span>
          </div>
        ))}
      </div>
    );
  } else if (perChild) {
    const pages = Math.max(1, Math.ceil(filteredChildren.length / PREVIEW_CHILDREN_PAGE_SIZE));
    const page = Math.min(childPage, pages);
    const selected = detail.children[Math.min(child, detail.children.length - 1)];
    body = (
      <div className="kp-collection">
        <aside>
          <div className="kp-child-count">
            <Icon name={detail.kind === 'site' ? 'globe' : 'github'} />
            <strong>{fill(detail.kind === 'site' ? k.children.pages : k.children.files, { n: n(detail.children.length) })}</strong>
          </div>
          <div className="kp-child-search">
            <Icon name="search" />
            <input
              aria-label={k.children.findLabel}
              value={childQ}
              placeholder={k.children.find}
              onChange={(event) => {
                setChildQ(event.target.value);
                setChildPage(1);
              }}
            />
          </div>
          <div className="kp-child-list">
            {filteredChildren.slice((page - 1) * PREVIEW_CHILDREN_PAGE_SIZE, page * PREVIEW_CHILDREN_PAGE_SIZE).map((entry) => (
              <button
                key={entry.index}
                type="button"
                className={`kp-child ${entry.index === child ? 'active' : ''}`}
                title={entry.path ?? entry.url ?? entry.label}
                aria-pressed={entry.index === child}
                onClick={() => {
                  setChild(entry.index);
                  setHit(0);
                  onChildChange?.(entry.index);
                }}
              >
                <Icon name={detail.kind === 'site' ? 'file' : 'code'} />
                <span>{highlight(entry.path ?? entry.label, childQ)}</span>
              </button>
            ))}
            {filteredChildren.length === 0 && <p className="kp-child-empty">{k.children.empty}</p>}
          </div>
          {filteredChildren.length > PREVIEW_CHILDREN_PAGE_SIZE && (
            <div className="ks-side-pager">
              <button type="button" className="icon-btn flip" disabled={page <= 1} onClick={() => setChildPage(page - 1)} aria-label={k.children.previous}>
                <Icon name="chevronRight" />
              </button>
              <span>
                {page} / {pages}
              </span>
              <button type="button" className="icon-btn" disabled={page >= pages} onClick={() => setChildPage(page + 1)} aria-label={k.children.next}>
                <Icon name="chevronRight" />
              </button>
            </div>
          )}
        </aside>
        <div className="kp-child-content">
          {selected && (
            <div className="kp-child-location">
              <Icon name={detail.kind === 'site' ? 'globe' : 'code'} />
              {selected.url ? (
                <a href={selected.url} target="_blank" rel="noreferrer noopener">
                  {selected.url}
                </a>
              ) : (
                <span>{selected.path}</span>
              )}
            </div>
          )}
          {childText === null ? (
            <div className="kp-status-state">
              <i className="spinner" />
            </div>
          ) : detail.kind === 'github' ? (
            <Code text={childText} find={find} />
          ) : (
            <Document title={selected?.label} text={childText} find={find} />
          )}
        </div>
      </div>
    );
  } else if (detail.kind === 'audio') {
    const content = detail.content ?? '';
    const current = activeTime === null ? null : segmentAt(detail.children, activeTime);
    body = (
      <div className="kp-audio">
        <div className="kp-audio-heading">
          <Icon name="audio" />
          <div>
            <strong>{detail.title}</strong>
            <small>
              {clock(detail.children.at(-1)?.end ?? 0)} · {k.audio.transcript}
            </small>
          </div>
        </div>
        <audio
          ref={audioRef}
          id="kp-audio-player"
          className="kp-audio-player"
          controls
          preload="metadata"
          src={fileUrl}
          aria-label={k.audio.player}
          onTimeUpdate={(event) => setActiveTime(event.currentTarget.currentTime)}
          onLoadedMetadata={(event) => {
            if (pendingSeek.current === null) return;
            event.currentTarget.currentTime = pendingSeek.current;
            pendingSeek.current = null;
          }}
        />
        <div className="kp-transcript">
          {detail.children.map((segment) => (
            <div key={segment.offset} data-time={segment.time} className={current === segment.time ? 'active' : ''}>
              <button
                type="button"
                className="mono"
                aria-label={fill(k.audio.seek, { time: clock(segment.time ?? 0) })}
                onClick={() => {
                  const audio = audioRef.current;
                  if (audio && audio.readyState >= 1) audio.currentTime = segment.time ?? 0;
                  else pendingSeek.current = segment.time ?? 0;
                  void audio?.play().catch(() => undefined);
                  setActiveTime(segment.time ?? 0);
                }}
              >
                {clock(segment.time ?? 0)}
              </button>
              <p>{highlight(content.slice(segment.offset, segment.offset + segment.length), find)}</p>
            </div>
          ))}
        </div>
      </div>
    );
  } else {
    body = (
      <div className="kp-document-wrap">
        {isPdf && (
          <div className="kp-page-label">
            <Icon name="file" />
            {k.extracted}
          </div>
        )}
        {detail.content ? <Document text={detail.content} find={find} /> : <p className="demo-label">{k.contentEmpty}</p>}
      </div>
    );
  }

  const actionButton = (icon: IconName, label: string, onClick: () => void, disabled = false) => (
    <button type="button" className="btn secondary sm" disabled={disabled} onClick={onClick}>
      <Icon name={icon} />
      {label}
    </button>
  );

  return (
    <div className="kp-root" data-knowledge-preview={detail.id}>
      <div className="kp-toolbar">
        <div className="kp-tabs">
          {tabs.map((value) => (
            <button key={value} type="button" className={`kp-tab ${tab === value ? 'active' : ''}`} aria-pressed={tab === value} onClick={() => setTab(value)}>
              {k.previewTabs[value]}
            </button>
          ))}
        </div>
        <div className="kp-find">
          <Icon name="search" />
          <input
            aria-label={k.findLabel}
            value={find}
            placeholder={k.find}
            onChange={(event) => {
              setFind(event.target.value);
              setHit(0);
            }}
          />
          <span id="kp-match-count">{find ? fill(k.matches, { count: matches }) : ''}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label={k.nextMatch}
            title={k.nextMatch}
            onClick={() => {
              if (!matches) return;
              const next = (hit + 1) % matches;
              setHit(next);
              contentRef.current?.querySelectorAll('mark[data-match]')[next]?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
            }}
          >
            <Icon name="chevronDown" />
          </button>
        </div>
      </div>
      <div className="kp-workspace">
        <div ref={contentRef} className="kp-content" id="kp-content">
          {body}
        </div>
        <aside className="kp-details">
          <div className="between">
            <h3>{k.details.title}</h3>
            <StatusBadge status={detail.status} />
          </div>
          {detail.deletedAt ? (
            <div className="kp-trash-notice">
              <Icon name="trash" />
              {fill(k.details.inTrash, { days: Math.max(0, TRASH_RETENTION_DAYS - Math.floor((Date.now() - new Date(detail.deletedAt).getTime()) / 86_400_000)) })}
            </div>
          ) : (
            <div className="kp-scope">
              <div>
                <strong>{k.details.scope}</strong>
                <p>{detail.enabled ? k.details.scopeOn : k.details.scopeOff}</p>
              </div>
              <Switch checked={detail.enabled} label={k.details.scopeToggle} onChange={toggle} />
            </div>
          )}
          <dl>
            <dt>{k.details.folder}</dt>
            <dd>{detail.folderName ?? k.folders.unfiled}</dd>
            <dt>{k.details.type}</dt>
            <dd>{t.common.kinds[detail.kind]}</dd>
            {detail.fileName && (
              <>
                <dt>{k.details.fileName}</dt>
                <dd title={detail.fileName}>{detail.fileName}</dd>
              </>
            )}
            {detail.fileSize !== null && (
              <>
                <dt>{k.details.fileSize}</dt>
                <dd>{formatBytes(detail.fileSize)}</dd>
              </>
            )}
            <dt>{k.details.source}</dt>
            <dd>
              {detail.source ? (
                <a href={detail.source} target="_blank" rel="noreferrer noopener">
                  {detail.source}
                </a>
              ) : (
                k.details.sourceUpload
              )}
            </dd>
            <dt>{k.details.saved}</dt>
            <dd>
              {n(detail.chars)} {t.common.units.chars}
            </dd>
            <dt>{k.details.chunks}</dt>
            <dd>{n(detail.chunkTotal)}</dd>
            <dt>{k.details.created}</dt>
            <dd>{formatDateTime(detail.createdAt, locale)}</dd>
            <dt>{k.details.updated}</dt>
            <dd>{formatDateTime(detail.updatedAt, locale)}</dd>
          </dl>
          <div className="kp-detail-actions">
            {actionButton('copy', k.details.copyLink, async () => {
              await navigator.clipboard.writeText(`${window.location.origin}/rees/${reeId}/knowledge/${detail.id}`);
              toast(k.done.linkCopied);
            })}
            {(detail.kind === 'document' || detail.kind === 'audio') && (
              <a className="btn secondary sm" href={`${fileUrl}?download=1`}>
                <Icon name="download" />
                {k.details.downloadOriginal}
              </a>
            )}
            {detail.status === 'ready' && (
              <a className="btn secondary sm" href={`/api/rees/${reeId}/knowledge/${detail.id}/text`}>
                <Icon name="text" />
                {k.details.downloadText}
              </a>
            )}
            {detail.deletedAt ? (
              actionButton('refresh', k.menu.restore, () => setDialog({ type: 'confirm', action: 'restore', items: [item!] }))
            ) : (
              <>
                {actionButton('folder', k.menu.move, () => setDialog({ type: 'move', items: [item!] }))}
                {actionButton('settings', k.menu.rename, () => setDialog({ type: 'rename', item: item! }))}
                {actionButton('refresh', k.refresh, () => setDialog({ type: 'confirm', action: 'reprocess', items: [item!] }), busy)}
              </>
            )}
          </div>
        </aside>
      </div>
      <KnowledgeDialogs
        reeId={reeId}
        dialog={dialog}
        onClose={() => setDialog(null)}
        onDone={(message) => {
          setDialog(null);
          toast(message);
          void load();
          onChanged?.();
        }}
      />
    </div>
  );
}

/** The start of the transcript segment playing at `seconds`. */
function segmentAt(children: readonly KnowledgeChild[], seconds: number): number | undefined {
  let found: number | undefined = children[0]?.time;
  for (const segment of children) {
    if ((segment.time ?? 0) <= seconds + 0.25) found = segment.time;
    else break;
  }
  return found;
}

