'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Locator } from '@/lib/domain/answer';
import { locatorLabel } from '@/lib/domain/answer';
import type { KnowledgeActivity } from '@/lib/domain/knowledge';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatBytes, formatDateTime, formatNumber } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';
import { StatusBadge, failureLabel } from '@/components/knowledge/status-badge';

interface Detail {
  id: string;
  title: string;
  kind: 'document' | 'text' | 'audio' | 'github' | 'page' | 'site';
  status: string;
  error: string | null;
  fileName: string | null;
  fileSize: number | null;
  content: string | null;
  activity: KnowledgeActivity[];
  createdAt: string;
  updatedAt: string;
  chunks: { id: string; ordinal: number; content: string; locator: Locator }[];
}

type Tab = 'content' | 'chunks' | 'activity';

/** `text` with every occurrence of `query` marked, case-insensitively. */
function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: ReactNode[] = [];
  let at = 0;
  for (let hit = lower.indexOf(needle); hit !== -1; hit = lower.indexOf(needle, at)) {
    parts.push(text.slice(at, hit), <mark key={hit} className="rounded bg-[#fff1b8] px-0.5 text-ink">{text.slice(hit, hit + needle.length)}</mark>);
    at = hit + needle.length;
  }
  parts.push(text.slice(at));
  return parts;
}

function countOf(text: string, query: string): number {
  if (!query) return 0;
  let count = 0;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  for (let hit = lower.indexOf(needle); hit !== -1; hit = lower.indexOf(needle, hit + needle.length)) count += 1;
  return count;
}

/**
 * One source: "内容预览 / 检索片段 / 处理记录" (prototype knowledge.js),
 * with find-in-content and the source's details. Polls while it processes.
 */
