'use client';

import { startTransition, useActionState, useId, useState } from 'react';
import { ConsoleDialog } from '@/components/admin/console-dialog';
import { ConsoleButton, Pill } from '@/components/admin/ui';
import { CircleCheckIcon, CircleXIcon, PlusIcon, SpinnerIcon } from '@/components/ui/icons';
import {
  Field,
  FIELD,
  PublicIdField,
  type PlatformAction as Action,
} from './platform-asset-shared';
import {
  formatBytes,
  PdfUploadField,
  usePdfUploads,
  type PrepareUploads,
} from '@/components/dashboard/pdf-uploader';
import {
  INDEX_DEPTHS,
  PLATFORM_ASSET_TYPES,
  REFRESH_POLICIES,
  UPLOAD_LIMITS,
  type PlatformAssetType,
} from '@/lib/domain/asset';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';

/**
 * "Create platform asset" -- design source frame `新建平台知识库`.
 *
 * The form is the create use case's input, field for field, and nothing else:
 * visibility, owner and lifecycle are not offered because they are not
 * decisions. A platform asset is public by definition, has no owner
 * workspace by rule (architecture.md 5.4), and starts as a draft because
 * nothing has been fetched yet.
 */
export function CreatePlatformAssetControl({
  action,
  prepare,
}: {
  action: Action;
  /** Upload tickets for a pdf asset's files; the browser uploads directly. */
  prepare: PrepareUploads;
}) {
  const { t } = useI18n();
  const p = t.admin.platformAssets;
  const [open, setOpen] = useState(false);
  /*
   * Bumped on close so the body is a fresh component next time it opens:
   * `useActionState` has no reset, and the previous attempt's refusal -- or its
   * success panel -- would otherwise still be on screen over an untouched form.
   */
  const [attempt, setAttempt] = useState(0);

  return (
    <>
      <ConsoleButton variant="primary" className="h-10 w-full" onClick={() => setOpen(true)}>
        <PlusIcon size={15} />
        {p.create}
      </ConsoleButton>

      {open ? (
        <CreateDialog
          key={attempt}
          action={action}
          prepare={prepare}
          onClose={() => {
            setOpen(false);
            setAttempt((value) => value + 1);
          }}
        />
      ) : null}
    </>
  );
}

