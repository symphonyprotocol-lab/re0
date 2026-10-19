'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';
import { submitOn } from '@/components/admin/platform-library-shared';
import { CopyButton } from '@/components/dashboard/copy-button';
import {
  AREA,
  FIELD,
  Field,
  PRIMARY,
  ResultLine,
  SECONDARY,
} from '@/components/dashboard/library-manage';
import { ArrowLink, PANEL } from '@/components/dashboard/ui';
import { GlobeIcon, PencilIcon, TrashIcon } from '@/components/ui/icons';
import type { SiteKeyActionResult } from '@/app/dashboard/libraries/[libraryId]/actions';
import type { SiteKeyView } from '@/lib/application/embed';
import {
  embedSnippet,
  SITE_KEY_ACCENT_DEFAULT,
  SITE_KEY_DAILY_LIMIT_DEFAULT,
  SITE_KEY_DAILY_LIMIT_MAX,
  SITE_KEY_DAILY_LIMIT_MIN,
  SITE_KEY_WELCOME_MAX,
} from '@/lib/domain/site-key';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';
import { publicUrl } from '@/lib/site/origin';

/**
 * The website widget panel on a library's page (requirement.md 9.4): the
 * library's site keys, each with the snippet to paste, and the form that
 * mints one. Every control posts to an action that re-checks the role; a
 * reader without the right sees the keys and the snippet but no forms.
 */

type SiteKeyAction = (previous: SiteKeyActionResult | null, form: FormData) => Promise<SiteKeyActionResult>;

/** The settings fields, shared by create and edit. */
function SettingsFields({ initial }: { initial?: SiteKeyView }) {
  const { t } = useI18n();
  const c = t.dashboard.libraryDetail.widget.create;
  return (
    <>
      <Field label={c.name}>
        <input
          name="name"
          required
          maxLength={80}
          defaultValue={initial?.name ?? ''}
          placeholder={c.namePlaceholder}
          className={FIELD}
        />
      </Field>
      <Field label={c.origins} hint={c.originsHint}>
        <textarea
          name="origins"
          required
          defaultValue={initial?.allowedOrigins.join('\n') ?? ''}
          placeholder={'https://www.example.com'}
          className={AREA}
        />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={c.dailyLimit} hint={c.dailyLimitHint}>
          <input
            name="dailyLimit"
            type="number"
            min={SITE_KEY_DAILY_LIMIT_MIN}
            max={SITE_KEY_DAILY_LIMIT_MAX}
            step={1}
            defaultValue={initial?.dailyLimit ?? SITE_KEY_DAILY_LIMIT_DEFAULT}
            className={FIELD}
          />
        </Field>
        <Field label={c.accent}>
          <input
            name="accent"
            type="color"
            defaultValue={initial?.accent ?? SITE_KEY_ACCENT_DEFAULT}
            className="h-9 w-full cursor-pointer rounded-md border border-line bg-card px-1"
          />
        </Field>
      </div>
      <Field label={c.welcome}>
        <input
          name="welcome"
          maxLength={SITE_KEY_WELCOME_MAX}
          defaultValue={initial?.welcome ?? ''}
          placeholder={c.welcomePlaceholder}
          className={FIELD}
        />
      </Field>
    </>
  );
}

function errorText(
  errors: Record<string, string>,
  error: SiteKeyActionResult['error'],
): string {
  return (error && errors[error]) || errors.unavailable || '';
}

