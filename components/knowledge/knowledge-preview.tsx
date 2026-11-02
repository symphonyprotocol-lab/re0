'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PREVIEW_CHILDREN_PAGE_SIZE, TRASH_RETENTION_DAYS } from '@/lib/constants';
import { locatorLabel, type Locator } from '@/lib/domain/answer';
import type { KnowledgeActivity, KnowledgeChild, KnowledgeKind } from '@/lib/domain/knowledge';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatBytes, formatDateTime, formatNumber } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
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

/** Markdown-ish text as headings and paragraphs, with matches marked (prototype `plain`). */
function Document({ text, find }: { text: string; find: string }) {
  return (
    <article className="flex flex-col gap-2 text-[13px] leading-relaxed break-words">
      {text.split('\n').map((line, index) => {
        if (line.startsWith('### ')) return <h4 key={index} className="mt-2 text-[13px] font-bold">{highlight(line.slice(4), find)}</h4>;
        if (line.startsWith('## ')) return <h3 key={index} className="mt-3 text-[15px] font-bold">{highlight(line.slice(3), find)}</h3>;
        if (line.startsWith('# ')) return <h2 key={index} className="mt-2 text-[18px] font-extrabold">{highlight(line.slice(2), find)}</h2>;
        if (!line.trim()) return <div key={index} className="h-1" />;
        return (
          <p key={index} className="whitespace-pre-wrap">
            {highlight(line, find)}
          </p>
        );
      })}
    </article>
  );
}

