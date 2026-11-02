'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DISPLAY_NAME_MAX } from '@/lib/constants';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { formatDateTime } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { AvatarEditor } from '@/components/rees/avatar-editor';

interface Account {
  name: string;
  avatarBlob: string | null;
  email: string;
  provider: 'google' | 'github';
  providerHandle: string | null;
  lastLoginAt: string | null;
}

/** Profile (avatar, display name), read-only sign-in details, and the interface language (prototype profile.js). */
export function AccountForm({ account }: { account: Account }) {
  const { t, locale } = useI18n();
  const s = t.settings;
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(account.name);
  const [avatar, setAvatar] = useState(account.avatarBlob);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = name.trim();
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
    <div className="flex flex-col gap-6">
      <section className="card p-6">
        <h1 className="text-[17px] font-bold">{s.profile}</h1>
        <form
          className="mt-5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <AvatarEditor
            kind="user"
            name={name}
            value={avatar}
            onChange={setAvatar}
            labels={{ title: s.avatar, upload: s.avatarUpload, change: s.avatarChange, reset: s.avatarDefault, hint: s.avatarHint }}
          />
          <div className="mt-5">
            <label htmlFor="profile-name" className="field-label">
              {s.name}
            </label>
            <input id="profile-name" className="input" maxLength={DISPLAY_NAME_MAX} required value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="mt-6 rounded-xl border border-line bg-wash p-4">
            <h2 className="text-[13px] font-bold">{s.login.title}</h2>
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-[12px] sm:grid-cols-[120px_1fr]">
              <dt className="text-muted">{s.login.provider}</dt>
              <dd className="flex items-center gap-1.5 font-medium">
                {account.provider === 'github' ? <Icon name="github" className="size-3.5" /> : <span className="font-extrabold text-[#4285f4]">G</span>}
                {account.provider === 'github' ? 'GitHub' : 'Google'}
              </dd>
              <dt className="text-muted">{s.login.handle}</dt>
              <dd className="truncate font-medium">{account.providerHandle ?? '—'}</dd>
              <dt className="text-muted">{s.login.email}</dt>
              <dd className="truncate font-medium">{account.email}</dd>
              <dt className="text-muted">{s.login.lastLogin}</dt>
              <dd className="font-medium">{account.lastLoginAt ? formatDateTime(account.lastLoginAt, locale) : '—'}</dd>
            </dl>
            <p className="mt-3 text-[11px] text-muted">{s.login.note}</p>
          </div>
          {error && (
            <p role="alert" className="mt-4 text-[12px] text-red">
              {error}
            </p>
          )}
          <button type="submit" className="btn mt-5" disabled={saving}>
            {saving && <Spinner />}
            {s.save}
          </button>
        </form>
      </section>
      <section className="card flex flex-wrap items-center justify-between gap-4 p-6">
        <div>
          <h2 className="text-[17px] font-bold">{s.language}</h2>
          <p className="mt-1 text-[12px] text-muted">
            {s.languageTitle} · {s.languageBody}
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={switchLanguage}>
          <Icon name="globe" />
          {t.common.language.switchTo}
        </button>
      </section>
    </div>
  );
}
