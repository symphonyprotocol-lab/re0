'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useId, useState } from 'react';
import { DeleteLibraryControl, type DeleteLibraryAction, type DeleteLibraryTarget } from '@/components/dashboard/library-delete';
import { PANEL } from '@/components/dashboard/ui';
import {
  ArrowUpRightIcon,
  BanIcon,
  CheckIcon,
  CircleCheckIcon,
  CircleXIcon,
  SpinnerIcon,
} from '@/components/ui/icons';
import type {
  EditLibraryMetadataActionResult,
  OwnerLifecycleActionResult,
  UpdateParseScopeActionResult,
} from '@/app/dashboard/libraries/[libraryId]/actions';
import type { Visibility } from '@/lib/domain';
import {
  INDEX_DEPTHS,
  parseScopeApplies,
  REFRESH_POLICIES,
  refreshPolicyEditable,
  type OwnerLifecycleAction,
  type ParseScope,
  type RefreshPolicy,
  type ReviewPipelineEntry,
} from '@/lib/domain/library';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';

/**
 * The owner's management controls on a library's page (requirement.md 5.2):
 * pause / resume / resubmit, the metadata form, the parse-scope form, and
 * delete, beside the rebuild button. Every control posts to an action that
 * re-checks the role; a non-manager is not shown them at all, and the page
 * says so (`manage.readOnly`).
 */

export const FIELD =
  'h-9 w-full rounded-md border border-line bg-card px-2.5 text-[12px] text-ink placeholder:text-muted/70 focus:border-brand focus:outline-none';
export const AREA =
  'min-h-[72px] w-full rounded-md border border-line bg-card px-2.5 py-2 font-mono text-[11.5px] leading-[1.6] text-ink placeholder:text-muted/70 focus:border-brand focus:outline-none';
export const PRIMARY =
  'inline-flex h-[35px] items-center gap-1.5 rounded-md bg-brand px-3.5 text-[12px] font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-40';
export const SECONDARY =
  'inline-flex h-[35px] items-center gap-1.5 rounded-md border border-line bg-card px-3 text-[12px] font-medium text-ink transition-colors hover:bg-subtle disabled:opacity-40';

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-steel">{label}</span>
      {children}
      {hint ? <span className="text-[10px] text-muted">{hint}</span> : null}
    </label>
  );
}

export function ResultLine({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <p
      role={ok ? 'status' : 'alert'}
      className={`flex items-start gap-1.5 text-[11.5px] leading-[1.5] ${
        ok ? 'text-brandink' : 'text-rose'
      }`}
    >
      {ok ? <CircleCheckIcon size={14} className="mt-px shrink-0" /> : <CircleXIcon size={14} className="mt-px shrink-0" />}
      <span>{children}</span>
    </p>
  );
}

/* ---------------------------------------------------------- pipeline strip */

/**
 * The public publishing pipeline requirement.md 5.2 names, with where this
 * library stands in it (`reviewPipeline`). The expected time sits on the
 * human step and the reviewer's note under it, so an owner reads all three
 * in one place.
 */
