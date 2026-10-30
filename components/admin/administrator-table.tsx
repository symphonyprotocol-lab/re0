'use client';

import { useActionState, useState, type ReactNode } from 'react';
import { submitOn } from '@/components/admin/platform-asset-shared';
import {
  ConsoleButton,
  IconButton,
  Monogram,
  Pill,
  TableScroller,
  TD,
  TH,
  TitleCell,
} from '@/components/admin/ui';
import { CopyButton } from '@/components/dashboard/copy-button';
import { CircleCheckIcon, CircleXIcon, EllipsisIcon, SpinnerIcon } from '@/components/ui/icons';
import type { AdminRoleId, AdminStatus } from '@/lib/domain/admin';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';
import type { ActionResult } from '@/app/admin/(console)/administrators/actions';

export interface AdministratorView {
  id: string;
  username: string;
  email: string;
  initial: string;
  /**
   * Every role the account holds, not just the first: an account carrying two
   * would otherwise show a badge that understates what it can reach, next to a
   * scope column that does not.
   */
  roles: { id: AdminRoleId; label: string }[];
  scopeLabel: string;
  status: AdminStatus;
  statusLabel: string;
  lastActive: string;
  activeSessions: number;
  mfaEnrolled: boolean;
  /** The signed-in operator: the console refuses to let anyone edit themselves. */
  isSelf: boolean;
}

type Action = (previous: ActionResult | null, form: FormData) => Promise<ActionResult>;

interface Actions {
  changeRole: Action;
  setStatus: Action;
  revokeSessions: Action;
  resetMfa: Action;
}

const STATUS_TONE: Record<AdminStatus, 'ok' | 'warn' | 'neutral'> = {
  active: 'ok',
  invited: 'warn',
  disabled: 'neutral',
};

/**
 * Console members table -- design source frame `RubCg`.
 *
 * The row menu expands a panel underneath rather than floating one over the
 * table: a popover in a horizontally scrolling table has to fight the scroll
 * container for position, and the panel has room for the reason field that
 * every one of these actions requires.
 *
 * requirement.md 5.3: high-risk actions take a second confirmation and record
 * the reason, so each action is a form with its own reason field rather than a
 * single click.
 */
export function AdministratorTable({
  administrators,
  roles,
  actions,
  inviteTtlDays,
}: {
  administrators: AdministratorView[];
  roles: { id: AdminRoleId; label: string }[];
  actions: Actions;
  /** How long the enrolment link an MFA reset mints stays valid. */
  inviteTtlDays: number;
}) {
  const { t } = useI18n();
  const a = t.admin.administrators;
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <TableScroller>
      <table className="w-full min-w-[720px] border-collapse text-left">
        <thead>
          <tr>
            {a.columns.map((column) => (
              <th key={column} scope="col" className={TH}>
                {column}
              </th>
            ))}
            <th scope="col" className={`${TH} w-[56px]`}>
              <span className="sr-only">{a.manage}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {administrators.length === 0 ? (
            <tr className="border-t-2 border-line">
              <td className={`${TD} text-center text-muted`} colSpan={a.columns.length + 1}>
                {a.empty}
              </td>
            </tr>
          ) : null}

          {administrators.map((administrator) => {
            const open = openId === administrator.id;
            return (
              <Row
                key={administrator.id}
                administrator={administrator}
                roles={roles}
                actions={actions}
                inviteTtlDays={inviteTtlDays}
                open={open}
                onToggle={() => setOpenId(open ? null : administrator.id)}
                columnCount={a.columns.length + 1}
              />
            );
          })}
        </tbody>
      </table>
    </TableScroller>
  );
}

