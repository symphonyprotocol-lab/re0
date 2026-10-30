'use client';

import { useActionState, useEffect, useId, useState } from 'react';
import { ConsoleDialog } from '@/components/admin/console-dialog';
import { ConsoleButton, IconButton } from '@/components/admin/ui';
import {
  BanIcon,
  CircleCheckIcon,
  CircleXIcon,
  RefreshIcon,
  SparklesIcon,
  SpinnerIcon,
  TrashIcon,
} from '@/components/ui/icons';
import type { PlatformLifecycleAction } from '@/lib/domain/asset';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';
import {
  Refusal,
  ReasonField,
  submitOn,
  TargetCard,
  type PlatformAction as Action,
  type PlatformAssetTarget,
} from './platform-asset-shared';

export type { PlatformAssetTarget } from './platform-asset-shared';

/**
 * Queue a refresh -- design source frames `d5LpW4` (row control) and
 * `平台知识库详情` (page action).
 *
 * A confirmation with a required reason rather than a one-click button, for the
 * same reason every other console mutation has one: requirement.md 5.3 records
 * the operator, the target, the reason and the outcome of each administrative
 * action, and there is no reason to record if nobody was asked for one.
 *
 * The dialog is honest about what confirming does. It queues a Refresh
 * Operation and returns; the fetch happens afterwards, on a worker, and may
 * find nothing changed. Saying "synced" here would be the one sentence on this
 * screen that is not true.
 */
