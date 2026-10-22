'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';
import { submitOn } from '@/components/admin/platform-library-shared';
import { CopyButton } from '@/components/dashboard/copy-button';
import { AREA, FIELD, Field, PRIMARY, ResultLine, SECONDARY } from '@/components/dashboard/library-manage';
import { ArrowLink, Badge, PANEL } from '@/components/dashboard/ui';
import { ArrowUpRightIcon, CheckIcon, DownloadIcon, EyeIcon, GlobeIcon, MailIcon, RefreshIcon, SparklesIcon, TrashIcon, UploadIcon } from '@/components/ui/icons';
import type { ShowcaseActionResult } from '@/app/dashboard/libraries/[libraryId]/actions';
import type { ShowcaseDomainView, ShowcaseLeadsView, ShowcaseStats, ShowcaseView } from '@/lib/application/showcase';
import { SITE_KEY_DAILY_LIMIT_MAX, SITE_KEY_DAILY_LIMIT_MIN } from '@/lib/domain/site-key';
import {
  SHOWCASE_KINDS,
  SHOWCASE_LIMITS,
  SHOWCASE_PASSWORD,
  showcaseFieldsFor,
  showcasePath,
  type ShowcaseField,
  type ShowcaseKind,
} from '@/lib/domain/showcase';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';
import { LOCALE_LABEL, LOCALES } from '@/lib/i18n/locale';

/**
 * The showcase panel on a library's page (lib/domain/showcase.ts): enable
 * a page, draft it from the library, edit every field, publish and share
 * the link. Every control posts to an action that re-checks the role; a
 * reader without the right sees the link and the status but no forms.
 */

type ShowcaseAction = (previous: ShowcaseActionResult | null, form: FormData) => Promise<ShowcaseActionResult>;

export interface ShowcasePanelActions {
  enable: ShowcaseAction;
  update: ShowcaseAction;
  draft: ShowcaseAction;
  verb: ShowcaseAction;
  /** Delete the page outright, so a new one can be made. */
  remove: ShowcaseAction;
  asset: ShowcaseAction;
  lead: ShowcaseAction;
  domain: ShowcaseAction;
}

/** An ISO instant as a `datetime-local` value in the browser's zone; empty when none. */
function localInput(iso: string | null): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function errorText(errors: Record<string, string>, error: ShowcaseActionResult['error']): string {
  return (error && errors[error]) || errors.unavailable || '';
}

function EnableForm({ libraryId, ready, allowed, action }: { libraryId: string; ready: boolean; allowed: boolean; action: ShowcaseAction }) {
  const { t } = useI18n();
  const w = t.dashboard.libraryDetail.showcase;
  const router = useRouter();
  const [kind, setKind] = useState<ShowcaseKind>('company');
  const [result, dispatch, pending] = useActionState(action, null);
  useEffect(() => {
    if (result?.ok) router.refresh();
  }, [result, router]);
  return (
    <form onSubmit={submitOn(dispatch)} className="flex flex-col gap-4">
      <input type="hidden" name="libraryId" value={libraryId} />
      <input type="hidden" name="kind" value={kind} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {SHOWCASE_KINDS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setKind(option)}
            aria-pressed={kind === option}
            className={`flex flex-col gap-1 rounded-md border p-4 text-left transition-colors ${
              kind === option ? 'border-brand bg-brandsoft' : 'border-line bg-card hover:bg-subtle'
            }`}
          >
            <span className="text-[13px] font-medium text-ink">{w.kinds[option]}</span>
            <span className="text-[11px] leading-[1.5] text-muted">{w.kindHints[option]}</span>
          </button>
        ))}
      </div>
      {!ready ? <p className="text-[11px] text-muted">{w.notReady}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending || !allowed} className={PRIMARY}>
          <SparklesIcon size={14} />
          {pending ? w.enabling : w.enable}
        </button>
        <span className="text-[11px] text-muted">{w.enableHint}</span>
      </div>
      {result && !result.ok ? <ResultLine ok={false}>{errorText(w.errors, result.error)}</ResultLine> : null}
    </form>
  );
}

function Origin({ field, showcase }: { field: ShowcaseField; showcase: ShowcaseView }) {
  const { t } = useI18n();
  const w = t.dashboard.libraryDetail.showcase;
  const origin = showcase.document.origin[field];
  const evidence = showcase.document.evidence[field];
  if (origin === 'generated' && evidence) return <span className="text-[10px] text-brandink">{fill(w.from, { title: evidence })}</span>;
  if (origin === 'manual') return <span className="text-[10px] text-muted">{w.manual}</span>;
  return null;
}

