'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ADMIN_PASSWORD_MIN } from '@/lib/constants';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { Icon, Spinner } from '@/components/ui/icons';

function Input({ id, label, hint, ...rest }: { id: string; label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="mt-4">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <input id={id} className="input" {...rest} />
      {hint && <small className="hint">{hint}</small>}
    </div>
  );
}

export function AdminLoginForm() {
  const { t } = useI18n();
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="mt-4"
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setBusy(true);
        setError('');
        const result = await api('/api/admin/auth/login', {
          method: 'POST',
          json: { email: form.get('email'), password: form.get('password'), code: form.get('code') },
        });
        setBusy(false);
        if (!result.ok) return setError(t.admin.login.failed);
        router.push('/admin/overview');
        router.refresh();
      }}
    >
      <Input id="admin-email" name="email" type="email" required autoComplete="username" label={t.admin.login.email} />
      <Input id="admin-password" name="password" type="password" required autoComplete="current-password" label={t.admin.login.password} />
      <Input
        id="admin-totp"
        name="code"
        inputMode="numeric"
        pattern="[0-9]{6}"
        maxLength={6}
        required
        autoComplete="one-time-code"
        placeholder="000000"
        label={t.admin.login.totp}
        hint={t.admin.login.totpHint}
      />
      {error && (
        <p role="alert" className="mt-4 text-[12px] text-red">
          {error}
        </p>
      )}
      <button type="submit" className="btn mt-6 min-h-12 w-full" disabled={busy}>
        {busy && <Spinner />}
        {t.admin.login.submit}
        <Icon name="arrow" />
      </button>
    </form>
  );
}

/** The first-run form: the TOTP secret is minted by the server and travels sealed, so the browser cannot pick its own. */
export function AdminBootstrapForm({ sealedSecret, secret, qr }: { sealedSecret: string; secret: string; qr: string }) {
  const { t } = useI18n();
  const s = t.admin.setup;
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="mt-4"
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setBusy(true);
        setError('');
        const result = await api<{ error?: string }>('/api/admin/auth/bootstrap', {
          method: 'POST',
          json: { name: form.get('name'), email: form.get('email'), password: form.get('password'), code: form.get('code'), sealedSecret },
        });
        setBusy(false);
        if (result.ok) {
          router.push('/admin/overview');
          router.refresh();
          return;
        }
        const code = result.data.error;
        if (code === 'bootstrap_closed') {
          setError(s.closed);
          router.refresh();
          return;
        }
        setError(code && code in s.errors ? s.errors[code as keyof typeof s.errors] : t.common.errors.generic);
      }}
    >
      <Input id="setup-name" name="name" required maxLength={40} label={s.name} />
      <Input id="setup-email" name="email" type="email" required autoComplete="username" label={t.admin.login.email} />
      <Input id="setup-password" name="password" type="password" required minLength={ADMIN_PASSWORD_MIN} autoComplete="new-password" label={t.admin.login.password} hint={s.passwordHint} />
      <div className="mt-5 flex flex-col gap-4 rounded-xl border border-line bg-wash p-4 sm:flex-row">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qr} alt="" width={120} height={120} className="size-[120px] flex-none rounded-lg border border-line bg-white" />
        <div className="min-w-0">
          <strong className="text-[13px]">{s.totpTitle}</strong>
          <p className="mt-1 text-[11px] text-muted">{s.totpBody}</p>
          <code className="mt-2 block font-mono text-[11px] break-all text-ink">{secret}</code>
        </div>
      </div>
      <Input id="setup-totp" name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required autoComplete="one-time-code" placeholder="000000" label={t.admin.login.totp} hint={t.admin.login.totpHint} />
      {error && (
        <p role="alert" className="mt-4 text-[12px] text-red">
          {error}
        </p>
      )}
      <button type="submit" className="btn mt-6 min-h-12 w-full" disabled={busy}>
        {busy && <Spinner />}
        {s.submit}
        <Icon name="arrow" />
      </button>
    </form>
  );
}

/**
 * An invited administrator's enrolment (`/admin/login?invite=…`): who is
 * enrolling is fixed by the link, the TOTP secret is minted by the server and
 * travels sealed; a password and the first code finish it and sign in.
 */
export function AdminEnrolForm({ token, name, email, sealedSecret, secret, qr }: { token: string; name: string; email: string; sealedSecret: string; secret: string; qr: string }) {
  const { t } = useI18n();
  const s = t.admin.setup;
  const e = t.consoleRees.enrol;
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="mt-4"
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setBusy(true);
        setError('');
        const result = await api<{ error?: string }>('/api/admin/auth/enrol', {
          method: 'POST',
          json: { token, password: form.get('password'), code: form.get('code'), sealedSecret },
        });
        setBusy(false);
        if (result.ok) {
          router.push('/admin/overview');
          router.refresh();
          return;
        }
        const code = result.data.error;
        setError(code && code in e.errors ? e.errors[code as keyof typeof e.errors] : t.common.errors.generic);
      }}
    >
      <Input id="enrol-name" value={name} readOnly label={e.name} />
      <Input id="enrol-email" type="email" value={email} readOnly autoComplete="username" label={e.email} />
      <Input id="enrol-password" name="password" type="password" required minLength={ADMIN_PASSWORD_MIN} autoComplete="new-password" label={t.admin.login.password} hint={s.passwordHint} />
      <div className="mt-5 flex flex-col gap-4 rounded-xl border border-line bg-wash p-4 sm:flex-row">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qr} alt="" width={120} height={120} className="size-[120px] flex-none rounded-lg border border-line bg-white" />
        <div className="min-w-0">
          <strong className="text-[13px]">{s.totpTitle}</strong>
          <p className="mt-1 text-[11px] text-muted">{s.totpBody}</p>
          <code className="mt-2 block font-mono text-[11px] break-all text-ink">{secret}</code>
        </div>
      </div>
      <Input id="enrol-totp" name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required autoComplete="one-time-code" placeholder="000000" label={t.admin.login.totp} hint={t.admin.login.totpHint} />
      {error && (
        <p role="alert" className="mt-4 text-[12px] text-red">
          {error}
        </p>
      )}
      <button type="submit" className="btn mt-6 min-h-12 w-full" disabled={busy}>
        {busy && <Spinner />}
        {e.submit}
        <Icon name="arrow" />
      </button>
    </form>
  );
}