export function KnowledgePreview({ reeId, knowledgeId, onClose, onRefresh }: { reeId: string; knowledgeId: string | null; onClose: () => void; onRefresh: (id: string) => Promise<void> }) {
  const { t, locale } = useI18n();
  const k = t.knowledge;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<Tab>('content');
  const [find, setFind] = useState('');

  const load = useCallback(async () => {
    if (!knowledgeId) return;
    const result = await api<{ knowledge: Detail }>(`/api/rees/${reeId}/knowledge/${knowledgeId}`);
    if (result.ok) setDetail(result.data.knowledge);
  }, [reeId, knowledgeId]);

  useEffect(() => {
    setDetail(null);
    setTab('content');
    setFind('');
    void load();
  }, [load]);

  const busy = detail?.status === 'pending' || detail?.status === 'processing';
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [busy, load]);

  const matches = useMemo(() => {
    if (!detail || !find) return 0;
    return tab === 'chunks' ? detail.chunks.reduce((sum, chunk) => sum + countOf(chunk.content, find), 0) : countOf(detail.content ?? '', find);
  }, [detail, find, tab]);

  const n = (value: number) => formatNumber(value, locale);
  const activityLabel = (entry: KnowledgeActivity): string => {
    const d = entry.detail ?? {};
    if (entry.code === 'parsed') return fill(k.activity.parsed, { chars: n(Number(d.chars ?? 0)), pages: d.pages ? fill(k.activity.parsedPages, { pages: d.pages }) : '' });
    if (entry.code === 'failed') return fill(k.activity.failed, { reason: failureLabel(t, String(d.reason ?? '')) });
    return fill(k.activity[entry.code], Object.fromEntries(Object.entries(d).map(([key, value]) => [key, typeof value === 'number' ? n(value) : value])));
  };

  let body: ReactNode;
  if (!detail) {
    body = (
      <div className="flex justify-center py-16 text-muted">
        <Spinner />
      </div>
    );
  } else if (busy && tab !== 'activity') {
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
        <button type="button" className="btn btn-sm" onClick={() => onRefresh(detail.id).then(load)}>
          <Icon name="refresh" className="size-3.5" />
          {k.retry}
        </button>
        <small className="max-w-[360px] text-[11px] text-muted">{k.failedBody}</small>
      </div>
    );
  } else if (tab === 'content') {
    body = detail.content ? (
      <pre className="font-sans text-[13px] leading-relaxed break-words whitespace-pre-wrap">{highlight(detail.content, find)}</pre>
    ) : (
      <p className="py-10 text-center text-[12px] text-muted">{k.contentEmpty}</p>
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
              <span>
                {[locatorLabel(chunk.locator, locale), `${n(chunk.content.length)} ${t.common.units.chars}`].filter(Boolean).join(' · ')}
              </span>
            </div>
            <p className="mt-2 text-[12px] leading-relaxed whitespace-pre-wrap">{highlight(chunk.content, find)}</p>
          </article>
        ))}
      </div>
    );
  } else {
    body = (
      <div>
        <h3 className="text-[14px] font-bold">{k.activityTitle}</h3>
        <ol className="mt-3 flex flex-col gap-3">
          {[...detail.activity].reverse().map((entry, index) => (
            <li key={`${entry.at}-${index}`} className="flex gap-3">
              <span className={`mt-0.5 inline-flex size-5 flex-none items-center justify-center rounded-full ${entry.code === 'failed' ? 'bg-[#fff3f3] text-red' : 'bg-soft text-blue'}`}>
                <Icon name={entry.code === 'failed' ? 'close' : 'check'} className="size-3" />
              </span>
              <span>
                <strong className="block text-[12px]">{activityLabel(entry)}</strong>
                <small className="text-[11px] text-muted">{formatDateTime(entry.at, locale)}</small>
              </span>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  return (
    <Modal open={Boolean(knowledgeId)} onClose={onClose} variant="drawer" title={detail?.title ?? '…'} subtitle={detail ? <StatusBadge status={detail.status} /> : undefined}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex rounded-lg border border-line bg-wash p-0.5" role="tablist">
            {(['content', 'chunks', 'activity'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
                className={`rounded-md px-3 py-1.5 text-[12px] font-semibold ${tab === value ? 'bg-white text-blue shadow-sm' : 'text-muted'}`}
              >
                {k.previewTabs[value]}
              </button>
            ))}
          </div>
          {tab !== 'activity' && (
            <label className="relative w-full sm:w-[200px]">
              <span className="sr-only">{k.findLabel}</span>
              <Icon name="search" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[#a3a9bb]" />
              <input className="input py-1.5 pl-8 text-[12px]" value={find} placeholder={k.find} onChange={(event) => setFind(event.target.value)} />
            </label>
          )}
        </div>
        {find && tab !== 'activity' && <p className="text-[11px] text-muted">{fill(k.matches, { count: matches })}</p>}
        <div className="min-h-[240px]">{body}</div>
        {detail && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-line bg-wash p-4 text-[11px]">
            <dt className="text-muted">{k.details.type}</dt>
            <dd>{t.common.kinds[detail.kind]}</dd>
            {detail.fileName && (
              <>
                <dt className="text-muted">{k.details.fileName}</dt>
                <dd className="truncate">{detail.fileName}</dd>
              </>
            )}
            {detail.fileSize !== null && (
              <>
                <dt className="text-muted">{k.details.fileSize}</dt>
                <dd>{formatBytes(detail.fileSize)}</dd>
              </>
            )}
            <dt className="text-muted">{k.details.saved}</dt>
            <dd>
              {n(detail.content?.length ?? 0)} {t.common.units.chars}
            </dd>
            <dt className="text-muted">{k.details.chunks}</dt>
            <dd>{n(detail.chunks.length)}</dd>
            <dt className="text-muted">{k.details.created}</dt>
            <dd>{formatDateTime(detail.createdAt, locale)}</dd>
            <dt className="text-muted">{k.details.updated}</dt>
            <dd>{formatDateTime(detail.updatedAt, locale)}</dd>
          </dl>
        )}
      </div>
    </Modal>
  );
}