function Labelled({ field, showcase, label, hint, children }: { field: ShowcaseField; showcase: ShowcaseView; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center justify-between gap-2 text-[11px] font-medium text-steel">
        {label}
        <Origin field={field} showcase={showcase} />
      </span>
      {children}
      {hint ? <span className="text-[10px] text-muted">{hint}</span> : null}
    </label>
  );
}

function PairRows({ name, count, labels, initial }: { name: 'link' | 'cta'; count: number; labels: { label: string; url: string }; initial: { label: string; url: string }[] }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: count }, (_, at) => (
        <div key={at} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2">
          <input name={`${name}Label`} defaultValue={initial[at]?.label ?? ''} placeholder={labels.label} className={FIELD} maxLength={name === 'cta' ? SHOWCASE_LIMITS.ctas.label : SHOWCASE_LIMITS.links.label} />
          <input name={`${name}Url`} defaultValue={initial[at]?.url ?? ''} placeholder={labels.url} className={FIELD} type="url" />
        </div>
      ))}
    </div>
  );
}

/**
 * A logo or screenshot: the image as the page shows it, a button that opens
 * the file picker, and the upload starts the moment a file is chosen --
 * there is no second button to press, which is where the old two-step form
 * lost people. The remove verb rides on a form of its own, since `submitOn`
 * posts a form's fields and nothing says which button sent it.
 */
function AssetRow({ libraryId, kind, has, src, initial, action }: { libraryId: string; kind: 'logo' | 'screenshot'; has: boolean; src: string; initial: string; action: ShowcaseAction }) {
  const { t } = useI18n();
  const w = t.dashboard.libraryDetail.showcase;
  const router = useRouter();
  const [result, dispatch, pending] = useActionState(action, null);
  useEffect(() => {
    if (result?.ok) router.refresh();
  }, [result, router]);
  const inputId = `showcase-${kind}-file`;
  const frame = kind === 'logo' ? 'size-16 rounded-xl' : 'h-16 w-[106px] rounded-lg';
  return (
    <div className="flex items-start gap-4">
      {has ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className={`${frame} shrink-0 border border-line bg-white ${kind === 'logo' ? 'object-contain p-1' : 'object-cover'}`} />
      ) : (
        <span aria-hidden className={`${frame} flex shrink-0 items-center justify-center border border-dashed border-line bg-subtle text-[22px] font-semibold text-muted`}>
          {kind === 'logo' ? initial : null}
        </span>
      )}
      <div className="flex min-w-0 flex-col gap-1.5 pt-0.5">
        <span className="text-[12px] font-medium text-ink">{w.assets[kind]}</span>
        <div className="flex flex-wrap items-center gap-2">
          <form onSubmit={submitOn(dispatch)}>
            <input type="hidden" name="libraryId" value={libraryId} />
            <input type="hidden" name="kind" value={kind} />
            <input
              id={inputId}
              name="file"
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              className="sr-only"
              disabled={pending}
              onChange={(event) => {
                if (event.currentTarget.files?.length) event.currentTarget.form?.requestSubmit();
              }}
            />
            <label htmlFor={inputId} className={`${SECONDARY} cursor-pointer ${pending ? 'pointer-events-none opacity-60' : ''}`}>
              <UploadIcon size={13} />
              {pending ? w.assets.uploading : has ? w.assets.replace : w.assets.choose}
            </label>
          </form>
          {has ? (
            <form onSubmit={submitOn(dispatch)}>
              <input type="hidden" name="libraryId" value={libraryId} />
              <input type="hidden" name="kind" value={kind} />
              <input type="hidden" name="remove" value="true" />
              <button type="submit" disabled={pending} className={`${SECONDARY} text-rose`}>
                <TrashIcon size={13} />
                {w.assets.remove}
              </button>
            </form>
          ) : null}
        </div>
        <span className="text-[10.5px] text-muted">{kind === 'logo' ? w.assets.logoHint : w.assets.screenshotHint}</span>
        {result && !result.ok ? <ResultLine ok={false}>{errorText(w.errors, result.error)}</ResultLine> : null}
      </div>
    </div>
  );
}