export function PlatformRefreshControl({
  action,
  target,
  source,
  variant = 'icon',
  disabled = false,
}: {
  action: Action;
  target: PlatformAssetTarget;
  /** Refresh this one source only; absent means the whole asset. */
  source?: { id: string; location: string };
  variant?: 'icon' | 'button';
  /** Archived assets are not refreshed; the control says so rather than failing. */
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const label = source
    ? t.admin.platformAssetDetail.actions.refreshSource
    : t.admin.platformAssetDetail.actions.refresh;
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);

  return (
    <>
      {variant === 'icon' ? (
        <IconButton label={label} disabled={disabled} onClick={() => setOpen(true)}>
          <RefreshIcon size={14} />
        </IconButton>
      ) : (
        <ConsoleButton disabled={disabled} onClick={() => setOpen(true)}>
          <RefreshIcon size={14} />
          {label}
        </ConsoleButton>
      )}

      {open ? (
        <RefreshDialog
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

function RefreshDialog({
  action,
  target,
  source,
  onClose,
}: {
  action: Action;
  target: PlatformAssetTarget;
  source?: { id: string; location: string };
  onClose: () => void;
}) {
  const { t } = useI18n();
  const d = t.admin.platformAssetDetail;
  const r = d.refreshDialog;
  const [state, submit, pending] = useActionState(action, null);
  const formId = useId();
  const done = state?.ok === true;

  return (
    <ConsoleDialog
      onClose={onClose}
      busy={pending}
      closeLabel={d.close}
      title={done ? r.doneTitle : source ? r.sourceTitle : r.title}
      description={done ? undefined : source ? fill(r.sourceDescription, { location: source.location }) : r.description}
      footer={(dismissBlocked) =>
        done ? (
          <ConsoleButton onClick={onClose}>{d.close}</ConsoleButton>
        ) : (
          <>
            <ConsoleButton onClick={onClose} disabled={dismissBlocked}>
              {d.cancel}
            </ConsoleButton>
            <ConsoleButton variant="primary" type="submit" form={formId} disabled={pending}>
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
        )
      }
    >
      {done ? (
        <p className="flex items-start gap-2 text-[12px] leading-[1.6] tracking-[-0.023em] text-pubink">
          <CircleCheckIcon size={15} className="mt-px shrink-0" />
          {/*
            * The two outcomes are different facts and the operator is told
            * which one happened: a second click on an asset that already has
            * work queued adds nothing, and reporting it as "queued" would
            * teach them to expect two runs.
            */}
          {state?.queued ? r.doneBody : r.doneAlready}
        </p>
      ) : (
        <form id={formId} onSubmit={submitOn(submit)} className="flex flex-col gap-3">
          <input type="hidden" name="assetId" value={target.id} />
        {source ? <input type="hidden" name="sourceId" value={source.id} /> : null}
          <Refusal state={state} />
          <TargetCard target={target} />
          <ReasonField
            label={r.reason}
            placeholder={r.reasonPlaceholder}
            ariaLabel={r.reason}
          />
          <p className="text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">{d.auditNote}</p>
        </form>
      )}
    </ConsoleDialog>
  );
}

/**
 * Rebuild the routing profile of the current version.
 *
 * The same shape as the refresh control, for the same reason: derived data is
 * still a mutation of the asset record, and requirement.md 5.3 wants the
 * reason. Unlike a refresh it runs inline -- reading the stored chunks is
 * seconds, not a crawl -- so the outcome the dialog reports is the real one.
 */
export function PlatformProfileRebuildControl({
  action,
  target,
  disabled = false,
}: {
  action: Action;
  target: PlatformAssetTarget;
  /** Nothing built yet: the control says so rather than failing. */
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const label = t.admin.platformAssetDetail.actions.rebuildProfile;
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);

  return (
    <>
      <ConsoleButton disabled={disabled} onClick={() => setOpen(true)}>
        <SparklesIcon size={14} />
        {label}
      </ConsoleButton>

      {open ? (
        <ProfileRebuildDialog
          key={attempt}
          action={action}
          target={target}
          onClose={() => {
            setOpen(false);
            setAttempt((value) => value + 1);
          }}
        />
      ) : null}
    </>
  );
}

function ProfileRebuildDialog({
  action,
  target,
  onClose,
}: {
  action: Action;
  target: PlatformAssetTarget;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const d = t.admin.platformAssetDetail;
  const r = d.profileDialog;
  const [state, submit, pending] = useActionState(action, null);
  const formId = useId();
  const done = state?.ok === true;

  return (
    <ConsoleDialog
      onClose={onClose}
      busy={pending}
      closeLabel={d.close}
      title={done ? r.doneTitle : r.title}
      description={done ? undefined : r.description}
      footer={(dismissBlocked) =>
        done ? (
          <ConsoleButton onClick={onClose}>{d.close}</ConsoleButton>
        ) : (
          <>
            <ConsoleButton onClick={onClose} disabled={dismissBlocked}>
              {d.cancel}
            </ConsoleButton>
            <ConsoleButton variant="primary" type="submit" form={formId} disabled={pending}>
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
        )
      }
    >
      {done ? (
        <p className="flex items-start gap-2 text-[12px] leading-[1.6] tracking-[-0.023em] text-pubink">
          <CircleCheckIcon size={15} className="mt-px shrink-0" />
          {fill(r.doneBody, {
            titles: String(state?.rebuilt?.titles ?? 0),
            terms: String(state?.rebuilt?.terms ?? 0),
          })}
        </p>
      ) : (
        <form id={formId} onSubmit={submitOn(submit)} className="flex flex-col gap-3">
          <input type="hidden" name="assetId" value={target.id} />
          <Refusal state={state} />
          <TargetCard target={target} />
          <ReasonField
            label={r.reason}
            placeholder={r.reasonPlaceholder}
            ariaLabel={r.reason}
          />
          <p className="text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">{d.auditNote}</p>
        </form>
      )}
    </ConsoleDialog>
  );
}

/**
 * Publish or suspend -- design source frame `暂停平台知识库`.
 *
 * One control for both directions, because they are the same decision seen from
 * two sides and the operator only ever has one of them available. Which one
 * that is comes from the row's own state, not from a prop the page has to keep
 * in step with it.
 */
export function PlatformLifecycleControl({
  action,
  target,
  current,
  canPublish,
}: {
  action: Action;
  target: PlatformAssetTarget;
  current: 'draft' | 'published' | 'suspended' | 'archived';
  /** Whether an indexed version exists. Publishing without one is refused. */
  canPublish: boolean;
}) {
  const { t } = useI18n();
  const d = t.admin.platformAssetDetail;
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Archived is terminal from here: requirement.md 5.3 gives the console
  // create, refresh, suspend and publish, and un-archiving is none of them.
  if (current === 'archived') return null;

  const suspending = current === 'published';
  const label = suspending
    ? d.actions.suspend
    : current === 'suspended'
      ? d.actions.republish
      : d.actions.publish;

  return (
    <>
      <ConsoleButton
        variant="primary"
        className={suspending ? 'bg-err hover:bg-err/90' : ''}
        onClick={() => setOpen(true)}
      >
        {suspending ? <BanIcon size={14} /> : <CircleCheckIcon size={14} />}
        {label}
      </ConsoleButton>

      {open ? (
        <LifecycleDialog
          key={attempt}
          action={action}
          target={target}
          intent={suspending ? 'suspend' : 'publish'}
          canPublish={canPublish}
          onClose={() => {
            setOpen(false);
            setAttempt((value) => value + 1);
          }}
        />
      ) : null}
    </>
  );
}

function LifecycleDialog({
  action,
  target,
  intent,
  canPublish,
  onClose,
}: {
  action: Action;
  target: PlatformAssetTarget;
  intent: PlatformLifecycleAction;
  canPublish: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const d = t.admin.platformAssetDetail;
  const copy = intent === 'suspend' ? d.suspendDialog : d.publishDialog;
  const [state, submit, pending] = useActionState(action, null);
  const formId = useId();

  /*
   * A lifecycle change is not something to celebrate inside the modal: the page
   * behind it has already been revalidated, and the new status in the header is
   * what the operator wants to see. Closing on success is also what stops the
   * submit staying live over a change that already happened -- a second click
   * would be refused as `invalid_transition` and read as if the first had
   * failed.
   */
  useEffect(() => {
    if (state?.ok) onClose();
  }, [state, onClose]);

  /*
   * Publishing without an indexed version is refused by the use case, so the
   * dialog says so up front and does not offer the submit. Letting the operator
   * type a reason for something that cannot happen wastes their time and puts
   * the explanation after the attempt rather than before it.
   */
  const blocked = intent === 'publish' && !canPublish;

  return (
    <ConsoleDialog
      onClose={onClose}
      busy={pending}
      closeLabel={d.close}
      title={copy.title}
      description={copy.description}
      footer={(dismissBlocked) => (
        <>
          <ConsoleButton onClick={onClose} disabled={dismissBlocked}>
            {blocked ? d.close : d.cancel}
          </ConsoleButton>
          {blocked ? null : (
            <ConsoleButton
              variant="primary"
              type="submit"
              form={formId}
              disabled={pending}
              className={intent === 'suspend' ? 'bg-err hover:bg-err/90' : ''}
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
          )}
        </>
      )}
    >
      <form id={formId} onSubmit={submitOn(submit)} className="flex flex-col gap-3">
        <input type="hidden" name="assetId" value={target.id} />
        <input type="hidden" name="action" value={intent} />

        <Refusal state={state} />
        <TargetCard target={target} />

        {blocked ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-[8px] bg-ambersoft p-2.5 text-[11px] leading-[1.55] text-amberink"
          >
            <CircleXIcon size={15} className="mt-px shrink-0" />
            {d.publishDialog.blocked}
          </p>
        ) : (
          <>
            {intent === 'suspend' ? (
              <ul className="flex flex-col gap-1.5">
                {d.suspendDialog.consequences.map((line) => (
                  <li
                    key={line}
                    className="flex items-start gap-1.5 text-[11px] leading-[1.55] tracking-[-0.023em] text-steel"
                  >
                    <span aria-hidden className="mt-px text-err">
                      •
                    </span>
                    {line}
                  </li>
                ))}
              </ul>
            ) : null}
            <ReasonField
              label={copy.reason}
              placeholder={copy.reasonPlaceholder}
              ariaLabel={copy.reason}
            />
            <p className="text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">
              {d.auditNote}
            </p>
          </>
        )}
      </form>
    </ConsoleDialog>
  );
}

/**
 * Delete -- the one verb over a platform asset that requirement.md 5.3 does
 * not list and architecture.md 8.4 specifies anyway.
 *
 * Offered from every state, archived included. The dialog says what deleting
 * does in the order it happens: out of retrieval and the catalogue now, the
 * Asset ID released now, the content removed by a cleanup task afterwards.
 * It does not say "deleted" of the content, because when the dialog closes
 * that is not yet true.
 */
export function PlatformDeleteControl({
  action,
  target,
  variant = 'icon',
}: {
  action: Action;
  target: PlatformAssetTarget;
  variant?: 'icon' | 'button';
}) {
  const { t } = useI18n();
  const label = t.admin.platformAssetDetail.actions.delete;
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);

  return (
    <>
      {variant === 'icon' ? (
        <IconButton label={label} onClick={() => setOpen(true)}>
          <TrashIcon size={14} />
        </IconButton>
      ) : (
        <ConsoleButton className="text-err hover:bg-errsoft" onClick={() => setOpen(true)}>
          <TrashIcon size={14} />
          {label}
        </ConsoleButton>
      )}

      {open ? (
        <DeleteDialog
          key={attempt}
          action={action}
          target={target}
          onClose={() => {
            setOpen(false);
            setAttempt((value) => value + 1);
          }}
        />
      ) : null}
    </>
  );
}

function DeleteDialog({
  action,
  target,
  onClose,
}: {
  action: Action;
  target: PlatformAssetTarget;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const d = t.admin.platformAssetDetail;
  const r = d.deleteDialog;
  const [state, submit, pending] = useActionState(action, null);
  const formId = useId();
  const done = state?.ok === true;

  return (
    <ConsoleDialog
      onClose={onClose}
      busy={pending}
      closeLabel={d.close}
      title={done ? r.doneTitle : r.title}
      description={done ? undefined : r.description}
      footer={(dismissBlocked) =>
        done ? (
          /*
           * The page behind the dialog is an asset that no longer exists:
           * the list is where the operator goes next, and a plain "close"
           * would drop them onto a 404 after the next navigation.
           */
          <ConsoleButton variant="primary" href="/admin/platform-assets">
            {r.backToList}
          </ConsoleButton>
        ) : (
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
        )
      }
    >
      {done ? (
        <p className="flex items-start gap-2 text-[12px] leading-[1.6] tracking-[-0.023em] text-pubink">
          <CircleCheckIcon size={15} className="mt-px shrink-0" />
          {fill(r.doneBody, { publicId: state?.publicId ?? target.publicId })}
        </p>
      ) : (
        <form id={formId} onSubmit={submitOn(submit)} className="flex flex-col gap-3">
          <input type="hidden" name="assetId" value={target.id} />
          <Refusal state={state} />
          <TargetCard target={target} />
          <ul className="flex flex-col gap-1.5">
            {r.consequences.map((line) => (
              <li
                key={line}
                className="flex items-start gap-1.5 text-[11px] leading-[1.55] tracking-[-0.023em] text-steel"
              >
                <span aria-hidden className="mt-px text-err">
                  •
                </span>
                {line}
              </li>
            ))}
          </ul>
          <ReasonField label={r.reason} placeholder={r.reasonPlaceholder} ariaLabel={r.reason} />
          <p className="text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">{d.auditNote}</p>
        </form>
      )}
    </ConsoleDialog>
  );
}