function KeyCard({
  libraryId,
  siteKey,
  canEdit,
  updateAction,
  revokeAction,
}: {
  libraryId: string;
  siteKey: SiteKeyView;
  canEdit: boolean;
  updateAction: SiteKeyAction;
  revokeAction: SiteKeyAction;
}) {
  const { t, locale } = useI18n();
  const w = t.dashboard.libraryDetail.widget;
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [saved, saveAction, saving] = useActionState(updateAction, null);
  const [revoked, revokeDispatch, revoking] = useActionState(revokeAction, null);
  const snippet = embedSnippet(publicUrl('/widget.js'), siteKey.key);
  const stamp = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  useEffect(() => {
    if (saved?.ok) {
      setEditing(false);
      router.refresh();
    }
  }, [saved, router]);
  useEffect(() => {
    if (revoked?.ok) router.refresh();
  }, [revoked, router]);

  if (revoked?.ok) return null;

  return (
    <article className="flex flex-col gap-3 rounded-md border border-line bg-subtle/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
            <span
              aria-hidden
              className="inline-block size-3 rounded-full border border-line"
              style={{ background: siteKey.accent }}
            />
            {siteKey.name}
          </p>
          <p className="text-[11px] text-muted">
            {fill(w.perDay, { n: siteKey.dailyLimit })} ·{' '}
            {siteKey.lastUsedAt
              ? fill(w.lastUsed, { time: stamp.format(new Date(siteKey.lastUsedAt)) })
              : w.neverUsed}
          </p>
        </div>
        {canEdit ? (
          <div className="flex items-center gap-2">
            <button type="button" className={SECONDARY} onClick={() => setEditing((value) => !value)}>
              <PencilIcon size={13} />
              {editing ? w.cancel : w.edit}
            </button>
            <form
              onSubmit={(event) => {
                if (!window.confirm(w.revokeConfirm)) {
                  event.preventDefault();
                  return;
                }
                submitOn(revokeDispatch)(event);
              }}
            >
              <input type="hidden" name="libraryId" value={libraryId} />
              <input type="hidden" name="siteKeyId" value={siteKey.id} />
              <button type="submit" disabled={revoking} className={`${SECONDARY} text-rose`}>
                <TrashIcon size={13} />
                {w.revoke}
              </button>
            </form>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-steel">{w.snippet}</span>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-line bg-card px-2.5 py-2 font-mono text-[11px] text-steel">
            {snippet}
          </code>
          <CopyButton value={snippet} label={w.snippetLabel} className="text-steel hover:bg-mutedbg" />
        </div>
      </div>

      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
        <GlobeIcon size={12} />
        <span className="font-medium text-steel">{w.origins}:</span>
        {siteKey.allowedOrigins.map((origin) => (
          <code key={origin} className="rounded bg-card px-1.5 py-0.5 font-mono text-[10.5px] text-ink">
            {origin}
          </code>
        ))}
      </p>

      {revoked && !revoked.ok ? (
        <ResultLine ok={false}>{errorText(w.errors, revoked.error)}</ResultLine>
      ) : null}

      {editing && canEdit ? (
        <form onSubmit={submitOn(saveAction)} className="flex flex-col gap-3 border-t border-line pt-3">
          <input type="hidden" name="libraryId" value={libraryId} />
          <input type="hidden" name="siteKeyId" value={siteKey.id} />
          <SettingsFields initial={siteKey} />
          <div className="flex items-center gap-3">
            <button type="submit" disabled={saving} className={PRIMARY}>
              {w.save}
            </button>
            {saved && !saved.ok ? (
              <ResultLine ok={false}>{errorText(w.errors, saved.error)}</ResultLine>
            ) : null}
          </div>
        </form>
      ) : saved?.ok ? (
        <ResultLine ok>{w.saved}</ResultLine>
      ) : null}
    </article>
  );
}

export function LibraryWidgetPanel({
  libraryId,
  keys,
  ready,
  canEdit,
  maxKeys,
  createAction,
  updateAction,
  revokeAction,
}: {
  libraryId: string;
  keys: SiteKeyView[];
  /** Published with a current version: the widget answers right now. */
  ready: boolean;
  canEdit: boolean;
  maxKeys: number;
  createAction: SiteKeyAction;
  updateAction: SiteKeyAction;
  revokeAction: SiteKeyAction;
}) {
  const { t } = useI18n();
  const w = t.dashboard.libraryDetail.widget;
  const router = useRouter();
  const [created, createDispatch, creating] = useActionState(createAction, null);

  useEffect(() => {
    if (created?.ok) router.refresh();
  }, [created, router]);

  return (
    <section id="widget" className={`${PANEL} flex scroll-mt-4 flex-col gap-4 p-6`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-[15px] font-medium text-ink">{w.title}</h2>
          <p className="text-[11px] leading-[1.6] text-muted">{w.description}</p>
        </div>
        <ArrowLink href="/dashboard/widget">{w.allSites}</ArrowLink>
      </div>
      <ol className="flex flex-col gap-1 pl-4 text-[11.5px] leading-[1.6] text-steel marker:text-muted">
        {w.how.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {!ready ? (
        <p className="rounded-md border border-line bg-subtle px-3.5 py-2.5 text-[11px] text-muted">
          {w.notReady}
        </p>
      ) : null}

      {keys.length === 0 ? (
        <p className="text-[12px] text-muted">{w.empty}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {keys.map((siteKey) => (
            <KeyCard
              key={siteKey.id}
              libraryId={libraryId}
              siteKey={siteKey}
              canEdit={canEdit}
              updateAction={updateAction}
              revokeAction={revokeAction}
            />
          ))}
        </div>
      )}

      {canEdit && keys.length < maxKeys ? (
        <form onSubmit={submitOn(createDispatch)} className="flex flex-col gap-3 border-t border-line pt-4">
          <p className="text-[13px] font-medium text-ink">{w.create.title}</p>
          <input type="hidden" name="libraryId" value={libraryId} />
          <SettingsFields />
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={creating} className={PRIMARY}>
              {w.create.submit}
            </button>
            {created ? (
              created.ok ? (
                <ResultLine ok>{w.create.created}</ResultLine>
              ) : (
                <ResultLine ok={false}>{errorText(w.errors, created.error)}</ResultLine>
              )
            ) : null}
          </div>
        </form>
      ) : null}
    </section>
  );
}
