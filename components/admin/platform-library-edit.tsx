'use client';

import { useActionState, useEffect, useId, useState } from 'react';
import { ConsoleDialog } from '@/components/admin/console-dialog';
import { ConsoleButton, IconButton } from '@/components/admin/ui';
import { CircleXIcon, PencilIcon, PlusIcon, SpinnerIcon, TrashIcon } from '@/components/ui/icons';
import {
  PLATFORM_LIBRARY_TYPES,
  UPLOAD_LIMITS,
  REFRESH_POLICIES,
  type PlatformLibraryType,
  type RefreshPolicy,
  INDEX_DEPTHS,
  type IndexDepth,
} from '@/lib/domain/library';
import {
  formatBytes,
  PdfUploadField,
  usePdfUploads,
  type PrepareUploads,
} from '@/components/dashboard/pdf-uploader';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';
import {
  Field,
  FIELD,
  PublicIdField,
  ReasonField,
  Refusal,
  submitOn,
  TargetCard,
  type PlatformAction as Action,
  type PlatformLibraryTarget,
} from './platform-library-shared';

/**
 * Editing a platform library: its catalogue fields, and its sources.
 *
 * requirement.md 5.3 gives the console four verbs over a platform library, and
 * these are not among them -- but all four assume a library whose title,
 * description and source location are right, and until now the only way to fix
 * a mistyped location was to create a second library and abandon the first.
 * Correcting a record is maintenance of the same four verbs, not a fifth one:
 * nothing here changes whether a library is served, which is what the lifecycle
 * verbs decide.
 *
 * Every dialog takes a reason and is audited, exactly like the four.
 */

/* -------------------------------------------------------------- metadata */

export function EditPlatformLibraryControl({
  action,
  target,
  library,
}: {
  action: Action;
  target: PlatformLibraryTarget;
  library: {
    title: string;
    publicId: string;
    description: string | null;
    domainTag: string | null;
    language: string | null;
    sourceType: PlatformLibraryType;
  };
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);

  return (
    <>
      <ConsoleButton onClick={() => setOpen(true)}>
        <PencilIcon size={14} />
        {t.admin.platformLibraryDetail.actions.edit}
      </ConsoleButton>

      {open ? (
        <EditDialog
          key={attempt}
          action={action}
          target={target}
          library={library}
          onClose={() => {
            setOpen(false);
            setAttempt((value) => value + 1);
          }}
        />
      ) : null}
    </>
  );
}

function EditDialog({
  action,
  target,
  library,
  onClose,
}: {
  action: Action;
  target: PlatformLibraryTarget;
  library: {
    title: string;
    publicId: string;
    description: string | null;
    domainTag: string | null;
    language: string | null;
    sourceType: PlatformLibraryType;
  };
  onClose: () => void;
}) {
  const { t } = useI18n();
  const d = t.admin.platformLibraryDetail;
  const e = d.editDialog;
  const [state, submit, pending] = useActionState(action, null);
  const formId = useId();

  /*
   * Closes on success. The page behind has been revalidated and shows the new
   * title in its header, which is a better confirmation than a panel saying so.
   */
  useEffect(() => {
    if (state?.ok) onClose();
  }, [state, onClose]);

  return (
    <ConsoleDialog
      onClose={onClose}
      busy={pending}
      width="form"
      closeLabel={d.close}
      title={e.title}
      description={e.description}
      footer={(dismissBlocked) => (
        <>
          <ConsoleButton onClick={onClose} disabled={dismissBlocked}>
            {d.cancel}
          </ConsoleButton>
          <ConsoleButton variant="primary" type="submit" form={formId} disabled={pending}>
            {pending ? (
              <>
                <SpinnerIcon size={14} className="motion-safe:animate-spin" />
                {e.pending}
              </>
            ) : (
              e.submit
            )}
          </ConsoleButton>
        </>
      )}
    >
      <form id={formId} onSubmit={submitOn(submit)} className="flex flex-col gap-3">
        <input type="hidden" name="libraryId" value={target.id} />
        <Refusal state={state} />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={e.fieldTitle}>
            <input
              name="title"
              required
              maxLength={120}
              defaultValue={library.title}
              data-dialog-autofocus
              className={FIELD}
            />
          </Field>
          <PublicIdField
            label={e.fieldPublicId}
            sourceType={library.sourceType}
            defaultValue={library.publicId}
            hint={library.sourceType === 'github' ? e.hintPublicIdRepo : e.hintPublicId}
            placeholder={
              library.sourceType === 'github' ? e.placeholderPublicIdRepo : e.placeholderPublicId
            }
          />
          <Field label={e.fieldTag}>
            <input
              name="domainTag"
              maxLength={40}
              defaultValue={library.domainTag ?? ''}
              className={FIELD}
            />
          </Field>
          <Field label={e.fieldLanguage}>
            <input
              name="language"
              maxLength={40}
              defaultValue={library.language ?? ''}
              className={FIELD}
            />
          </Field>
        </div>

        <Field label={e.fieldDescription}>
          <textarea
            name="description"
            maxLength={400}
            rows={3}
            defaultValue={library.description ?? ''}
            className={`${FIELD} h-auto py-2 leading-[1.55]`}
          />
        </Field>

        <ReasonField
          label={e.reason}
          placeholder={e.reasonPlaceholder}
          ariaLabel={e.reason}
          autoFocus={false}
        />
        <p className="text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">{e.renameNote}</p>
      </form>
    </ConsoleDialog>
  );
}