function Row({
  administrator,
  roles,
  actions,
  inviteTtlDays,
  open,
  onToggle,
  columnCount,
}: {
  administrator: AdministratorView;
  roles: { id: AdminRoleId; label: string }[];
  actions: Actions;
  inviteTtlDays: number;
  open: boolean;
  onToggle: () => void;
  columnCount: number;
}) {
  const { t } = useI18n();
  const a = t.admin.administrators;

  return (
    <>
      <tr className="border-t-2 border-line">
        <td className={TD}>
          <TitleCell
            title={administrator.isSelf ? `${administrator.username} (${a.you})` : administrator.username}
            meta={administrator.email}
            leading={<Monogram initial={administrator.initial} tone="ink" />}
          />
        </td>
        <td className={TD}>
          <span className="flex flex-wrap items-center gap-1">
            {administrator.roles.length === 0 ? (
              <Pill tone="warn">{t.admin.shell.noRole}</Pill>
            ) : (
              administrator.roles.map((role) => (
                <Pill key={role.id} tone={role.id === 'super' ? 'brand' : 'neutral'}>
                  {role.label}
                </Pill>
              ))
            )}
          </span>
        </td>
        <td className={TD}>{administrator.scopeLabel}</td>
        <td className={TD}>
          <span className="flex flex-col gap-0.5">
            <span>{administrator.lastActive}</span>
            <span className="text-[11px] text-muted">
              {administrator.activeSessions === 0
                ? a.noSessions
                : administrator.activeSessions === 1
                  ? a.sessionsOne
                  : fill(a.sessions, { count: administrator.activeSessions })}
            </span>
          </span>
        </td>
        <td className={TD}>
          <span className="flex flex-col items-start gap-1">
            <Pill tone={STATUS_TONE[administrator.status]}>{administrator.statusLabel}</Pill>
            {administrator.mfaEnrolled ? null : (
              <span className="text-[11px] text-amberink">{a.mfaMissing}</span>
            )}
          </span>
        </td>
        <td className={TD}>
          <span aria-expanded={open} className="inline-flex">
            <IconButton label={a.manage} onClick={onToggle}>
              <EllipsisIcon size={14} />
            </IconButton>
          </span>
        </td>
      </tr>

      {open ? (
        <tr className="border-t-2 border-line bg-subtle">
          <td colSpan={columnCount} className="px-[15px] py-4">
            <div className="flex flex-col gap-3">
              {administrator.isSelf ? (
                <>
                  <p className="text-[12px] text-muted">{a.selfLocked}</p>
                  {/* The domain refuses a self reset (refuseSelfChange); say why
                      rather than show a control that would only fail. */}
                  <p className="text-[12px] text-muted">{a.mfaReset.selfNote}</p>
                </>
              ) : (
                <>
                  <ActionForm
                    action={actions.changeRole}
                    administratorId={administrator.id}
                    title={a.actionRole}
                    note={a.roleChangeNote}
                    submitLabel={a.confirm}
                  >
                    <select
                      name="role"
                      defaultValue={administrator.roles[0]?.id ?? 'support'}
                      className={FIELD}
                    >
                      {roles.map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.label}
                        </option>
                      ))}
                    </select>
                  </ActionForm>

                  {administrator.status === 'invited' ? null : (
                    <ActionForm
                      action={actions.setStatus}
                      administratorId={administrator.id}
                      title={
                        administrator.status === 'disabled' ? a.actionEnable : a.actionDisable
                      }
                      note={a.disableNote}
                      submitLabel={a.confirm}
                      danger={administrator.status !== 'disabled'}
                    >
                      <input
                        type="hidden"
                        name="status"
                        value={administrator.status === 'disabled' ? 'active' : 'disabled'}
                      />
                    </ActionForm>
                  )}

                  <ActionForm
                    action={actions.revokeSessions}
                    administratorId={administrator.id}
                    title={a.actionRevoke}
                    note={a.revokeNote}
                    submitLabel={a.confirm}
                    disabled={administrator.activeSessions === 0}
                  />

                  {/* Only an enrolled, active account has a factor to clear;
                      an invited one is already on its way through enrolment. */}
                  {administrator.status === 'active' && administrator.mfaEnrolled ? (
                    <ActionForm
                      action={actions.resetMfa}
                      administratorId={administrator.id}
                      title={a.mfaReset.action}
                      note={a.mfaReset.note}
                      submitLabel={a.confirm}
                      danger
                      done={(result) =>
                        result.enrolmentPath ? (
                          <EnrolmentLink
                            path={result.enrolmentPath}
                            days={inviteTtlDays}
                            sessions={administrator.activeSessions}
                          />
                        ) : null
                      }
                    />
                  ) : null}
                </>
              )}

              <div>
                <ConsoleButton onClick={onToggle}>{a.close}</ConsoleButton>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

const FIELD =
  'h-[34px] rounded-[7px] border-2 border-line bg-card px-2.5 text-[12px] tracking-[-0.023em] text-ink focus:border-brand focus:outline-none';

/**
 * The one-time enrolment link an MFA reset mints, shown once like an
 * invitation's: only its digest is stored, so closing this panel is the last
 * anyone sees of it.
 */
function EnrolmentLink({ path, days, sessions }: { path: string; days: number; sessions: number }) {
  const { t } = useI18n();
  const a = t.admin.administrators;
  const link = typeof window === 'undefined' ? path : `${window.location.origin}${path}`;

  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-start gap-1.5 text-[11px] leading-[1.5] text-pubink">
        <CircleCheckIcon size={13} className="mt-px shrink-0" />
        {fill(a.mfaReset.done, { days, sessions })}
      </p>
      <div className="flex items-center gap-2 rounded-[8px] border-2 border-line bg-subtle px-2.5 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-steel">{link}</code>
        <CopyButton value={link} label={a.mfaReset.copy} />
      </div>
    </div>
  );
}