export function ReviewPipeline({
  entries,
  note,
  compact = false,
}: {
  entries: ReviewPipelineEntry[];
  /** The latest reviewer feedback, if any. */
  note?: string | null;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const p = t.dashboard.libraries.manage.pipeline;
  const reviewActive = entries.some((entry) => entry.step === 'review' && entry.state === 'active');
  return (
    <div className={`flex flex-col ${compact ? 'gap-1.5' : 'gap-3'}`}>
      <ol className={`flex flex-wrap ${compact ? 'gap-x-3 gap-y-1' : 'gap-x-5 gap-y-2'}`}>
        {entries.map((entry, index) => (
          <li
            key={entry.step}
            className={`flex items-center gap-1.5 ${compact ? 'text-[10.5px]' : 'text-[12px]'}`}
          >
            <span
              aria-hidden
              className={`flex shrink-0 items-center justify-center rounded-full ${
                compact ? 'size-[16px] text-[9px]' : 'size-[20px] text-[10px]'
              } ${
                entry.state === 'done'
                  ? 'bg-brand text-white'
                  : entry.state === 'active'
                    ? 'bg-brandsoft text-brandink ring-2 ring-brand'
                    : entry.state === 'blocked'
                      ? 'bg-errsoft text-err'
                      : 'bg-mutedbg text-muted'
              }`}
            >
              {entry.state === 'done' ? <CheckIcon size={compact ? 9 : 11} /> : index + 1}
            </span>
            <span className={entry.state === 'pending' ? 'text-muted' : 'text-ink'}>
              {p.steps[entry.step]}
            </span>
            <span className="sr-only">{p.states[entry.state]}</span>
          </li>
        ))}
      </ol>
      {reviewActive ? (
        <p className={`${compact ? 'text-[10.5px]' : 'text-[11px]'} text-muted`}>
          {p.expected}
        </p>
      ) : null}
      {note ? (
        <p className={`${compact ? 'text-[10.5px]' : 'text-[11px]'} leading-[1.5] text-rose`}>
          {fill(p.feedback, { note })}
        </p>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------- owner actions */

export type OwnerLifecycleFormAction = (
  previous: OwnerLifecycleActionResult | null,
  form: FormData,
) => Promise<OwnerLifecycleActionResult>;

const ACTION_ICONS: Record<OwnerLifecycleAction, (props: { size?: number }) => React.ReactElement> = {
  pause: BanIcon,
  resume: CheckIcon,
  resubmit: ArrowUpRightIcon,
};

/**
 * One owner verb: a button that opens an inline confirmation, then posts.
 * The result is spoken under the button -- "paused, N refreshes cancelled"
 * -- and the page is pulled again so the banner and badge follow.
 */
export function OwnerActionButton({
  libraryId,
  publicId,
  action,
  verb,
}: {
  libraryId: string;
  publicId: string;
  action: OwnerLifecycleFormAction;
  verb: OwnerLifecycleAction;
}) {
  const { t } = useI18n();
  const m = t.dashboard.libraryDetail.manage;
  const [state, formAction, pending] = useActionState(action, null);
  const [confirming, setConfirming] = useState(false);
  const router = useRouter();
  const Icon = ACTION_ICONS[verb];

  useEffect(() => {
    if (state?.ok) {
      setConfirming(false);
      router.refresh();
    }
  }, [state, router]);

  const confirmText = verb === 'pause' ? m.pauseConfirm : verb === 'resume' ? m.resumeConfirm : m.resubmitConfirm;
  const label = verb === 'pause' ? m.pause : verb === 'resume' ? m.resume : m.resubmit;

  return (
    <div className="flex flex-col items-end gap-1.5">
      {confirming ? (
        <form action={formAction} className="flex max-w-[300px] flex-col gap-2 rounded-md border border-line bg-subtle p-2.5">
          <input type="hidden" name="libraryId" value={libraryId} />
          <input type="hidden" name="action" value={verb} />
          <p className="text-[11px] leading-[1.5] text-steel">{confirmText}</p>
          <span className="flex justify-end gap-2">
            <button type="button" onClick={() => setConfirming(false)} disabled={pending} className={SECONDARY}>
              {m.cancel}
            </button>
            <button type="submit" disabled={pending} className={verb === 'pause' ? `${PRIMARY} bg-rose hover:bg-rose/90` : PRIMARY}>
              {pending ? <SpinnerIcon size={14} className="motion-safe:animate-spin" /> : <Icon size={14} />}
              {pending ? m.working : m.confirm}
            </button>
          </span>
        </form>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className={SECONDARY}>
          <Icon size={14} />
          {label}
        </button>
      )}
      {state ? (
        <span className="max-w-[300px] text-right">
          <ResultLine ok={state.ok}>
            {state.ok && state.action
              ? fill(m.results[state.action], { publicId, n: String(state.cancelledOperations ?? 0) })
              : m.errors[state.error ?? 'unavailable']}
          </ResultLine>
        </span>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------- delete (detail) */

/** The list's delete dialog on the detail page; a deleted library's page leaves. */
export function DetailDeleteControl({
  action,
  target,
}: {
  action: DeleteLibraryAction;
  target: DeleteLibraryTarget;
}) {
  const router = useRouter();
  return (
    <DeleteLibraryControl
      action={action}
      target={target}
      variant="button"
      onDeleted={() => router.push('/dashboard/libraries')}
    />
  );
}

/* --------------------------------------------------------- metadata form */

export type EditMetadataFormAction = (
  previous: EditLibraryMetadataActionResult | null,
  form: FormData,
) => Promise<EditLibraryMetadataActionResult>;

export function LibraryMetadataForm({
  libraryId,
  initial,
  action,
}: {
  libraryId: string;
  initial: { title: string; description: string | null; language: string | null; visibility: Visibility };
  action: EditMetadataFormAction;
}) {
  const { t } = useI18n();
  const m = t.dashboard.libraryDetail.manage.metadata;
  const [state, formAction, pending] = useActionState(action, null);
  const [visibility, setVisibility] = useState<Visibility>(initial.visibility);
  const router = useRouter();
  const formId = useId();

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  return (
    <form action={formAction} id={formId} className={`${PANEL} flex flex-col gap-4 p-6`}>
      <input type="hidden" name="libraryId" value={libraryId} />
      <div className="flex flex-col gap-[3px]">
        <h2 className="text-[15px] font-medium text-ink">{m.title}</h2>
        <p className="text-[11px] text-muted">{m.description}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={m.titleLabel}>
          <input name="title" defaultValue={initial.title} maxLength={120} required className={FIELD} />
        </Field>
        <Field label={m.languageLabel} hint={m.languageHint}>
          <input name="language" defaultValue={initial.language ?? ''} maxLength={40} className={FIELD} />
        </Field>
        <div className="sm:col-span-2">
          <Field label={m.descriptionLabel}>
            <input name="description" defaultValue={initial.description ?? ''} maxLength={400} className={FIELD} />
          </Field>
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-[11px] font-medium text-steel">{m.visibilityLabel}</span>
          <input type="hidden" name="visibility" value={visibility} />
          <div className="grid gap-2.5 sm:grid-cols-2">
            {(['public', 'private'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setVisibility(option)}
                aria-pressed={visibility === option}
                className={`rounded-md border px-3 py-2.5 text-left text-[12px] transition-colors ${
                  visibility === option ? 'border-brand bg-brandsoft text-ink' : 'border-line bg-card text-steel hover:bg-subtle'
                }`}
              >
                {option === 'public' ? m.visibilityPublic : m.visibilityPrivate}
              </button>
            ))}
          </div>
          <span className="text-[10px] leading-[1.5] text-muted">{m.visibilityNote}</span>
        </div>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <span className="min-w-0 flex-1">
          {state ? (
            <ResultLine ok={state.ok}>
              {state.ok ? (state.queuedForReview ? m.savedQueued : m.saved) : m.errors[state.error ?? 'unavailable']}
            </ResultLine>
          ) : null}
        </span>
        <button type="submit" disabled={pending} className={PRIMARY}>
          {pending ? <SpinnerIcon size={14} className="motion-safe:animate-spin" /> : null}
          {pending ? m.pending : m.submit}
        </button>
      </footer>
    </form>
  );
}

/* ------------------------------------------------------- parse scope form */

export type UpdateParseScopeFormAction = (
  previous: UpdateParseScopeActionResult | null,
  form: FormData,
) => Promise<UpdateParseScopeActionResult>;

/**
 * The parse scope, under the names `re0.json` uses (requirement.md 7.2) so
 * a reader of either sees one vocabulary. One path or glob per line. The
 * refresh cadence sits in the same form for the sources that have one.
 */
export function ParseScopeForm({
  libraryId,
  sourceType,
  scope,
  refreshPolicy,
  action,
}: {
  libraryId: string;
  sourceType: string;
  scope: ParseScope;
  refreshPolicy: RefreshPolicy | null;
  action: UpdateParseScopeFormAction;
}) {
  const { t } = useI18n();
  const m = t.dashboard.libraryDetail.manage.scope;
  const w = t.dashboard.newLibrary.wizard;
  const [state, formAction, pending] = useActionState(action, null);
  const router = useRouter();
  const scoped = parseScopeApplies(sourceType);
  const cadence = refreshPolicyEditable(sourceType);

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  if (!scoped && !cadence) {
    return (
      <section className={`${PANEL} flex flex-col gap-2 p-6`}>
        <h2 className="text-[15px] font-medium text-ink">{m.title}</h2>
        <p className="text-[11px] text-muted">{m.unsupported}</p>
        <p className="text-[11px] text-muted">{m.refreshPolicyHint}</p>
      </section>
    );
  }

  return (
    <form action={formAction} className={`${PANEL} flex flex-col gap-4 p-6`}>
      <input type="hidden" name="libraryId" value={libraryId} />
      <div className="flex flex-col gap-[3px]">
        <h2 className="text-[15px] font-medium text-ink">{m.title}</h2>
        <p className="text-[11px] leading-[1.5] text-muted">
          {scoped ? m.description : m.unsupported}
        </p>
      </div>
      {scoped ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={m.foldersLabel} hint={m.foldersHint}>
            <textarea name="folders" defaultValue={scope.folders.join('\n')} spellCheck={false} className={AREA} />
          </Field>
          <Field label={m.excludeFoldersLabel} hint={m.excludeFoldersHint}>
            <textarea
              name="excludeFolders"
              defaultValue={scope.excludeFolders.join('\n')}
              spellCheck={false}
              className={AREA}
            />
          </Field>
          <Field label={m.excludeFilesLabel} hint={m.excludeFilesHint}>
            <textarea
              name="excludeFiles"
              defaultValue={scope.excludeFiles.join('\n')}
              spellCheck={false}
              className={AREA}
            />
          </Field>
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {sourceType === 'website' || sourceType === 'llms_txt' ? (
          <Field label={m.indexDepthLabel} hint={w.indexDepthHint}>
            <select name="indexDepth" defaultValue={String(scope.indexDepth)} className={FIELD}>
              {INDEX_DEPTHS.map((depth) => (
                <option key={depth} value={depth}>
                  {w.indexDepths[depth]}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {cadence ? (
          <Field label={m.refreshPolicyLabel}>
            <select name="refreshPolicy" defaultValue={refreshPolicy ?? 'manual'} className={FIELD}>
              {REFRESH_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {m.refreshPolicies[policy]}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <span className="min-w-0 flex-1">
          {state ? (
            <ResultLine ok={state.ok}>
              {state.ok
                ? state.rebuildAdvised
                  ? m.savedRebuild
                  : m.saved
                : state.error === 'invalid_scope'
                  ? fill(m.errors.invalid_scope, { detail: state.detail ?? '—' })
                  : m.errors[state.error ?? 'unavailable']}
            </ResultLine>
          ) : null}
        </span>
        <button type="submit" disabled={pending} className={PRIMARY}>
          {pending ? <SpinnerIcon size={14} className="motion-safe:animate-spin" /> : null}
          {pending ? m.pending : m.submit}
        </button>
      </footer>
    </form>
  );
}