function CreateDialog({
  action,
  prepare,
  onClose,
}: {
  action: Action;
  prepare: PrepareUploads;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const p = t.admin.platformAssets;
  const f = p.form;
  const [state, submit, pending] = useActionState(action, null);
  const formId = useId();
  const done = state?.ok === true;
  /* A pdf asset's files go to the store as they are picked; the form only
     ever posts the manifest of what landed (`components/dashboard/pdf-uploader`). */
  const uploads = usePdfUploads(prepare);

  /*
   * The source type is the only field the rest of the form depends on: it
   * decides which Asset ID namespace is legal and what a location may look
   * like. Held in state so the id field can print the namespace as a fixed
   * prefix and take only the slug, rather than let the operator type a prefix
   * the server will refuse.
   */
  const [sourceType, setSourceType] = useState<PlatformAssetType>('website');
  const isPdf = sourceType === 'pdf';

  return (
    <ConsoleDialog
      onClose={onClose}
      busy={pending}
      width="form"
      closeLabel={f.close}
      title={done ? f.doneTitle : f.title}
      description={done ? undefined : f.description}
      footer={(dismissBlocked) =>
        done ? (
          <ConsoleButton onClick={onClose}>{f.close}</ConsoleButton>
        ) : (
          <>
            {/* Follows the dialog's own guard rather than `pending`, so a
                request that never settles cannot leave this disabled forever. */}
            <ConsoleButton onClick={onClose} disabled={dismissBlocked}>
              {f.cancel}
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
                  {f.pending}
                </>
              ) : (
                f.submit
              )}
            </ConsoleButton>
          </>
        )
      }
    >
      {done ? (
        <p className="flex items-start gap-2 text-[12px] leading-[1.6] tracking-[-0.023em] text-pubink">
          <CircleCheckIcon size={15} className="mt-px shrink-0" />
          {fill(f.doneBody, { publicId: state?.publicId ?? '' })}
        </p>
      ) : (
        /*
         * Submitted through `onSubmit` rather than `action={submit}`, and the
         * difference matters here more than anywhere else in the console.
         * React resets an uncontrolled form after a function action settles,
         * so on a refusal this eight-field form would come back blank -- an
         * operator who mistyped one character would retype everything -- and
         * the reset would also put the source-type `<select>` back to its
         * first option while the React state behind the id prefix stayed where
         * it was, leaving the control and the prefix contradicting each other. The other console dialogs escape both because every field
         * they hold is prefilled, so a reset restores a value rather than
         * clearing one.
         */
        <form
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            startTransition(() => submit(data));
          }}
          className="flex flex-col gap-3"
        >
          {state?.error ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-[8px] bg-errsoft p-2.5 text-[11px] leading-[1.5] text-err"
            >
              <CircleXIcon size={15} className="mt-px shrink-0" />
              {p.errors[state.error]}
            </p>
          ) : null}

          <div className="flex items-center gap-2.5 rounded-[8px] border-2 border-line bg-subtle px-2.5 py-2.5">
            <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <span className="text-[11px] font-semibold tracking-[-0.023em] text-steel">
                {f.noticeTitle}
              </span>
              <span className="text-[11px] leading-[1.5] tracking-[-0.023em] text-muted">
                {f.noticeBody}
              </span>
            </span>
            <Pill tone="brand">{f.publicPill}</Pill>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={f.fieldTitle}>
              <input
                name="title"
                required
                maxLength={120}
                data-dialog-autofocus
                placeholder={f.placeholderTitle}
                className={FIELD}
              />
            </Field>
            <PublicIdField
              label={f.fieldPublicId}
              sourceType={sourceType}
              hint={sourceType === 'github' ? f.hintPublicIdRepo : f.hintPublicId}
              placeholder={
                sourceType === 'github' ? f.placeholderPublicIdRepo : f.placeholderPublicId
              }
            />

            <Field label={f.fieldSource}>
              <select
                name="sourceType"
                value={sourceType}
                onChange={(event) => setSourceType(event.target.value as PlatformAssetType)}
                className={FIELD}
              >
                {PLATFORM_ASSET_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {p.sourceTypes[type]}
                  </option>
                ))}
              </select>
            </Field>
            {isPdf ? (
              /* Derived server side: the prefix the uploads were keyed under. */
              <input type="hidden" name="location" value="" />
            ) : (
              <Field label={f.fieldLocation} hint={f.hintLocation}>
                <input
                  name="location"
                  required
                  maxLength={500}
                  placeholder={f.placeholderLocation}
                  className={FIELD}
                />
              </Field>
            )}

            <Field label={f.fieldTag}>
              <input
                name="domainTag"
                maxLength={40}
                placeholder={f.placeholderTag}
                className={FIELD}
              />
            </Field>
            <Field label={f.fieldLanguage}>
              <input
                name="language"
                maxLength={40}
                placeholder={f.placeholderLanguage}
                className={FIELD}
              />
            </Field>
          </div>

          <Field label={f.fieldDescription}>
            <textarea
              name="description"
              maxLength={400}
              rows={3}
              placeholder={f.placeholderDescription}
              className={`${FIELD} h-auto py-2 leading-[1.55]`}
            />
          </Field>

          {sourceType === 'website' ? (
            <Field
              label={t.admin.platformAssetDetail.sourceDialog.fieldIndexDepth}
              hint={t.admin.platformAssetDetail.sourceDialog.hintIndexDepth}
            >
              <select name="indexDepth" defaultValue="0" className={FIELD}>
                {INDEX_DEPTHS.map((depth) => (
                  <option key={depth} value={depth}>
                    {t.admin.platformAssetDetail.sourceDialog.indexDepths[depth]}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          {isPdf ? (
            <>
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
          ) : null}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {isPdf ? (
              /* Always manual for a pdf asset; the server forces it too. */
              <input type="hidden" name="refreshPolicy" value="manual" />
            ) : (
              <Field label={f.fieldRefresh}>
                <select name="refreshPolicy" defaultValue="daily" className={FIELD}>
                  {REFRESH_POLICIES.map((policy) => (
                    <option key={policy} value={policy}>
                      {p.refreshPolicies[policy]}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={f.reason}>
              <input
                name="reason"
                required
                maxLength={200}
                placeholder={f.reasonPlaceholder}
                className={FIELD}
              />
            </Field>
          </div>

          <p className="text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">
            {isPdf ? f.pdfNote : f.note}
          </p>
        </form>
      )}
    </ConsoleDialog>
  );
}
