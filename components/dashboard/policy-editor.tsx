'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import type { ApplyPolicyResult, ReachableCountResult } from '@/app/dashboard/policies/actions';
import { Badge, PANEL } from '@/components/dashboard/ui';
import {
  BadgeCheckIcon,
  BanIcon,
  BracesIcon,
  CircleCheckIcon,
  ClockIcon,
  FileTextIcon,
  GitBranchIcon,
  GlobeIcon,
  LinkIcon,
  ListChecksIcon,
  LockIcon,
  ScaleIcon,
  ShieldCheckIcon,
  SlidersIcon,
  SparklesIcon,
  SpinnerIcon,
  TrendingUpIcon,
  UploadIcon,
} from '@/components/ui/icons';
import {
  diffPolicy,
  parsePolicyEntry,
  parsePolicyList,
  policyDiffIsEmpty,
  sourceGroupEnabled,
  withSourceGroup,
  type PolicyQuality,
  type PolicySourceGroup,
  type WorkspacePolicy,
} from '@/lib/domain/policy';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';

export type CountAction = (draft: WorkspacePolicy) => Promise<ReachableCountResult>;
export type ApplyAction = (base: WorkspacePolicy, draft: WorkspacePolicy) => Promise<ApplyPolicyResult>;

type Icon = (props: { size?: number; className?: string }) => React.ReactElement;

/** The six switches of requirement.md 5.2, in the design's two groups. */
const SOURCE_GROUPS: { title: 'publicTitle' | 'connectedTitle'; items: PolicySourceGroup[] }[] = [
  { title: 'publicTitle', items: ['repos', 'sites', 'schema'] },
  { title: 'connectedTitle', items: ['notion', 'uploads', 'private'] },
];

const SOURCE_ICONS: Record<PolicySourceGroup, Icon> = {
  repos: GitBranchIcon,
  sites: GlobeIcon,
  schema: BracesIcon,
  notion: FileTextIcon,
  uploads: UploadIcon,
  private: LockIcon,
};

/**
 * One row per quality threshold. A `flag` row is a yes/no switch on a boolean
 * field; a `min` row is a lower bound with the design's preset steps; `maxDays`
 * is the freshness window. A value set through the API that is not a preset
 * is offered as an extra option, so the select never misreports it.
 */
type FilterRow =
  | { id: string; field: keyof PolicyQuality; kind: 'flag'; on: 'reviewedOnly' | 'licensedOnly'; Icon: Icon }
  | { id: string; field: keyof PolicyQuality; kind: 'min' | 'maxDays'; presets: number[]; Icon: Icon };

const FILTER_GROUPS: { title?: 'repoGroup' | 'siteGroup'; rows: FilterRow[] }[] = [
  {
    rows: [
      { id: 'reviewState', field: 'requireVerified', kind: 'flag', on: 'reviewedOnly', Icon: BadgeCheckIcon },
      { id: 'trustScore', field: 'minTrustScore', kind: 'min', presets: [60, 80], Icon: ShieldCheckIcon },
      { id: 'freshness', field: 'maxAgeDays', kind: 'maxDays', presets: [30, 90, 365], Icon: ClockIcon },
    ],
  },
  {
    title: 'repoGroup',
    rows: [
      { id: 'stars', field: 'minStars', kind: 'min', presets: [500, 1000], Icon: SparklesIcon },
      { id: 'license', field: 'requireLicense', kind: 'flag', on: 'licensedOnly', Icon: ScaleIcon },
    ],
  },
  {
    title: 'siteGroup',
    rows: [
      { id: 'backlinks', field: 'minBacklinks', kind: 'min', presets: [1000, 5000], Icon: LinkIcon },
      { id: 'referringDomains', field: 'minReferringDomains', kind: 'min', presets: [50, 200], Icon: GlobeIcon },
      { id: 'organicTraffic', field: 'minOrganicTraffic', kind: 'min', presets: [10_000, 100_000], Icon: TrendingUpIcon },
    ],
  },
];

