'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DISPLAY_NAME_MAX } from '@/lib/constants';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime } from '@/i18n/format';
import { Spinner } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { ProfileAvatar } from '@/components/settings/profile-avatar';
import { ProviderMark } from '@/components/settings/provider-mark';

interface Account {
  name: string;
  avatarBlob: string | null;
  email: string;
  provider: 'google' | 'github';
  providerHandle: string | null;
  lastLoginAt: string | null;
}

/** Profile (photo, display name), read-only sign-in details, and the interface language (prototype app.js `settings` account tab, profile.js). */
export function AccountForm({ account }: { account: Account }) {
  const { t, locale } = useI18n();
  const s = t.settings;
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(account.name);
  const [avatar, setAvatar] = useState(account.avatarBlob);
  const [cropping, setCropping] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const github = account.provider === 'github';
  const providerName = github ? 'GitHub' : 'Google';
  /** GitHub's login as `@handle`; Google's handle is the email, so its account shows as the display name. */
  const handle = github && account.providerHandle ? `@${account.providerHandle}` : null;

  const save = async () => {
    const trimmed = name.trim();
    if (cropping) return setError(s.crop.pending);
    if (!trimmed || Array.from(trimmed).length > DISPLAY_NAME_MAX) return setError(s.errors.name);
    setSaving(true);
    setError('');
    const result = await api('/api/account', { method: 'PATCH', json: { name: trimmed, avatarBlob: avatar } });
    setSaving(false);
    if (!result.ok) return setError(t.common.errors.generic);
    toast(s.saved);
    router.refresh();
  };

  const switchLanguage = async () => {
    await api('/api/account', { method: 'PATCH', json: { lang: locale === 'zh' ? 'en' : 'zh' } });
    router.refresh();
  };

  return (
    <>
      <section className="card settings-card">
        <h2>{s.profile}</h2>
        <form
          id="profile-form"
          className="mt24"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <ProfileAvatar name={name.trim() || account.name} value={avatar} onChange={setAvatar} onCropping={setCropping} />
          <div className="field">
            <label htmlFor="profile-name">{s.name}</label>
            <input
              id="profile-name"
              name="name"
              maxLength={DISPLAY_NAME_MAX}
              required
              value={name}
              aria-invalid={Boolean(error) || undefined}
              onChange={(event) => setName(event.target.value)}
            />
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
          </div>
          <section className="profile-login-info" aria-labelledby="profile-login-heading">
            <div className="between profile-login-head">
              <h3 id="profile-login-heading">{s.login.title}</h3>
            </div>
            <div className="profile-provider">
              <span className="profile-provider-icon">
                <ProviderMark provider={account.provider} />
              </span>
              <div>
                <strong>{fill(s.login.signIn, { provider: providerName })}</strong>
                <p>
                  {account.email}
                  {handle && ` · ${handle}`}
                </p>
              </div>
            </div>
            <dl>
              <div>
                <dt>{s.login.provider}</dt>
                <dd>{providerName}</dd>
              </div>
              <div>
                <dt>{s.login.handle}</dt>
                <dd>{handle ?? account.name}</dd>
              </div>
              <div>
                <dt>{s.login.email}</dt>
                <dd>{account.email}</dd>
              </div>
              {account.lastLoginAt && (
                <div>
                  <dt>{s.login.lastLogin}</dt>
                  <dd>{formatDateTime(account.lastLoginAt, locale)}</dd>
                </div>
              )}
            </dl>
            <p className="profile-login-note">{s.login.note}</p>
          </section>
          <button className="btn" type="submit" disabled={saving}>
            {saving && <Spinner />}
            {s.save}
          </button>
        </form>
      </section>
      <section className="card settings-card">
        <h2>{s.language}</h2>
        <div className="settings-row">
          <div>
            <h3>{s.languageTitle}</h3>
            <p>{s.languageBody}</p>
          </div>
          <button type="button" className="btn secondary" onClick={switchLanguage}>
            {t.common.language.switchTo}
          </button>
        </div>
      </section>
    </>
  );
}