/** A repository file with line numbers. */
function Code({ text, find }: { text: string; find: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-[#fbfcff] py-2 font-mono text-[12px] leading-[1.6]">
      {text.split('\n').map((line, index) => (
        <div key={index} className="flex min-w-max">
          <span className="w-12 flex-none pr-3 text-right text-[#a3a9bb] select-none">{index + 1}</span>
          <code className="pr-4 whitespace-pre">{highlight(line, find)}</code>
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
  layout,
  initialTime,
  initialChild,
  onChanged,
  onChildChange,
}: {
  reeId: string;
  knowledgeId: string;
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

  const load = useCallback(async () => {
    const result = await api<{ knowledge: KnowledgeDetail }>(`/api/rees/${reeId}/knowledge/${knowledgeId}`);
    if (result.ok) setDetail(result.data.knowledge);
    else if (result.status === 404) setMissing(true);
  }, [reeId, knowledgeId]);

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
    void api<{ content: string }>(`/api/rees/${reeId}/knowledge/${knowledgeId}?child=${index}`).then((result) => result.ok && setChildText(result.data.content));
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
    if (audio) audio.currentTime = initialTime;
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
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <Icon name="file" className="size-6 text-blue" />
        <strong className="text-[14px]">{k.page.missingTitle}</strong>
        <p className="text-[12px] text-muted">{k.page.missingBody}</p>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="flex justify-center py-16 text-muted">
        <Spinner />
      </div>
    );
  }

  let body: ReactNode;
  if (busy && tab !== 'activity') {
    body = (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <Spinner className="size-6 text-blue" />
        <strong className="text-[14px]">{k.busyTitle}</strong>
        <p className="text-[12px] text-muted">{k.busyBody}</p>
        <ol className="mt-2 flex flex-col gap-1.5 text-left text-[12px]">
          <li className="flex items-center gap-2 text-green">
            <Icon name="check" className="size-3.5" />
            {k.busySteps.added}
          </li>
          <li className="flex items-center gap-2 text-blue">
            <Spinner className="size-3" />
            {k.busySteps.working}
          </li>
          <li className="flex items-center gap-2 text-muted">
            <Icon name="clock" className="size-3.5" />
            {k.busySteps.waiting}
          </li>
        </ol>
      </div>
    );
  } else if (detail.status === 'failed' && tab !== 'activity') {
    body = (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <Icon name="info" className="size-6 text-red" />
        <strong className="text-[14px]">{k.failedTitle}</strong>
        <p className="text-[12px] text-red">{failureLabel(t, detail.error)}</p>
        {!detail.deletedAt && (
          <button type="button" className="btn btn-sm" onClick={() => item && setDialog({ type: 'confirm', action: 'reprocess', items: [item] })}>
            <Icon name="refresh" className="size-3.5" />
            {fill(k.retry, { credits: n(reprocessCost(item!)) })}
          </button>
        )}
        <small className="max-w-[360px] text-[11px] text-muted">{k.failedBody}</small>
      </div>
    );
  } else if (tab === 'original') {
    body =
      detail.kind === 'audio' ? (
        <audio controls src={fileUrl} className="w-full" aria-label={k.audio.player} />
      ) : (
        <iframe src={fileUrl} title={detail.title} className="h-[70vh] w-full rounded-lg border border-line" />
      );
  } else if (tab === 'chunks') {
    body = (
      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-[14px] font-bold">{k.chunksTitle}</h3>
          <p className="text-[11px] text-muted">{k.chunksBody}</p>
        </div>
        {detail.chunks.map((chunk) => (
          <article key={chunk.id} className="rounded-lg border border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted">
              <span className="font-mono">{fill(k.chunk, { n: String(chunk.ordinal + 1).padStart(3, '0') })}</span>
              <span className="min-w-0 truncate">{[locatorLabel(chunk.locator, locale), `${n(chunk.content.length)} ${t.common.units.chars}`].filter(Boolean).join(' · ')}</span>
            </div>
            <p className="mt-2 text-[12px] leading-relaxed break-words whitespace-pre-wrap">{highlight(chunk.content, find)}</p>
          </article>
        ))}
        {detail.chunkTotal > detail.chunks.length && <p className="text-[11px] text-muted">{fill(k.chunksMore, { shown: n(detail.chunks.length), total: n(detail.chunkTotal) })}</p>}
      </div>
    );
  } else if (tab === 'activity') {
    body = (
      <div>
        <h3 className="text-[14px] font-bold">{k.activityTitle}</h3>
        <ol className="mt-3 flex flex-col gap-3">
          {[...detail.activity].reverse().map((entry, index) => (
            <li key={`${entry.at}-${index}`} className="flex gap-3">
              <span className={`mt-0.5 inline-flex size-5 flex-none items-center justify-center rounded-full ${entry.code === 'failed' ? 'bg-[#fff3f3] text-red' : 'bg-soft text-blue'}`}>
                <Icon name={entry.code === 'failed' ? 'close' : 'check'} className="size-3" />
              </span>
              <span className="min-w-0">
                <strong className="block text-[12px] break-words">{activityLabel(t, locale, entry)}</strong>
                <small className="text-[11px] text-muted">{formatDateTime(entry.at, locale)}</small>
              </span>
            </li>
          ))}
        </ol>
      </div>
    );
  } else if (perChild) {
    const pages = Math.max(1, Math.ceil(filteredChildren.length / PREVIEW_CHILDREN_PAGE_SIZE));
    const page = Math.min(childPage, pages);
    const selected = detail.children[Math.min(child, detail.children.length - 1)];
    body = (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-2 text-[12px] font-semibold">
            <Icon name={detail.kind === 'site' ? 'globe' : 'github'} className="size-4 text-blue" />
            {fill(detail.kind === 'site' ? k.children.pages : k.children.files, { n: n(detail.children.length) })}
          </div>
          <label className="relative">
            <span className="sr-only">{k.children.findLabel}</span>
            <Icon name="search" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[#a3a9bb]" />
            <input
              className="input py-1.5 pl-8 text-[12px]"
              value={childQ}
              placeholder={k.children.find}
              onChange={(event) => {
                setChildQ(event.target.value);
                setChildPage(1);
              }}
            />
          </label>
          <div className="flex max-h-[420px] flex-col gap-0.5 overflow-y-auto">
            {filteredChildren.slice((page - 1) * PREVIEW_CHILDREN_PAGE_SIZE, page * PREVIEW_CHILDREN_PAGE_SIZE).map((entry) => (
              <button
                key={entry.index}
                type="button"
                title={entry.path ?? entry.url ?? entry.label}
                aria-pressed={entry.index === child}
                onClick={() => {
                  setChild(entry.index);
                  setHit(0);
                  onChildChange?.(entry.index);
                }}
                className={`flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] ${entry.index === child ? 'bg-soft font-semibold text-blue' : 'hover:bg-wash'}`}
              >
                <Icon name={detail.kind === 'site' ? 'file' : 'code'} className="size-3.5 flex-none" />
                <span className="truncate">{highlight(entry.path ?? entry.label, childQ)}</span>
              </button>
            ))}
            {filteredChildren.length === 0 && <p className="px-2 py-4 text-center text-[11px] text-muted">{k.children.empty}</p>}
          </div>
          {filteredChildren.length > PREVIEW_CHILDREN_PAGE_SIZE && (
            <div className="flex items-center justify-between text-[11px] text-muted">
              <button type="button" className="icon-btn" disabled={page <= 1} onClick={() => setChildPage(page - 1)} aria-label={k.children.previous}>
                <Icon name="chevronLeft" />
              </button>
              <span className="font-mono">
                {page} / {pages}
              </span>
              <button type="button" className="icon-btn" disabled={page >= pages} onClick={() => setChildPage(page + 1)} aria-label={k.children.next}>
                <Icon name="chevronRight" />
              </button>
            </div>
          )}
        </aside>
        <div className="min-w-0">
          {selected && (
            <div className="mb-3 flex min-w-0 items-center gap-2 text-[11px] text-muted">
              <Icon name={detail.kind === 'site' ? 'globe' : 'code'} className="size-3.5 flex-none" />
              {selected.url ? (
                <a href={selected.url} target="_blank" rel="noreferrer noopener" className="truncate hover:text-blue">
                  {selected.url}
                </a>
              ) : (
                <span className="truncate">{selected.path}</span>
              )}
            </div>
          )}
          {childText === null ? (
            <div className="flex justify-center py-10 text-muted">
              <Spinner />
            </div>
          ) : detail.kind === 'github' ? (
            <Code text={childText} find={find} />
          ) : (
            <>
              {selected?.label && <h2 className="mb-2 text-[16px] font-bold">{selected.label}</h2>}
              <Document text={childText} find={find} />
            </>
          )}
        </div>
      </div>
    );
  } else if (detail.kind === 'audio') {
    const content = detail.content ?? '';
    const current = activeTime === null ? null : segmentAt(detail.children, activeTime);
    body = (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="inline-flex size-10 flex-none items-center justify-center rounded-lg bg-soft text-blue">
            <Icon name="audio" />
          </span>
          <div className="min-w-0">
            <strong className="block truncate text-[13px]">{detail.title}</strong>
            <small className="text-[11px] text-muted">
              {clock(detail.children.at(-1)?.end ?? 0)} · {k.audio.transcript}
            </small>
          </div>
        </div>
        <audio ref={audioRef} controls preload="metadata" src={fileUrl} className="w-full" aria-label={k.audio.player} onTimeUpdate={(event) => setActiveTime(event.currentTarget.currentTime)} />
        <div className="flex flex-col gap-2">
          {detail.children.map((segment) => (
            <div key={segment.offset} data-time={segment.time} className={`flex gap-3 rounded-lg px-2 py-1.5 ${current === segment.time ? 'bg-soft' : ''}`}>
              <button
                type="button"
                className={`h-fit flex-none rounded-md px-1.5 py-0.5 font-mono text-[11px] ${current === segment.time ? 'bg-blue text-white' : 'bg-wash text-blue hover:bg-soft'}`}
                aria-label={fill(k.audio.seek, { time: clock(segment.time ?? 0) })}
                onClick={() => {
                  const audio = audioRef.current;
                  if (audio) {
                    audio.currentTime = segment.time ?? 0;
                    void audio.play().catch(() => undefined);
                  }
                  setActiveTime(segment.time ?? 0);
                }}
              >
                {clock(segment.time ?? 0)}
              </button>
              <p className="min-w-0 text-[13px] leading-relaxed break-words">{highlight(content.slice(segment.offset, segment.offset + segment.length), find)}</p>
            </div>
          ))}
        </div>
      </div>
    );
  } else {
    body = detail.content ? <Document text={detail.content} find={find} /> : <p className="py-10 text-center text-[12px] text-muted">{k.contentEmpty}</p>;
  }

  const details = (
    <aside className={`flex min-w-0 flex-col gap-4 ${layout === 'page' ? 'lg:border-l lg:border-line lg:pl-6' : 'border-t border-line pt-4'}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[14px] font-bold">{k.details.title}</h3>
        <StatusBadge status={detail.status} />
      </div>
      {detail.deletedAt ? (
        <p className="flex gap-2 rounded-lg border border-line bg-wash px-3 py-2.5 text-[12px] text-muted">
          <Icon name="trash" className="mt-0.5 size-3.5 flex-none" />
          {fill(k.details.inTrash, { days: Math.max(0, TRASH_RETENTION_DAYS - Math.floor((Date.now() - new Date(detail.deletedAt).getTime()) / 86_400_000)) })}
        </p>
      ) : (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5">
          <div>
            <strong className="block text-[12px]">{k.details.scope}</strong>
            <p className="text-[11px] text-muted">{detail.enabled ? k.details.scopeOn : k.details.scopeOff}</p>
          </div>
          <Switch checked={detail.enabled} label={k.details.scopeToggle} onChange={toggle} />
        </div>
      )}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[12px]">
        <dt className="text-muted">{k.details.folder}</dt>
        <dd className="truncate">{detail.folderName ?? k.folders.unfiled}</dd>
        <dt className="text-muted">{k.details.type}</dt>
        <dd>{t.common.kinds[detail.kind]}</dd>
        {detail.fileName && (
          <>
            <dt className="text-muted">{k.details.fileName}</dt>
            <dd className="truncate" title={detail.fileName}>
              {detail.fileName}
            </dd>
          </>
        )}
        {detail.fileSize !== null && (
          <>
            <dt className="text-muted">{k.details.fileSize}</dt>
            <dd>{formatBytes(detail.fileSize)}</dd>
          </>
        )}
        <dt className="text-muted">{k.details.source}</dt>
        <dd className="break-all">
          {detail.source ? (
            <a href={detail.source} target="_blank" rel="noreferrer noopener" className="hover:text-blue">
              {detail.source}
            </a>
          ) : (
            k.details.sourceUpload
          )}
        </dd>
        <dt className="text-muted">{k.details.saved}</dt>
        <dd>
          {n(detail.chars)} {t.common.units.chars}
        </dd>
        <dt className="text-muted">{k.details.chunks}</dt>
        <dd>{n(detail.chunkTotal)}</dd>
        <dt className="text-muted">{k.details.created}</dt>
        <dd>{formatDateTime(detail.createdAt, locale)}</dd>
        <dt className="text-muted">{k.details.updated}</dt>
        <dd>{formatDateTime(detail.updatedAt, locale)}</dd>
      </dl>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-secondary btn-sm"
          onClick={async () => {
            await navigator.clipboard.writeText(`${window.location.origin}/rees/${reeId}/knowledge/${detail.id}`);
            toast(k.done.linkCopied);
          }}
        >
          <Icon name="copy" className="size-3.5" />
          {k.details.copyLink}
        </button>
        {(detail.kind === 'document' || detail.kind === 'audio') && (
          <a className="btn-secondary btn-sm" href={`${fileUrl}?download=1`}>
            <Icon name="download" className="size-3.5" />
            {k.details.downloadOriginal}
          </a>
        )}
        {detail.status === 'ready' && (
          <a className="btn-secondary btn-sm" href={`/api/rees/${reeId}/knowledge/${detail.id}/text`}>
            <Icon name="text" className="size-3.5" />
            {k.details.downloadText}
          </a>
        )}
        {detail.deletedAt ? (
          <button type="button" className="btn-secondary btn-sm" onClick={() => setDialog({ type: 'confirm', action: 'restore', items: [item!] })}>
            <Icon name="refresh" className="size-3.5" />
            {k.menu.restore}
          </button>
        ) : (
          <>
            <button type="button" className="btn-secondary btn-sm" onClick={() => setDialog({ type: 'move', items: [item!] })}>
              <Icon name="folder" className="size-3.5" />
              {k.menu.move}
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => setDialog({ type: 'rename', item: item! })}>
              <Icon name="settings" className="size-3.5" />
              {k.menu.rename}
            </button>
            <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => setDialog({ type: 'confirm', action: 'reprocess', items: [item!] })}>
              <Icon name="refresh" className="size-3.5" />
              {k.refresh}
            </button>
          </>
        )}
      </div>
    </aside>
  );

  return (
    <div className="flex flex-col gap-4" data-knowledge-preview={detail.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex max-w-full overflow-x-auto rounded-lg border border-line bg-wash p-0.5" role="tablist">
          {tabs.map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={`flex-none rounded-md px-3 py-1.5 text-[12px] font-semibold ${tab === value ? 'bg-white text-blue shadow-sm' : 'text-muted'}`}
            >
              {k.previewTabs[value]}
            </button>
          ))}
        </div>
        {tab !== 'activity' && tab !== 'original' && (
          <div className="flex w-full items-center gap-1 sm:w-auto">
            <label className="relative min-w-0 flex-1 sm:w-[220px] sm:flex-none">
              <span className="sr-only">{k.findLabel}</span>
              <Icon name="search" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[#a3a9bb]" />
              <input
                className="input py-1.5 pl-8 text-[12px]"
                value={find}
                placeholder={k.find}
                onChange={(event) => {
                  setFind(event.target.value);
                  setHit(0);
                }}
              />
            </label>
            {find && <span className="flex-none font-mono text-[11px] text-muted">{fill(k.matches, { count: matches })}</span>}
            <button
              type="button"
              className="icon-btn"
              aria-label={k.nextMatch}
              disabled={matches === 0}
              onClick={() => {
                const next = (hit + 1) % Math.max(1, matches);
                setHit(next);
                contentRef.current?.querySelectorAll('mark[data-match]')[next]?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
              }}
            >
              <Icon name="chevronDown" />
            </button>
          </div>
        )}
      </div>
      <div className={layout === 'page' ? 'grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px]' : 'flex flex-col gap-4'}>
        <div ref={contentRef} className="min-h-[240px] min-w-0">
          {body}
        </div>
        {details}
      </div>
      <KnowledgeDialogs
        reeId={reeId}
        dialog={dialog}
        onOpen={setDialog}
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

