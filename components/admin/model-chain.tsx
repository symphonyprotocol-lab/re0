'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ModelKind } from '@/lib/constants';
import type { GenerationAudience } from '@/lib/domain/models';
import type { ChainEntryView, ChainKey, ModelConfigView, ModelHealthEventView, ModelHealthView } from '@/lib/services/models';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { CI } from '@/components/admin/console-icon';
import { Tag } from '@/components/admin/list-kit';
import { useToast } from '@/components/ui/toast';

/** Dates arrive as strings from the server component. */
type Wire<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };
export type HealthWire = Wire<ModelHealthView>;
export type EventWire = Wire<ModelHealthEventView>;

export interface ChainBoard {
  configs: ModelConfigView[];
  chains: Record<ChainKey, ChainEntryView[]>;
  health: Record<string, HealthWire>;
  today: Record<string, { calls: number; failed: number }>;
  events: EventWire[];
  fallbacks: Record<ModelKind, { model: string; transport: string }>;
}

export function chainKeyOf(kind: ModelKind, audience: GenerationAudience): ChainKey {
  return kind === 'generation' ? `generation:${audience}` : kind as ChainKey;
}

export function coolingNow(health: HealthWire | undefined, now: number): boolean {
  return Boolean(health?.state === 'cooling' && health.coolingUntil && Date.parse(health.coolingUntil) > now);
}

/** Quota, a bad key or a missing model needs someone to act; a rate limit or a server error passes by itself. */
const SERIOUS = new Set(['quota', 'auth', 'model_missing']);

/**
 * One list (design 01): primary first, each entry's health, today's calls,
 * reorder by drag or arrows, pause, remove, clear a cooldown, and a picker
 * that probes and adds an entry as the last backup.
 */