/** One confirmable action: its own inputs, a required reason, and a result. */
function ActionForm({
  action,
  administratorId,
  title,
  note,
  submitLabel,
  children,
  danger,
  disabled,
  done,
}: {
  action: Action;
  administratorId: string;
  title: string;
  note: string;
  submitLabel: string;
  children?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** What to show in place of the form once the action succeeded, if anything. */
  done?: (result: ActionResult) => ReactNode;
}) {
  const { t } = useI18n();
  const a = t.admin.administrators;
  const [state, submit, pending] = useActionState(action, null);

  const finished = state?.ok && done ? done(state) : null;
  if (finished) {
    return (
      <div className="flex flex-col gap-2 rounded-[8px] border-2 border-line bg-card p-3">
        <span className="text-[12px] font-semibold tracking-[-0.023em] text-ink">{title}</span>
        {finished}
      </div>
    );
  }

  return (
    <form
      onSubmit={submitOn(submit)}
      className="flex flex-col gap-2 rounded-[8px] border-2 border-line bg-card p-3"
    >
      <input type="hidden" name="administratorId" value={administratorId} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] font-semibold tracking-[-0.023em] text-ink">{title}</span>
        <span className="text-[11px] text-muted">{note}</span>
      </div>

      {state?.error ? (
        <p role="alert" className="flex items-start gap-1.5 text-[11px] leading-[1.5] text-err">
          <CircleXIcon size={13} className="mt-px shrink-0" />
          {a.errors[state.error]}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {children}
        <input
          name="reason"
          required
          maxLength={200}
          placeholder={a.reasonPlaceholder}
          aria-label={a.reason}
          className={`${FIELD} min-w-[180px] flex-1`}
        />
        <ConsoleButton
          type="submit"
          variant={danger ? 'primary' : 'outline'}
          disabled={disabled || pending}
          className={danger ? 'bg-err hover:bg-err/90' : ''}
        >
          {pending ? (
            <>
              <SpinnerIcon size={13} className="motion-safe:animate-spin" />
              {a.confirming}
            </>
          ) : (
            submitLabel
          )}
        </ConsoleButton>
      </div>
    </form>
  );
}