function LeadRow({ libraryId, lead, canEdit, action }: { libraryId: string; lead: ShowcaseLeadsView['leads'][number]; canEdit: boolean; action: ShowcaseAction }) {
  const { t, locale } = useI18n();
  const w = t.dashboard.libraryDetail.showcase.leads;
  const router = useRouter();
  const [result, dispatch, pending] = useActionState(action, null);
  const stamp = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  useEffect(() => {
    if (result?.ok) router.refresh();
  }, [result, router]);
  const verb = lead.status === 'new' ? 'handled' : 'new';
  return (
    <li className={`flex flex-col gap-1.5 rounded-md border border-line p-3 ${lead.status === 'new' ? 'bg-card' : 'bg-subtle/60'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-center gap-2 text-[12.5px]">
          <a href={`mailto:${lead.email}`} className="inline-flex items-center gap-1 font-medium text-brandink hover:underline">
            <MailIcon size={13} />
            {lead.email}
          </a>
          {lead.name ? <span className="text-ink">{lead.name}</span> : null}
          <Badge tone={lead.status === 'new' ? 'public' : 'neutral'}>{lead.status === 'new' ? w.statusNew : w.statusHandled}</Badge>
          <span className="text-[11px] text-muted">{stamp.format(new Date(lead.createdAt))}</span>
        </span>
        {canEdit ? (
          <span className="flex items-center gap-1.5">
            <form onSubmit={submitOn(dispatch)}>
              <input type="hidden" name="libraryId" value={libraryId} />
              <input type="hidden" name="leadId" value={lead.id} />
              <input type="hidden" name="verb" value={verb} />
              <button type="submit" disabled={pending} className={SECONDARY}>
                {lead.status === 'new' ? <CheckIcon size={13} /> : <RefreshIcon size={13} />}
                {lead.status === 'new' ? w.markHandled : w.markNew}
              </button>
            </form>
            <form
              onSubmit={(event) => {
                if (!window.confirm(w.deleteConfirm)) {
                  event.preventDefault();
                  return;
                }
                submitOn(dispatch)(event);
              }}
            >
              <input type="hidden" name="libraryId" value={libraryId} />
              <input type="hidden" name="leadId" value={lead.id} />
              <input type="hidden" name="verb" value="delete" />
              <button type="submit" disabled={pending} className={`${SECONDARY} text-rose`} aria-label={w.remove}>
                <TrashIcon size={13} />
              </button>
            </form>
          </span>
        ) : null}
      </div>
      {lead.message ? <p className="text-[12.5px] leading-[1.55] whitespace-pre-line text-ink">{lead.message}</p> : null}
      {lead.question ? (
        <p className="text-[11px] text-muted">
          {fill(w.asked, { question: lead.question })}
        </p>
      ) : null}
      {result && !result.ok ? <ResultLine ok={false}>{errorText(t.dashboard.libraryDetail.showcase.errors, result.error)}</ResultLine> : null}
    </li>
  );
}

function LeadsPanel({ libraryId, leads, canEdit, action }: { libraryId: string; leads: ShowcaseLeadsView; canEdit: boolean; action: ShowcaseAction }) {
  const { t, locale } = useI18n();
  const w = t.dashboard.libraryDetail.showcase.leads;
  const number = new Intl.NumberFormat(locale);
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
            {w.title}
            {leads.unhandled > 0 ? <Badge tone="public">{fill(w.unhandled, { n: number.format(leads.unhandled) })}</Badge> : null}
          </p>
          <p className="text-[11px] leading-[1.5] text-muted">{w.description}</p>
        </div>
        {leads.total > 0 ? (
          <a href={`/dashboard/export/showcase-leads?library=${encodeURIComponent(libraryId)}`} className={SECONDARY}>
            <DownloadIcon size={13} />
            {w.export}
          </a>
        ) : null}
      </div>
      {leads.leads.length === 0 ? (
        <p className="text-[12px] text-muted">{w.empty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {leads.leads.map((lead) => (
            <LeadRow key={lead.id} libraryId={libraryId} lead={lead} canEdit={canEdit} action={action} />
          ))}
        </ul>
      )}
      {leads.retained >= 0 && leads.total > leads.retained ? (
        <p className="text-[11px] text-muted">{fill(w.retainedNote, { shown: number.format(leads.retained), total: number.format(leads.total) })}</p>
      ) : leads.leads.length < leads.total ? (
        <p className="text-[11px] text-muted">{fill(w.truncatedNote, { shown: number.format(leads.leads.length), total: number.format(leads.total) })}</p>
      ) : null}
    </div>
  );
}

function Record({ label, name, value }: { label: string; name: string; value: string }) {
  const { t } = useI18n();
  const w = t.dashboard.libraryDetail.showcase.domain;
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md border border-line bg-card p-3 text-[11.5px]">
      <span className="text-muted">{label}</span>
      <span className="text-ink">{w.recordType}</span>
      <span className="text-muted">{w.recordName}</span>
      <span className="flex items-center gap-1.5">
        <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[11px] whitespace-nowrap text-steel">{name}</code>
        <CopyButton value={name} label={w.recordName} className="text-steel hover:bg-mutedbg" />
      </span>
      <span className="text-muted">{w.recordValue}</span>
      <span className="flex items-center gap-1.5">
        <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[11px] whitespace-nowrap text-steel">{value}</code>
        <CopyButton value={value} label={w.recordValue} className="text-steel hover:bg-mutedbg" />
      </span>
    </div>
  );
}

function DomainPanel({
  libraryId,
  domain,
  canEdit,
  action,
}: {
  libraryId: string;
  domain: { available: boolean; allowed: boolean; view: ShowcaseDomainView | null };
  canEdit: boolean;
  action: ShowcaseAction;
}) {
  const { t, locale } = useI18n();
  const w = t.dashboard.libraryDetail.showcase.domain;
  const router = useRouter();
  const [result, dispatch, pending] = useActionState(action, null);
  const stamp = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  useEffect(() => {
    if (result?.ok) router.refresh();
  }, [result, router]);
  if (!domain.available) return null;
  const view = domain.view;
  const tone: Record<ShowcaseDomainView['status'], 'public' | 'neutral' | 'private'> = {
    pending_ownership: 'neutral',
    pending_dns: 'neutral',
    ready: 'public',
    failed: 'private',
  };
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <div className="flex flex-col gap-1">
        <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
          <GlobeIcon size={14} />
          {w.title}
          {view ? <Badge tone={tone[view.status]}>{w.status[view.status]}</Badge> : null}
        </p>
        <p className="text-[11px] leading-[1.6] text-muted">{w.description}</p>
      </div>
      {!domain.allowed && !view ? (
        <p className="rounded-md border border-line bg-subtle px-3.5 py-2.5 text-[11px] text-muted">{w.planLocked}</p>
      ) : !domain.allowed && view ? (
        <div className="flex flex-col gap-2">
          <p className="rounded-md border border-line bg-subtle px-3.5 py-2.5 text-[11px] text-muted">{fill(w.planLapsed, { host: view.host })}</p>
          {canEdit ? (
            <form onSubmit={submitOn(dispatch)}>
              <input type="hidden" name="libraryId" value={libraryId} />
              <input type="hidden" name="verb" value="remove" />
              <button type="submit" disabled={pending} className={`${SECONDARY} text-rose`}>
                <TrashIcon size={13} />
                {w.remove}
              </button>
            </form>
          ) : null}
        </div>
      ) : !view ? (
        canEdit ? (
          <form onSubmit={submitOn(dispatch)} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="libraryId" value={libraryId} />
            <input type="hidden" name="verb" value="start" />
            <Field label={w.host} hint={w.hostHint}>
              <input name="host" required placeholder="about.example.com" className={FIELD} />
            </Field>
            <button type="submit" disabled={pending} className={PRIMARY}>
              {w.start}
            </button>
          </form>
        ) : (
          <p className="text-[12px] text-muted">{w.none}</p>
        )
      ) : (
        <div className="flex flex-col gap-3">
          <p className="flex flex-wrap items-center gap-2 text-[12.5px]">
            <code className="rounded bg-card px-1.5 py-0.5 font-mono text-[11.5px] text-ink">{view.host}</code>
            {view.status === 'ready' ? (
              <a href={`https://${view.host}/`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brandink hover:underline">
                {w.open}
                <ArrowUpRightIcon size={12} />
              </a>
            ) : null}
            {view.lastCheckedAt ? <span className="text-[11px] text-muted">{fill(w.lastChecked, { time: stamp.format(new Date(view.lastCheckedAt)) })}</span> : null}
          </p>
          {view.status === 'pending_ownership' && view.ownershipTxt ? (
            <>
              <p className="text-[11.5px] text-steel">{w.stepOwnership}</p>
              <Record label={w.recordLabelOwnership} name={view.ownershipTxt.name} value={view.ownershipTxt.value} />
            </>
          ) : null}
          {view.status === 'pending_dns' ? (
            <>
              {view.vercelTxt ? (
                <>
                  <p className="text-[11.5px] text-steel">{w.stepVercelTxt}</p>
                  <Record label={w.recordLabelVercel} name={view.vercelTxt.name} value={view.vercelTxt.value} />
                </>
              ) : null}
              <p className="text-[11.5px] text-steel">{w.stepCname}</p>
              <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md border border-line bg-card p-3 text-[11.5px]">
                <span className="text-muted">{w.recordLabelCname}</span>
                <span className="text-ink">CNAME</span>
                <span className="text-muted">{w.recordName}</span>
                <code className="font-mono text-[11px] text-steel">{view.host}</code>
                <span className="text-muted">{w.recordValue}</span>
                <span className="flex items-center gap-1.5">
                  <code className="font-mono text-[11px] text-steel">{view.cnameTarget}</code>
                  <CopyButton value={view.cnameTarget} label={w.recordValue} className="text-steel hover:bg-mutedbg" />
                </span>
              </div>
            </>
          ) : null}
          {view.status === 'ready' ? <p className="text-[11.5px] text-steel">{w.ready}</p> : null}
          {view.status === 'failed' ? <p className="text-[11.5px] text-rose">{w.failed}</p> : null}
          {view.error ? <p className="text-[11px] text-muted">{fill(w.lastError, { error: (w.reasons as Record<string, string>)[view.error] ?? view.error.replace(/^provider:/, '') })}</p> : null}
          {canEdit ? (
            <div className="flex flex-wrap items-center gap-2">
              {view.status !== 'ready' ? (
                <form onSubmit={submitOn(dispatch)}>
                  <input type="hidden" name="libraryId" value={libraryId} />
                  <input type="hidden" name="verb" value="check" />
                  <button type="submit" disabled={pending} className={SECONDARY}>
                    <RefreshIcon size={13} />
                    {w.check}
                  </button>
                </form>
              ) : null}
              <form
                onSubmit={(event) => {
                  if (!window.confirm(w.removeConfirm)) {
                    event.preventDefault();
                    return;
                  }
                  submitOn(dispatch)(event);
                }}
              >
                <input type="hidden" name="libraryId" value={libraryId} />
                <input type="hidden" name="verb" value="remove" />
                <button type="submit" disabled={pending} className={`${SECONDARY} text-rose`}>
                  <TrashIcon size={13} />
                  {w.remove}
                </button>
              </form>
            </div>
          ) : null}
        </div>
      )}
      {result && !result.ok ? <ResultLine ok={false}>{errorText(t.dashboard.libraryDetail.showcase.errors, result.error)}</ResultLine> : null}
    </div>
  );
}