type FilterLabelKey = 'reviewState' | 'trustScore' | 'freshness' | 'stars' | 'license' | 'backlinks' | 'referringDomains' | 'organicTraffic';

const COUNT_DEBOUNCE_MS = 400;

function Toggle({
  on,
  onClick,
  label,
  disabled,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        on ? 'justify-end bg-brand' : 'justify-start bg-mutedbg'
      }`}
    >
      <span className="size-4 rounded-full bg-card shadow-md" />
    </button>
  );
}

/** Removable chip in the block / allow lists. */
function ListChip({
  value,
  removeLabel,
  onRemove,
  disabled,
}: {
  value: string;
  removeLabel: string;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-subtle py-1 pr-1.5 pl-2">
      <span className="text-[13px] text-steel">{value}</span>
      {disabled ? null : (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className="text-[13px] leading-none text-muted transition-colors hover:text-ink"
        >
          ×
        </button>
      )}
    </span>
  );
}

/**
 * One policy list: typed entries added one at a time, a pasted list, or a CSV
 * file read in the browser. Every entry goes through `parsePolicyEntry`, so
 * what reaches the policy is an Asset ID, an organisation or a domain in its
 * stored form, and what does not parse is shown rather than dropped.
 */
function ListEditor({
  icon,
  title,
  description,
  values,
  onChange,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  values: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const p = t.dashboard.policies;
  const e = p.editor;
  const [entry, setEntry] = useState('');
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  function addOne() {
    const parsed = parsePolicyEntry(entry);
    if (!parsed) {
      setNote(fill(e.invalidEntry, { value: entry.trim() }));
      return;
    }
    if (values.includes(parsed.entry)) {
      setNote(fill(e.alreadyListed, { value: parsed.entry }));
      setEntry('');
      return;
    }
    onChange([...values, parsed.entry]);
    setEntry('');
    setNote(null);
  }

  function addMany(text: string) {
    const { entries, invalid } = parsePolicyList(text);
    const fresh = entries.filter((value) => !values.includes(value));
    if (fresh.length > 0) onChange([...values, ...fresh]);
    setNote(
      invalid.length > 0
        ? fill(e.invalidEntries, {
            count: invalid.length,
            values: invalid.slice(0, 5).join(', ') + (invalid.length > 5 ? '…' : ''),
          })
        : null,
    );
    setPasted('');
    setPasting(false);
  }

  function importFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => addMany(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(file);
    if (fileInput.current) fileInput.current.value = '';
  }

  const pastedCount = pasting ? parsePolicyList(pasted).entries.length : 0;

  return (
    <section className="flex flex-col gap-2 border-t border-line px-6 pt-[19px]">
      <div className="flex flex-col gap-[5px]">
        <h3 className="flex items-center gap-[7px] text-[13px] text-ink">
          <span className="text-brandink">{icon}</span>
          {title}
        </h3>
        <p className="text-[11px] text-muted">{description}</p>
      </div>

      {disabled ? null : (
        <div className="flex flex-wrap gap-1.5">
          <label className="flex h-[38px] min-w-[220px] flex-1 items-center gap-[7px] rounded-md border border-line px-3 focus-within:border-brand">
            <ListChecksIcon size={13} className="text-muted" />
            <input
              value={entry}
              onChange={(event) => {
                setEntry(event.target.value);
                setNote(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addOne();
                }
              }}
              placeholder={p.listPlaceholder}
              aria-label={title}
              className="min-w-0 flex-1 bg-transparent text-[11px] text-ink placeholder:text-muted/50 focus:outline-none"
            />
          </label>
          <button
            type="button"
            onClick={addOne}
            disabled={entry.trim().length === 0}
            className="h-[38px] rounded-md border border-brand bg-brand px-[11px] text-[11px] font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-60"
          >
            {p.add}
          </button>
          <button
            type="button"
            onClick={() => setPasting((current) => !current)}
            aria-pressed={pasting}
            className="inline-flex h-[38px] items-center gap-1.5 rounded-md border border-line bg-card px-[13px] text-[11px] font-medium text-steel transition-colors hover:bg-subtle"
          >
            <ListChecksIcon size={13} />
            {e.csvPaste}
          </button>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="inline-flex h-[38px] items-center gap-1.5 rounded-md border border-line bg-card px-[13px] text-[11px] font-medium text-steel transition-colors hover:bg-subtle"
          >
            <UploadIcon size={13} />
            {e.csvImport}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            hidden
            onChange={(event) => importFile(event.target.files?.[0])}
          />
        </div>
      )}

      {pasting && !disabled ? (
        <div className="flex flex-col gap-1.5">
          <textarea
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            placeholder={e.csvPastePlaceholder}
            rows={4}
            className="w-full rounded-md border border-line px-3 py-2 font-mono text-[11px] text-ink placeholder:text-muted/50 focus:border-brand focus:outline-none"
          />
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => addMany(pasted)}
              disabled={pastedCount === 0}
              className="h-[34px] rounded-md border border-brand bg-brand px-[11px] text-[11px] font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-60"
            >
              {fill(e.csvApply, { count: pastedCount })}
            </button>
            <button
              type="button"
              onClick={() => {
                setPasting(false);
                setPasted('');
              }}
              className="h-[34px] rounded-md border border-line bg-card px-[11px] text-[11px] text-steel transition-colors hover:bg-subtle"
            >
              {e.csvCancel}
            </button>
          </div>
        </div>
      ) : null}

      <p className={`text-[10px] ${note ? 'text-rose' : 'text-muted'}`}>
        {note ?? (disabled ? '' : e.entryHint)}
      </p>

      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <ListChip
            key={value}
            value={value}
            removeLabel={fill(p.remove, { value })}
            disabled={disabled}
            onRemove={() => onChange(values.filter((item) => item !== value))}
          />
        ))}
      </div>
    </section>
  );
}

/** What a threshold row's select currently holds; '' is "not set". */
function optionValue(quality: PolicyQuality, row: FilterRow): string {
  const value = quality[row.field];
  if (row.kind === 'flag') return value === true ? 'on' : '';
  return typeof value === 'number' ? String(value) : '';
}

/**
 * Access-rule editor -- design source frames `yOmm8` and `Eznsd`.
 *
 * The draft is a complete `WorkspacePolicy`; applying sends the saved version
 * and the draft, and the server pins a new immutable version holding the
 * difference. Only new requests see it (architecture.md 9.2), which the
 * footer says in as many words.
 */
export function PolicyEditor({
  initial,
  versionId: initialVersionId,
  reachable: initialReachable,
  canEdit,
  countAction,
  applyAction,
}: {
  initial: WorkspacePolicy;
  versionId: string | null;
  reachable: number;
  canEdit: boolean;
  countAction: CountAction;
  applyAction?: ApplyAction;
}) {
  const { locale, t } = useI18n();
  const p = t.dashboard.policies;
  const e = p.editor;
  const number = new Intl.NumberFormat(locale);
  const disabled = !canEdit;

  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [versionId, setVersionId] = useState(initialVersionId);
  const [savedReachable, setSavedReachable] = useState(initialReachable);
  const [draftReachable, setDraftReachable] = useState<number | null | 'unavailable'>(null);
  const [counting, setCounting] = useState(false);
  const [applying, startApply] = useTransition();
  const [outcome, setOutcome] = useState<'applied' | ApplyPolicyResult['error'] | null>(null);
  const latestCount = useRef(0);

  const dirty = !policyDiffIsEmpty(diffPolicy(saved, draft));

  /* The draft's count, debounced: the number the page shows before saving. */
  useEffect(() => {
    if (!dirty) {
      setDraftReachable(null);
      setCounting(false);
      return;
    }
    const ticket = ++latestCount.current;
    setCounting(true);
    const timer = setTimeout(async () => {
      const result = await countAction(draft);
      if (ticket !== latestCount.current) return;
      setDraftReachable(result.ok && result.reachable !== undefined ? result.reachable : 'unavailable');
      setCounting(false);
    }, COUNT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, dirty, countAction]);

  function edit(update: (current: WorkspacePolicy) => WorkspacePolicy) {
    if (disabled) return;
    setOutcome(null);
    setDraft(update);
  }

  /*
   * Every quality control writes the mode as well. The screen draws them
   * whenever the mode is not `select` -- including for a workspace that never
   * picked one -- so without this a threshold would be stored beside
   * `mode: null`, where the evaluator ignores it: the page would show a rule
   * that admitted everything.
   */
  function editQuality(update: (current: WorkspacePolicy) => WorkspacePolicy) {
    edit((current) => ({ ...update(current), mode: 'quality' }));
  }

  function setQuality(field: keyof PolicyQuality, value: string, row: FilterRow) {
    editQuality((current) => ({
      ...current,
      quality: {
        ...current.quality,
        [field]: row.kind === 'flag' ? value === 'on' : value === '' ? null : Number(value),
      },
    }));
  }

  function discard() {
    setDraft(saved);
    setOutcome(null);
  }

  function apply() {
    if (!applyAction) return;
    startApply(async () => {
      const result = await applyAction(saved, draft);
      if (result.ok && result.policy) {
        setSaved(result.policy);
        setDraft(result.policy);
        setVersionId(result.versionId ?? null);
        setSavedReachable(result.reachable ?? savedReachable);
        setOutcome('applied');
      } else {
        setOutcome(result.error ?? 'unavailable');
      }
    });
  }

  const enabledGroups = SOURCE_GROUPS.flatMap((group) => group.items).filter((group) =>
    sourceGroupEnabled(draft, group),
  );
  const totalGroups = SOURCE_GROUPS.reduce((sum, group) => sum + group.items.length, 0);
  /* A workspace that never picked a mode is shown the quality controls; every
     edit to one of them writes `mode: 'quality'`, so the draft that is saved
     says what the screen said (`editQuality`). */
  const mode = draft.mode ?? 'quality';

  const shownReachable =
    dirty && draftReachable !== null && draftReachable !== 'unavailable' ? draftReachable : savedReachable;

  const outcomeCopy: Record<NonNullable<typeof outcome>, string> = {
    applied: e.applied,
    access_denied: e.applyDenied,
    invalid: e.invalidDraft,
    unavailable: e.applyFailed,
  };

  return (
    <>
      {/* Source access -- design source `yOmm8`. */}
      <section className={`${PANEL} overflow-hidden p-0.5`}>
        <div className="flex flex-wrap items-start justify-between gap-[18px] px-6 py-5">
          <div className="flex flex-col gap-[5px]">
            <h2 className="text-[15px] leading-[1.5] text-ink">
              {p.sourcesTitle}
            </h2>
            <p className="text-[12px] text-muted">{p.sourcesDescription}</p>
          </div>
          <Badge tone="brand">
            {fill(p.enabledBadge, { on: enabledGroups.length, total: totalGroups })}
          </Badge>
        </div>

        <div className="px-6 pb-4">
          {SOURCE_GROUPS.map((group) => (
            <div key={group.title}>
              <p className="pt-3 pb-[7px] text-[11px] font-medium tracking-[0.04em] text-muted">
                {e[group.title]}
              </p>
              {group.items.map((id) => {
                const Icon = SOURCE_ICONS[id];
                const on = sourceGroupEnabled(draft, id);
                return (
                  <div key={id} className="flex items-center gap-2.5 py-[15px]">
                    <span className="flex size-[34px] shrink-0 items-center justify-center rounded-lg bg-subtle text-brandink">
                      <Icon size={17} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="text-[13px] text-ink">
                        {e.sources[id].name}
                      </span>
                      <span className="text-[11px] text-muted">
                        {e.sources[id].note}
                      </span>
                    </span>
                    <Toggle
                      on={on}
                      disabled={disabled}
                      onClick={() => edit((current) => withSourceGroup(current, id, !on))}
                      label={e.sources[id].name}
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </section>

      {/* Asset filter -- design source `yOmm8`. */}
      <section className={`${PANEL} overflow-hidden p-0.5`}>
        <div className="flex flex-col gap-[5px] px-6 py-5">
          <h2 className="text-[15px] leading-[1.5] text-ink">
            {p.filterTitle}
          </h2>
          <p className="text-[12px] text-muted">{p.filterDescription}</p>
        </div>

        <div className="flex flex-wrap gap-[9px] px-6 pb-[18px]">
          {(
            [
              { id: 'quality', ...p.modeQuality, Icon: SlidersIcon },
              { id: 'select', ...p.modeManual, Icon: ListChecksIcon },
            ] as const
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={disabled}
              onClick={() => edit((current) => ({ ...current, mode: option.id }))}
              aria-pressed={mode === option.id}
              className={`flex min-w-[240px] flex-1 items-center gap-[9px] rounded-md border p-[13px_15px] text-left transition-colors disabled:cursor-not-allowed ${
                mode === option.id ? 'border-brand bg-brandsoft' : 'border-line bg-subtle hover:bg-subtle'
              }`}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-card text-brandink">
                <option.Icon size={16} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[12px] font-medium text-steel">
                  {option.title}
                </span>
                <span className="text-[10px] text-muted">{option.note}</span>
              </span>
              {mode === option.id ? <CircleCheckIcon size={15} className="text-brandink" /> : null}
            </button>
          ))}
        </div>

        {mode === 'quality' ? (
          <div className="flex flex-col gap-[9px] px-6">
            {FILTER_GROUPS.map((group, groupIndex) => (
              <div key={group.title ?? groupIndex}>
                {group.title ? (
                  <h3 className="flex items-center gap-1.5 pt-3 pb-[7px] text-[11px] font-medium tracking-[0.04em] text-muted">
                    <BadgeCheckIcon size={13} />
                    {e[group.title]}
                  </h3>
                ) : null}
                <div className="overflow-hidden rounded-lg border border-line p-0.5">
                  {group.rows.map((row, index) => {
                    const current = optionValue(draft.quality, row);
                    const presets =
                      row.kind === 'flag'
                        ? []
                        : [...row.presets, ...(current !== '' && !row.presets.includes(Number(current)) ? [Number(current)] : [])].sort(
                            (a, b) => a - b,
                          );
                    return (
                      <label
                        key={row.id}
                        className={`flex h-12 items-center justify-between gap-[18px] pr-2.5 pl-[13px] ${
                          index > 0 ? 'border-t border-line' : ''
                        }`}
                      >
                        <span className="flex items-center gap-2 text-[12px] font-medium text-steel">
                          <row.Icon size={14} className="text-muted" />
                          {e.filters[row.id as FilterLabelKey]}
                        </span>
                        <select
                          value={current}
                          disabled={disabled}
                          onChange={(event) => setQuality(row.field, event.target.value, row)}
                          className="h-[30px] w-[125px] rounded-md border border-line bg-card px-1.5 text-[11px] text-steel focus:outline-none disabled:opacity-70"
                        >
                          {row.kind === 'flag' ? (
                            <>
                              <option value="on">{e.options[row.on]}</option>
                              <option value="">{e.options.any}</option>
                            </>
                          ) : (
                            <>
                              {presets.map((preset) => (
                                <option key={preset} value={String(preset)}>
                                  {row.kind === 'maxDays'
                                    ? fill(e.options.withinDays, { days: number.format(preset) })
                                    : fill(e.options.atLeast, { value: number.format(preset) })}
                                </option>
                              ))}
                              <option value="">{e.options.any}</option>
                            </>
                          )}
                        </select>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
            <p className="text-[10px] text-muted">{e.metricsNote}</p>
          </div>
        ) : null}

        <div className="flex flex-col gap-[22px] pt-[22px] pb-6">
          {mode === 'select' ? (
            <>
              {draft.allowedAssets.length === 0 ? (
                <p className="mx-6 rounded-lg border border-dashed border-line px-4 py-6 text-center text-[12px] text-muted">
                  {e.selectEmpty}
                </p>
              ) : null}
              <ListEditor
                icon={<ListChecksIcon size={14} />}
                title={e.selectTitle}
                description={e.selectDescription}
                values={draft.allowedAssets}
                disabled={disabled}
                onChange={(allowedAssets) => edit((current) => ({ ...current, allowedAssets }))}
              />
            </>
          ) : null}
          <ListEditor
            icon={<BanIcon size={14} />}
            title={p.blockedTitle}
            description={p.blockedDescription}
            values={draft.blockedAssets}
            disabled={disabled}
            onChange={(blockedAssets) => edit((current) => ({ ...current, blockedAssets }))}
          />
          {mode === 'quality' ? (
            <ListEditor
              icon={<BadgeCheckIcon size={14} />}
              title={p.allowedTitle}
              description={p.allowedDescription}
              values={draft.exceptedAssets}
              disabled={disabled}
              onChange={(exceptedAssets) =>
                editQuality((current) => ({ ...current, exceptedAssets }))
              }
            />
          ) : null}
        </div>

        <footer className="mx-4 mb-4 flex flex-col gap-3 rounded-md border border-line bg-card/96 p-3.5 shadow-md">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex min-w-[240px] flex-1 items-center justify-between gap-4 rounded-lg border border-brandline bg-brandsoft px-[15px] py-0.5">
              <span className="text-[12px] text-brandink">{p.reachable}</span>
              <span className="inline-flex items-center gap-2 text-[18px] leading-[1.5] font-medium text-brandink">
                {counting ? <SpinnerIcon size={14} className="animate-spin text-brandink" /> : null}
                {dirty && draftReachable === 'unavailable' && !counting
                  ? e.countUnavailable
                  : number.format(shownReachable)}
              </span>
            </div>
            <p className="text-[10px] text-muted">{dirty ? p.dirty : p.clean}</p>
            {canEdit ? (
              <>
                <button
                  type="button"
                  onClick={discard}
                  disabled={!dirty || applying}
                  className="h-[34px] rounded-md border border-line bg-card px-[11px] text-[11px] text-steel transition-colors hover:bg-subtle disabled:opacity-60"
                >
                  {p.discard}
                </button>
                <button
                  type="button"
                  onClick={apply}
                  disabled={!dirty || applying}
                  className="inline-flex h-[34px] items-center gap-1.5 rounded-md border border-brand bg-brand px-[11px] text-[11px] text-white transition-colors hover:bg-brand/90 disabled:opacity-60"
                >
                  {applying ? <SpinnerIcon size={12} className="animate-spin" /> : null}
                  {applying ? e.applying : p.apply}
                </button>
              </>
            ) : null}
          </div>
          <p
            role={outcome && outcome !== 'applied' ? 'alert' : 'status'}
            className={`text-[10px] ${
              outcome && outcome !== 'applied' ? 'text-rose' : 'text-muted'
            }`}
          >
            {outcome ? outcomeCopy[outcome] : e.newRequestsNote}
            {' · '}
            {versionId ? fill(e.versionLabel, { id: versionId.slice(0, 8) }) : e.noVersion}
          </p>
        </footer>
      </section>
    </>
  );
}
