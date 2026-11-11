'use client';

import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { useState } from 'react';
import { ADMIN_PASSWORD_MIN } from '@/lib/constants';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { CI } from '@/components/admin/console-icon';

function Input({ id, label, hint, ...rest }: { id: string; label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} {...rest} />
      {hint && <small>{hint}</small>}
    </div>
  );
}

/** The authenticator step of setup and enrolment (prototype `.setup-totp`), with a real, scannable code. */
function TotpSetup({ qr, secret }: { qr: string; secret: string }) {
  const { t } = useI18n();
  const s = t.admin.setup;
  return (
    <div className="setup-totp">
      <div className="fake-qr has-qr">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qr} alt="" width={104} height={104} />
      </div>
      <div>
        <strong>{s.totpTitle}</strong>
        <p>{s.totpBody}</p>
        <code>{secret}</code>
      </div>
    </div>
  );
}

/** The six-digit code field every form ends with. */
function Totp() {
  const { t } = useI18n();
  return (
    <Input
      id="admin-totp"
      name="code"
      inputMode="numeric"
      pattern="[0-9]{6}"
      maxLength={6}
      required
      autoComplete="one-time-code"
      placeholder={t.admin.login.totpPlaceholder}
      label={t.admin.login.totp}
      hint={t.admin.login.totpHint}
    />
  );
}

function FormError({ message }: { message: string }) {
  return message ? (
    <div className="form-error" role="alert">
      {message}
    </div>
  ) : null;
}

function Submit({ busy, label }: { busy: boolean; label: string }) {
  return (
    <button type="submit" className="btn full large" disabled={busy}>
      {busy && <span className="spinner" aria-hidden="true" />}
      {label} <CI name="arrow" />
    </button>
  );
}

/** `next` is already checked by the page (`safeAdminNext`), falling back to the overview. */
export function AdminLoginForm({ next = '/admin/overview', notice }: { next?: string; notice?: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      id="admin-login-form"
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setBusy(true);
        setError('');
        const result = await api<{ error?: string; retryAfter?: number }>('/api/admin/auth/login', {
          method: 'POST',
          json: { email: form.get('email'), password: form.get('password'), code: form.get('code') },
        });
        setBusy(false);
        if (!result.ok && result.data.error === 'too_many_attempts') {
          return setError(fill(t.admin.login.tooMany, { minutes: Math.max(1, Math.ceil((result.data.retryAfter ?? 60) / 60)) }));
        }
        if (!result.ok) return setError(t.admin.login.failed);
        router.push(next);
        router.refresh();
      }}
    >
      <FormError message={error || notice || ''} />
      <Input id="admin-email" name="email" type="email" required autoComplete="username" placeholder={t.admin.login.emailPlaceholder} label={t.admin.login.email} />
      <Input id="admin-password" name="password" type="password" required autoComplete="current-password" placeholder={t.admin.login.passwordPlaceholder} label={t.admin.login.password} />
      <Totp />
      <Submit busy={busy} label={t.admin.login.submit} />
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
      id="admin-setup-form"
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
      <FormError message={error} />
      <Input id="admin-name" name="name" required maxLength={40} placeholder="RE0 Admin" label={s.name} />
      <Input id="admin-email" name="email" type="email" required autoComplete="username" placeholder={t.admin.login.emailPlaceholder} label={t.admin.login.email} />
      <Input id="admin-password" name="password" type="password" required minLength={ADMIN_PASSWORD_MIN} autoComplete="new-password" placeholder={s.passwordHint} label={t.admin.login.password} />
      <TotpSetup qr={qr} secret={secret} />
      <Totp />
      <Submit busy={busy} label={s.submit} />
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
      id="admin-enrol-form"
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
      <FormError message={error} />
      <Input id="admin-name" value={name} readOnly label={e.name} />
      <Input id="admin-email" type="email" value={email} readOnly autoComplete="username" label={e.email} />
      <Input id="admin-password" name="password" type="password" required minLength={ADMIN_PASSWORD_MIN} autoComplete="new-password" placeholder={s.passwordHint} label={t.admin.login.password} />
      <TotpSetup qr={qr} secret={secret} />
      <Totp />
      <Submit busy={busy} label={e.submit} />
    </form>
  );
}