export function LibraryShowcasePanel({
  libraryId,
  showcase,
  stats,
  leads,
  domain,
  origin,
  qrSvg,
  ready,
  canEdit,
  allowed,
  actions,
}: {
  libraryId: string;
  showcase: ShowcaseView | null;
  stats: ShowcaseStats | null;
  /** The page's leads (lib/application/showcase/leads.ts); null when there is no page. */
  leads: ShowcaseLeadsView | null;
  /** The page's own host (lib/application/showcase/domain.ts): offered at all, allowed by the plan, and where it stands. */
  domain: { available: boolean; allowed: boolean; view: ShowcaseDomainView | null };
  /** This deployment's origin, for the link. */
  origin: string;
  /** The link as a QR code, inline SVG; null when there is no page. */
  qrSvg: string | null;
  ready: boolean;
  canEdit: boolean;
  /** The plan allows another page (only read while there is none). */
  allowed: boolean;
  actions: ShowcasePanelActions;
}) {
  const { t, locale } = useI18n();
  const w = t.dashboard.libraryDetail.showcase;
  const router = useRouter();
  const [saved, saveDispatch, saving] = useActionState(actions.update, null);
  const [drafted, draftDispatch, drafting] = useActionState(actions.draft, null);
  const [moved, verbDispatch, moving] = useActionState(actions.verb, null);
  const [removed, removeDispatch, removing] = useActionState(actions.remove, null);
  const [kind, setKind] = useState<ShowcaseKind>(showcase?.kind ?? 'company');
  const [access, setAccess] = useState(showcase?.access ?? 'public');
  const number = new Intl.NumberFormat(locale);
  /* The browser's zone, read after mount so the server and the client render the same form. */
  const [tzOffset, setTzOffset] = useState(0);
  useEffect(() => {
    setTzOffset(new Date().getTimezoneOffset());
  }, []);

  useEffect(() => {
    if (saved?.ok || drafted?.ok || moved?.ok || removed?.ok) router.refresh();
  }, [saved, drafted, moved, removed, router]);
  useEffect(() => {
    if (showcase) {
      setKind(showcase.kind);
      setAccess(showcase.access);
    }
  }, [showcase]);

  return (
    <section id="showcase" className={`${PANEL} flex scroll-mt-4 flex-col gap-4 p-6`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="flex items-center gap-2 text-[15px] font-medium text-ink">
            {w.title}
            {showcase ? <Badge tone={showcase.status === 'published' ? 'public' : 'neutral'}>{w.status[showcase.status]}</Badge> : null}
            {showcase?.expired ? <Badge tone="private">{w.statusExpired}</Badge> : null}
            {showcase?.hasPassword && !showcase.expired ? <Badge tone="neutral">{w.statusLocked}</Badge> : null}
          </h2>
          <p className="text-[11px] leading-[1.6] text-muted">{w.description}</p>
        </div>
        <ArrowLink href="/dashboard/showcases">{w.allPages}</ArrowLink>
      </div>

      {!showcase ? (
        canEdit ? (
          <>
            {!allowed ? <p className="rounded-md border border-line bg-subtle px-3.5 py-2.5 text-[11px] text-muted">{w.planLimit}</p> : null}
            <EnableForm libraryId={libraryId} ready={ready} allowed={allowed} action={actions.enable} />
          </>
        ) : (
          <p className="text-[12px] text-muted">{w.none}</p>
        )
      ) : (
        <>
          {/* The link, the QR, the three status verbs, and delete -- which
              brings the enable form back, so "start over" is delete then enable. */}
          <div className="flex flex-col gap-3 rounded-md border border-line bg-subtle/60 p-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <span className="text-[11px] font-medium text-steel">{w.link}</span>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto rounded-md border border-line bg-card px-2.5 py-2 font-mono text-[11px] whitespace-nowrap text-steel">
                  {origin}
                  {showcasePath(showcase.slug)}
                </code>
                <CopyButton value={`${origin}${showcasePath(showcase.slug)}`} label={w.copyLink} className="text-steel hover:bg-mutedbg" />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <a href={showcase.status === 'published' ? showcasePath(showcase.slug) : `${showcasePath(showcase.slug)}?preview=1`} target="_blank" rel="noreferrer" className={SECONDARY}>
                  {showcase.status === 'published' ? <ArrowUpRightIcon size={13} /> : <EyeIcon size={13} />}
                  {showcase.status === 'published' ? w.open : w.preview}
                </a>
                {canEdit && showcase.status !== 'taken_down' ? (
                  <form
                    onSubmit={(event) => {
                      if (showcase.status === 'published' && !window.confirm(w.disableConfirm)) {
                        event.preventDefault();
                        return;
                      }
                      submitOn(verbDispatch)(event);
                    }}
                  >
                    <input type="hidden" name="libraryId" value={libraryId} />
                    <input type="hidden" name="verb" value={showcase.status === 'published' ? 'disable' : showcase.status === 'disabled' ? 'restore' : 'publish'} />
                    <button type="submit" disabled={moving} className={showcase.status === 'published' ? `${SECONDARY} text-rose` : PRIMARY}>
                      {showcase.status === 'published' ? w.disable : showcase.status === 'disabled' ? w.restore : w.publish}
                    </button>
                  </form>
                ) : null}
                {canEdit && showcase.status !== 'taken_down' ? (
                  <form
                    onSubmit={(event) => {
                      if (!window.confirm(w.deleteConfirm)) {
                        event.preventDefault();
                        return;
                      }
                      submitOn(removeDispatch)(event);
                    }}
                  >
                    <input type="hidden" name="libraryId" value={libraryId} />
                    <input type="hidden" name="slug" value={showcase.slug} />
                    <button type="submit" disabled={removing || moving} className={`${SECONDARY} text-rose`}>
                      {w.delete}
                    </button>
                  </form>
                ) : null}
                {moved && !moved.ok ? <ResultLine ok={false}>{errorText(w.errors, moved.error)}</ResultLine> : null}
                {removed && !removed.ok ? <ResultLine ok={false}>{errorText(w.errors, removed.error)}</ResultLine> : null}
              </div>
              {showcase.status === 'taken_down' ? <p className="text-[11px] text-rose">{w.takenDown}</p> : null}
              {stats ? (
                <p className="text-[11px] text-muted">
                  {fill(w.stats, {
                    days: stats.days,
                    views: number.format(stats.views),
                    questions: number.format(stats.questions),
                    clicks: number.format(stats.ctaClicks),
                    leads: number.format(stats.leads),
                  })}
                </p>
              ) : null}
            </div>
            {qrSvg ? (
              <div className="flex shrink-0 flex-col items-center gap-1">
                <span className="size-[92px] rounded-md border border-line bg-white p-1.5 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: qrSvg }} />
                <span className="text-[10px] text-muted">{w.qr}</span>
              </div>
            ) : null}
          </div>

          {leads ? <LeadsPanel libraryId={libraryId} leads={leads} canEdit={canEdit && showcase.status !== 'taken_down'} action={actions.lead} /> : null}

          {showcase.status !== 'taken_down' ? <DomainPanel libraryId={libraryId} domain={domain} canEdit={canEdit} action={actions.domain} /> : null}

          {canEdit && showcase.status !== 'taken_down' ? (
            <>
              {/* The images first: the logo is the page's face, and the
                  screenshot (product pages) sits beside it. */}
              <div className="flex flex-col gap-4 border-t border-line pt-4 sm:flex-row sm:gap-10">
                <AssetRow
                  libraryId={libraryId}
                  kind="logo"
                  has={showcase.hasLogo}
                  src={`${showcasePath(showcase.slug)}/logo?v=${encodeURIComponent(showcase.updatedAt)}&preview=1`}
                  initial={(showcase.document.content.name.trim()[0] ?? '?').toUpperCase()}
                  action={actions.asset}
                />
                {kind === 'product' ? (
                  <AssetRow
                    libraryId={libraryId}
                    kind="screenshot"
                    has={showcase.hasScreenshot}
                    src={`${showcasePath(showcase.slug)}/screenshot?v=${encodeURIComponent(showcase.updatedAt)}&preview=1`}
                    initial=""
                    action={actions.asset}
                  />
                ) : null}
              </div>

              {/* Drafting from the library. */}
              <form onSubmit={submitOn(draftDispatch)} className="flex flex-col gap-2 rounded-md border border-line p-4">
                <input type="hidden" name="libraryId" value={libraryId} />
                <p className="text-[13px] font-medium text-ink">{w.draft.title}</p>
                <p className="text-[11px] leading-[1.5] text-muted">{w.draft.hint}</p>
                <div className="flex flex-wrap items-center gap-3">
                  <button type="submit" disabled={drafting || !ready} className={SECONDARY}>
                    <RefreshIcon size={13} />
                    {drafting ? w.draft.running : w.draft.button}
                  </button>
                  <label className="flex items-center gap-1.5 text-[11px] text-muted">
                    <input type="checkbox" name="overwrite" value="true" />
                    {w.draft.overwrite}
                  </label>
                  {drafted?.ok && drafted.draft ? <ResultLine ok={drafted.draft === 'drafted'}>{w.draft.outcomes[drafted.draft]}</ResultLine> : null}
                  {drafted && !drafted.ok ? <ResultLine ok={false}>{errorText(w.errors, drafted.error)}</ResultLine> : null}
                </div>
                {!ready ? <p className="text-[11px] text-muted">{w.notReady}</p> : null}
              </form>

              {/* The page itself. */}
              <form onSubmit={submitOn(saveDispatch)} className="flex flex-col gap-4 border-t border-line pt-4">
                <input type="hidden" name="libraryId" value={libraryId} />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={w.form.kind}>
                    <select name="kind" value={kind} onChange={(event) => setKind(event.target.value as ShowcaseKind)} className={FIELD}>
                      {SHOWCASE_KINDS.map((option) => (
                        <option key={option} value={option}>
                          {w.kinds[option]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={w.form.locale}>
                    <select name="locale" defaultValue={showcase.locale} className={FIELD}>
                      {LOCALES.map((option) => (
                        <option key={option} value={option}>
                          {LOCALE_LABEL[option]}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Labelled field="name" showcase={showcase} label={w.form.name}>
                  <input name="name" required maxLength={SHOWCASE_LIMITS.name} defaultValue={showcase.document.content.name} className={FIELD} />
                </Labelled>
                <Labelled field="tagline" showcase={showcase} label={w.form.tagline}>
                  <input name="tagline" maxLength={SHOWCASE_LIMITS.tagline} defaultValue={showcase.document.content.tagline} className={FIELD} />
                </Labelled>
                <Labelled field="summary" showcase={showcase} label={w.form.summary}>
                  <textarea name="summary" maxLength={SHOWCASE_LIMITS.summary} defaultValue={showcase.document.content.summary} className={`${AREA} font-sans`} />
                </Labelled>
                {showcaseFieldsFor(kind).includes('facts') ? (
                  <Labelled field="facts" showcase={showcase} label={w.form.facts} hint={w.form.factsHint}>
                    <textarea name="facts" defaultValue={showcase.document.content.facts.join('\n')} className={`${AREA} font-sans`} />
                  </Labelled>
                ) : null}
                {showcaseFieldsFor(kind).includes('features') ? (
                  <>
                    <Labelled field="features" showcase={showcase} label={w.form.features} hint={w.form.featuresHint}>
                      <div className="flex flex-col gap-2">
                        {Array.from({ length: SHOWCASE_LIMITS.features.count }, (_, at) => (
                          <div key={at} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2">
                            <input name="featureTitle" maxLength={SHOWCASE_LIMITS.features.title} defaultValue={showcase.document.content.features[at]?.title ?? ''} placeholder={w.form.featureTitle} className={FIELD} />
                            <input name="featureBody" maxLength={SHOWCASE_LIMITS.features.body} defaultValue={showcase.document.content.features[at]?.body ?? ''} placeholder={w.form.featureBody} className={FIELD} />
                          </div>
                        ))}
                      </div>
                    </Labelled>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Labelled field="audience" showcase={showcase} label={w.form.audience}>
                        <input name="audience" maxLength={SHOWCASE_LIMITS.audience} defaultValue={showcase.document.content.audience} className={FIELD} />
                      </Labelled>
                      <Labelled field="pricing" showcase={showcase} label={w.form.pricing}>
                        <input name="pricing" maxLength={SHOWCASE_LIMITS.pricing} defaultValue={showcase.document.content.pricing} className={FIELD} />
                      </Labelled>
                    </div>
                  </>
                ) : null}
                <Labelled field="ctas" showcase={showcase} label={w.form.ctas} hint={w.form.ctasHint}>
                  <PairRows name="cta" count={SHOWCASE_LIMITS.ctas.count} labels={{ label: w.form.ctaLabel, url: w.form.ctaUrl }} initial={showcase.document.content.ctas} />
                </Labelled>
                <Labelled field="links" showcase={showcase} label={w.form.links} hint={w.form.linksHint}>
                  <PairRows name="link" count={SHOWCASE_LIMITS.links.count} labels={{ label: w.form.linkLabel, url: w.form.linkUrl }} initial={showcase.document.content.links} />
                </Labelled>
                <Field label={w.form.starterQuestions} hint={w.form.starterHint}>
                  <textarea name="starterQuestions" defaultValue={showcase.starterQuestions.join('\n')} className={`${AREA} font-sans`} />
                </Field>

                <div className="grid grid-cols-1 gap-3 border-t border-line pt-4 sm:grid-cols-2">
                  <Field label={w.form.slug} hint={w.form.slugHint}>
                    <div className="flex items-center gap-1">
                      <span className="shrink-0 text-[11px] text-muted">{origin}/s/</span>
                      <input name="slug" defaultValue={showcase.slugBase} minLength={SHOWCASE_LIMITS.slug.min} maxLength={SHOWCASE_LIMITS.slug.max} className={FIELD} />
                    </div>
                  </Field>
                  <Field label={w.form.access}>
                    <div className="flex flex-col gap-1.5 text-[11.5px] text-ink">
                      <label className="flex items-center gap-1.5">
                        <input type="radio" name="access" value="public" checked={access === 'public'} onChange={() => setAccess('public')} />
                        {w.form.accessPublic}
                      </label>
                      <label className="flex items-center gap-1.5">
                        <input type="radio" name="access" value="unlisted" checked={access === 'unlisted'} onChange={() => setAccess('unlisted')} />
                        {w.form.accessUnlisted}
                      </label>
                    </div>
                  </Field>
                  {access === 'unlisted' ? (
                    <>
                      <Field label={w.form.password} hint={showcase.hasPassword ? w.form.passwordSetHint : w.form.passwordHint}>
                        <input name="password" type="password" autoComplete="new-password" minLength={SHOWCASE_PASSWORD.min} maxLength={SHOWCASE_PASSWORD.max} placeholder={showcase.hasPassword ? w.form.passwordSetPlaceholder : w.form.passwordPlaceholder} className={FIELD} />
                      </Field>
                      <Field label={w.form.expiresAt} hint={w.form.expiresAtHint}>
                        <input name="expiresAt" type="datetime-local" defaultValue={localInput(showcase.expiresAt)} className={FIELD} />
                        <input type="hidden" name="tzOffset" value={tzOffset} />
                      </Field>
                      {showcase.hasPassword ? (
                        <label className="flex items-center gap-1.5 text-[11.5px] text-ink sm:col-span-2">
                          <input type="checkbox" name="clearPassword" value="true" />
                          {w.form.clearPassword}
                        </label>
                      ) : null}
                    </>
                  ) : null}
                  <Field label={w.form.accent}>
                    <input name="accent" type="color" defaultValue={showcase.accent} className="h-9 w-full cursor-pointer rounded-md border border-line bg-card px-1" />
                  </Field>
                  <Field label={w.form.dailyLimit} hint={w.form.dailyLimitHint}>
                    <input name="dailyLimit" type="number" min={SITE_KEY_DAILY_LIMIT_MIN} max={SITE_KEY_DAILY_LIMIT_MAX} step={1} defaultValue={showcase.dailyLimit} className={FIELD} />
                  </Field>
                  {showcase.entitlement.brandingOptional ? (
                    <label className="flex items-center gap-1.5 text-[11.5px] text-ink sm:col-span-2">
                      <input type="hidden" name="brandingEditable" value="1" />
                      <input type="checkbox" name="showBranding" value="true" defaultChecked={showcase.showBranding} />
                      {w.form.branding}
                    </label>
                  ) : (
                    <p className="text-[10.5px] text-muted sm:col-span-2">{w.form.brandingLocked}</p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <button type="submit" disabled={saving} className={PRIMARY}>
                    {w.form.save}
                  </button>
                  {saved ? saved.ok ? <ResultLine ok>{w.form.saved}</ResultLine> : <ResultLine ok={false}>{errorText(w.errors, saved.error)}</ResultLine> : null}
                </div>
              </form>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