export function ChainPanel({ kind, audience, board, onProbe, probing }: {
  kind: ModelKind;
  audience: GenerationAudience;
  board: ChainBoard;
  onProbe: (config: ModelConfigView) => void;
  probing: Record<string, boolean>;
}) {
  const { t, locale } = useI18n();
  const m = t.admin.models;
  const c = m.chain;
  const router = useRouter();
  const toast = useToast();
  const key = chainKeyOf(kind, audience);
  const stored = board.chains[key];
  const [items, setItems] = useState<{ id: string; active: boolean }[]>(() => stored.map((entry) => ({ id: entry.configId, active: entry.active })));
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const [pick, setPick] = useState('');
  /* A refresh brings the server's list. */
  const signature = stored.map((entry) => `${entry.configId}:${entry.active}`).join(',');
  useEffect(() => setItems(stored.map((entry) => ({ id: entry.configId, active: entry.active }))), [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  const now = Date.now();
  const byId = new Map(board.configs.map((config) => [config.id, config]));
  const candidates = board.configs.filter((config) => config.kind === kind && !items.some((item) => item.id === config.id));
  const single = kind === 'speech';

  const failed = (error?: string) => {
    const code = error as keyof typeof m.errors | undefined;
    toast(code && code in m.errors ? m.errors[code] : t.common.errors.generic);
  };

  const save = async (next: { id: string; active: boolean }[]) => {
    const previous = items;
    setItems(next);
    setBusy(true);
    const result = await api<{ error?: string }>('/api/admin/models/chain', { method: 'PUT', json: { kind, audience, entries: next } });
    setBusy(false);
    if (!result.ok) {
      setItems(previous);
      failed(result.data.error);
      return;
    }
    toast(c.saved);
    router.refresh();
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    void save(next);
  };

  const add = async () => {
    if (!pick) return;
    setBusy(true);
    const result = await api<{ error?: string }>('/api/admin/models/chain', { method: 'POST', json: { kind, audience, id: pick } });
    setBusy(false);
    if (!result.ok) return failed(result.data.error);
    setPick('');
    toast(c.added);
    router.refresh();
  };

  const clear = async (id: string) => {
    setBusy(true);
    const result = await api<{ error?: string }>(`/api/admin/models/${id}/cooldown`, { method: 'DELETE' });
    setBusy(false);
    if (!result.ok) return failed(result.data.error);
    toast(c.cleared);
    router.refresh();
  };

  if (items.length === 0) {
    return (
      <div className="model-chain">
        <div className="info-strip">
          <CI name="info" />
          <span>{fill(c.empty, { model: board.fallbacks[kind].model })}</span>
        </div>
      </div>
    );
  }

  let shown = 0;
  return (
    <div className="model-chain" aria-busy={busy}>
      <ol className="model-chain-list">
        {items.map((item, index) => {
          const config = byId.get(item.id);
          if (!config) return null;
          const health = board.health[item.id];
          const cooling = coolingNow(health, now);
          const today = board.today[item.id];
          const label = item.active ? (shown++ === 0 ? c.primary : fill(c.backup, { n: shown - 1 })) : c.paused;
          return (
            <li
              key={item.id}
              className={`model-chain-item ${item.active ? '' : 'paused'} ${dragging === index ? 'dragging' : ''}`}
              draggable={!busy && !single}
              onDragStart={(event) => { setDragging(index); event.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={(event) => { if (dragging !== null) event.preventDefault(); }}
              onDrop={(event) => { event.preventDefault(); if (dragging !== null) move(dragging, index); setDragging(null); }}
              onDragEnd={() => setDragging(null)}
            >
              <div className="between">
                <span className="flex">
                  {!single && <span className="model-chain-grip" title={c.drag} aria-hidden="true">⋮⋮</span>}
                  <span className={`model-chain-pos ${item.active && label === c.primary ? 'primary' : ''}`}>{label}</span>
                  <strong>{config.name}</strong>
                </span>
                {!item.active ? <Tag tone="grey">{c.paused}</Tag>
                  : cooling ? <Tag tone={SERIOUS.has(health!.reason ?? '') ? 'red' : 'orange'}>{fill(c.cooling, { reason: c.reasons[health!.reason ?? 'server'] })}</Tag>
                    : <Tag tone="green">{c.ok}</Tag>}
              </div>
              <code>{config.model}</code>
              <p>
                {cooling && health?.coolingUntil && <>{fill(c.until, { time: formatDateTime(health.coolingUntil, locale) })} · </>}
                {health?.lastFailureAt && <>{fill(c.lastFailure, { time: formatDateTime(health.lastFailureAt, locale) })} · </>}
                {fill(c.today, { calls: formatNumber(today?.calls ?? 0, locale), failed: formatNumber(today?.failed ?? 0, locale) })}
              </p>
              <div className="flex model-chain-actions">
                {!single && <>
                  <button type="button" className="icon-btn" aria-label={c.up} title={c.up} disabled={busy || index === 0} onClick={() => move(index, index - 1)}>↑</button>
                  <button type="button" className="icon-btn" aria-label={c.down} title={c.down} disabled={busy || index === items.length - 1} onClick={() => move(index, index + 1)}>↓</button>
                </>}
                <button type="button" className="btn secondary sm" disabled={probing[item.id]} onClick={() => onProbe(config)}>{probing[item.id] ? m.probing : m.probe}</button>
                {cooling && <button type="button" className="btn secondary sm" disabled={busy} onClick={() => clear(item.id)}>{c.clear}</button>}
                {!single && <button type="button" className="btn secondary sm" disabled={busy} onClick={() => save(items.map((entry, at) => (at === index ? { ...entry, active: !entry.active } : entry)))}>{item.active ? c.pause : c.resume}</button>}
                {!single && items.length > 1 && <button type="button" className="btn secondary sm" disabled={busy} onClick={() => save(items.filter((_, at) => at !== index))}>{c.remove}</button>}
              </div>
            </li>
          );
        })}
      </ol>
      {!single && candidates.length > 0 && (
        <div className="flex model-chain-add">
          <select aria-label={c.addPick} value={pick} onChange={(event) => setPick(event.target.value)} disabled={busy}>
            <option value="">{c.addPick}</option>
            {candidates.map((config) => <option key={config.id} value={config.id}>{config.name} · {config.model}</option>)}
          </select>
          <button type="button" className="btn sm" disabled={busy || !pick} onClick={add}>{busy && pick ? c.adding : c.add}</button>
        </div>
      )}
      <p className="model-chain-note">{single ? c.speechNote : kind === 'embedding' ? c.embeddingNote : audience === 'plan' ? `${c.order} ${c.planNote}` : c.order}</p>
    </div>
  );
}

/** The page's banner: a list whose primary (or every entry) is cooling. */
export function ChainBanners({ board }: { board: ChainBoard }) {
  const { t, locale } = useI18n();
  const m = t.admin.models;
  const c = m.chain;
  const now = Date.now();
  const lines: { key: string; text: string; serious: boolean }[] = [];
  const lists: { key: ChainKey; label: string }[] = [
    { key: 'generation:free', label: `${m.kinds.generation} · ${fill(c.plan, { audience: m.audiences.free })}` },
    { key: 'generation:plan', label: `${m.kinds.generation} · ${fill(c.plan, { audience: m.audiences.plan })}` },
    { key: 'embedding', label: m.kinds.embedding },
    { key: 'transcription', label: m.kinds.transcription },
  ];
  for (const list of lists) {
    const active = board.chains[list.key].filter((entry) => entry.active);
    if (active.length === 0) continue;
    const cooling = active.filter((entry) => coolingNow(board.health[entry.configId], now));
    if (cooling.length === active.length && active.length > 1) {
      lines.push({ key: list.key, text: fill(c.bannerAll, { list: list.label }), serious: true });
      continue;
    }
    const primary = active[0]!;
    const health = board.health[primary.configId];
    if (!coolingNow(health, now)) continue;
    const name = board.configs.find((config) => config.id === primary.configId)?.name ?? '';
    lines.push({
      key: list.key,
      text: fill(c.banner, { list: list.label, name, reason: c.reasons[health!.reason ?? 'server'], time: formatDateTime(health!.coolingUntil!, locale) }),
      serious: SERIOUS.has(health!.reason ?? ''),
    });
  }
  if (lines.length === 0) return null;
  return (
    <div className="model-chain-banners">
      {lines.map((line) => (
        <div key={line.key} className={`info-strip mb16 ${line.serious ? 'danger' : 'warning'}`} role="status">
          <CI name="info" />
          <span>{line.text}</span>
        </div>
      ))}
    </div>
  );
}

/** "最近切换": cooldowns starting, ending and cleared by hand. */
export function ChainEvents({ events }: { events: EventWire[] }) {
  const { t, locale } = useI18n();
  const c = t.admin.models.chain;
  return (
    <section className="card model-chain-events">
      <h2>{c.events}</h2>
      {events.length === 0 ? <p className="muted small">{c.eventsEmpty}</p> : (
        <ul>
          {events.map((event) => (
            <li key={event.id}>
              <time>{formatDateTime(event.createdAt, locale)}</time>
              <strong>{event.name ?? t.admin.models.job.unknown}</strong>
              <Tag tone={event.event === 'cooling' ? (SERIOUS.has(event.reason ?? '') ? 'red' : 'orange') : 'green'}>
                {fill(c.event[event.event], { reason: c.reasons[event.reason ?? 'server'] })}
              </Tag>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