/* --------------------------------------------------------------- sources */

export interface PlatformSourceRow {
  id: string;
  type: string;
  location: string;
  refreshPolicy: RefreshPolicy | 'unknown';
  indexDepth: IndexDepth;
}

export function AddPlatformSourceControl({
  action,
  target,
  prepare,
}: {
  action: Action;
  target: PlatformLibraryTarget;
  /** Upload tickets for a pdf source's files; the browser uploads directly. */
  prepare: PrepareUploads;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);

  return (
    <>
      <ConsoleButton onClick={() => setOpen(true)}>
        <PlusIcon size={14} />
        {t.admin.platformLibraryDetail.sources.add}
      </ConsoleButton>

      {open ? (
        <SourceDialog
          key={attempt}
          action={action}
          target={target}
          prepare={prepare}
          source={null}
          onClose={() => {
            setOpen(false);
            setAttempt((value) => value + 1);
          }}
        />
      ) : null}
    </>
  );
}

export function EditPlatformSourceControl({
  action,
  target,
  source,
}: {
  action: Action;
  target: PlatformLibraryTarget;
  source: PlatformSourceRow;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);

  return (
    <>
      <IconButton
        label={t.admin.platformLibraryDetail.sources.edit}
        onClick={() => setOpen(true)}
      >
        <PencilIcon size={14} />
      </IconButton>

      {open ? (
        <SourceDialog
          key={attempt}
          action={action}
          target={target}
          source={source}
          onClose={() => {
            setOpen(false);
            setAttempt((value) => value + 1);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * One dialog for adding and for editing, because they differ in two fields.
 *
 * On an edit the source type is shown but not submitted: changing it would
 * leave every version already built from the old type claiming to have come
 * from the new one, so the use case ignores it and the control does not pretend
 * otherwise.
 */
function SourceDialog({
  action,
  target,
  source,
  prepare,
  onClose,
}: {
  action: Action;
  target: PlatformLibraryTarget;
  source: PlatformSourceRow | null;
  /** Absent on an edit: a pdf source is never edited here. */
  prepare?: PrepareUploads;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const d = t.admin.platformLibraryDetail;
  const p = t.admin.platformLibraries;
  const f = p.form;
  const copy = source ? d.sourceDialog.edit : d.sourceDialog.add;
  const [state, submit, pending] = useActionState(action, null);
  const formId = useId();
  const [sourceType, setSourceType] = useState<PlatformLibraryType>(
    (source?.type as PlatformLibraryType) ?? 'website',
  );
  const isPdf = sourceType === 'pdf';
  const uploads = usePdfUploads(prepare ?? (async () => ({ ok: false, maxFileBytes: 0, error: 'unavailable' })));

  useEffect(() => {
    if (state?.ok) onClose();
  }, [state, onClose]);

  return (
    <ConsoleDialog
      onClose={onClose}
      busy={pending}
      width="form"
      closeLabel={d.close}
      title={copy.title}
      description={copy.description}
      footer={(dismissBlocked) => (
        <>
          <ConsoleButton onClick={onClose} disabled={dismissBlocked}>
            {d.cancel}
          </ConsoleButton>
          <ConsoleButton
            variant="primary"
            type="submit"
            form={formId}
            disabled={pending || (isPdf && !uploads.settled)}
          >
            {pending ? (
              <>
                <SpinnerIcon size={14} className="motion-safe:animate-spin" />
                {copy.pending}
              </>
            ) : (
              copy.submit
            )}
          </ConsoleButton>
        </>
      )}
    >
      <form id={formId} onSubmit={submitOn(submit)} className="flex flex-col gap-3">
        <input type="hidden" name="libraryId" value={target.id} />
        {source ? <input type="hidden" name="sourceId" value={source.id} /> : null}
        <Refusal state={state} />
        <TargetCard target={target} />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={d.sourceDialog.fieldType} hint={source ? d.sourceDialog.typeLocked : undefined}>
            <select
              name={source ? undefined : 'sourceType'}
              value={sourceType}
              disabled={Boolean(source)}
              onChange={(event) => setSourceType(event.target.value as PlatformLibraryType)}
              className={`${FIELD} disabled:text-muted`}
            >
              {PLATFORM_LIBRARY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {p.sourceTypes[type]}
                </option>
              ))}
            </select>
          </Field>
          {isPdf ? (
            /* Always manual for a pdf source; the server forces it too. */
            <input type="hidden" name="refreshPolicy" value="manual" />
          ) : (
            <Field label={d.sourceDialog.fieldRefresh}>
              <select
                name="refreshPolicy"
                defaultValue={
                  source && source.refreshPolicy !== 'unknown' ? source.refreshPolicy : 'daily'
                }
                className={FIELD}
              >
                {REFRESH_POLICIES.map((policy) => (
                  <option key={policy} value={policy}>
                    {p.refreshPolicies[policy]}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>

        {sourceType === 'website' ? (
          <Field label={d.sourceDialog.fieldIndexDepth} hint={d.sourceDialog.hintIndexDepth}>
            <select name="indexDepth" defaultValue={String(source?.indexDepth ?? 0)} className={FIELD}>
              {INDEX_DEPTHS.map((depth) => (
                <option key={depth} value={depth}>
                  {d.sourceDialog.indexDepths[depth]}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        {isPdf ? (
          <>
            {/* Derived server side: the prefix the uploads were keyed under. */}
            <input type="hidden" name="location" value="" />
            <PdfUploadField
              state={uploads}
              label={f.fieldFiles}
              hint={fill(f.hintFiles, {
                max: String(UPLOAD_LIMITS.maxFiles),
                size: formatBytes(UPLOAD_LIMITS.maxFileBytes),
              })}
            />
            <input type="hidden" name="uploads" value={uploads.manifest} />
          </>
        ) : (
          <Field label={d.sourceDialog.fieldLocation} hint={d.sourceDialog.hintLocation}>
            <input
              name="location"
              required
              maxLength={500}
              defaultValue={source?.location ?? ''}
              data-dialog-autofocus
              className={FIELD}
            />
          </Field>
        )}

        <ReasonField
          label={copy.reason}
          placeholder={copy.reasonPlaceholder}
          ariaLabel={copy.reason}
          autoFocus={false}
        />
        <p className="text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">{d.auditNote}</p>
      </form>
    </ConsoleDialog>
  );
}

/**
 * Removing a source.
 *
 * Offered on every row; the last one is refused by the use case rather than
 * hidden here, because "why is this button missing" is a worse question than a
 * sentence explaining that a library keeps at least one source.
 */
export function RemovePlatformSourceControl({
  action,
  target,
  source,
}: {
  action: Action;
  target: PlatformLibraryTarget;
  source: PlatformSourceRow;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);

  return (
    <>
      <IconButton
        label={t.admin.platformLibraryDetail.sources.remove}
        onClick={() => setOpen(true)}
      >
        <TrashIcon size={14} />
      </IconButton>

      {open ? (
        <RemoveDialog
          key={attempt}
          action={action}
          target={target}
          source={source}
          onClose={() => {
            setOpen(false);
            setAttempt((value) => value + 1);
          }}
        />
      ) : null}
    </>
  );
}

function RemoveDialog({
  action,
  target,
  source,
  onClose,
}: {
  action: Action;
  target: PlatformLibraryTarget;
  source: PlatformSourceRow;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const d = t.admin.platformLibraryDetail;
  const r = d.removeSourceDialog;
  const [state, submit, pending] = useActionState(action, null);
  const formId = useId();

  useEffect(() => {
    if (state?.ok) onClose();
  }, [state, onClose]);

  return (
    <ConsoleDialog
      onClose={onClose}
      busy={pending}
      closeLabel={d.close}
      title={r.title}
      description={r.description}
      footer={(dismissBlocked) => (
        <>
          <ConsoleButton onClick={onClose} disabled={dismissBlocked}>
            {d.cancel}
          </ConsoleButton>
          <ConsoleButton
            variant="primary"
            type="submit"
            form={formId}
            disabled={pending}
            className="bg-err hover:bg-err/90"
          >
            {pending ? (
              <>
                <SpinnerIcon size={14} className="motion-safe:animate-spin" />
                {r.pending}
              </>
            ) : (
              r.submit
            )}
          </ConsoleButton>
        </>
      )}
    >
      <form id={formId} onSubmit={submitOn(submit)} className="flex flex-col gap-3">
        <input type="hidden" name="libraryId" value={target.id} />
        <input type="hidden" name="sourceId" value={source.id} />
        <Refusal state={state} />

        <div className="flex items-start gap-2 rounded-[8px] border-2 border-line bg-subtle px-2.5 py-2.5">
          <CircleXIcon size={15} className="mt-px shrink-0 text-err" />
          <span className="min-w-0 break-all text-[11px] leading-[1.55] tracking-[-0.023em] text-steel">
            {source.location}
          </span>
        </div>

        <p className="text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">{r.versionsNote}</p>
        <ReasonField label={r.reason} placeholder={r.reasonPlaceholder} ariaLabel={r.reason} />
        <p className="text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">{d.auditNote}</p>
      </form>
    </ConsoleDialog>
  );
}
