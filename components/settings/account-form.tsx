'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DISPLAY_NAME_MAX } from '@/lib/constants';
import { PROFILE_LIMITS, profileChanges, type ProfileDetails } from '@/lib/domain/account';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime } from '@/i18n/format';
import { Spinner } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { ProfileAvatar } from '@/components/settings/profile-avatar';
import { ProviderMark } from '@/components/settings/provider-mark';

interface Account extends ProfileDetails {
  name: string;
  avatarBlob: string | null;
  email: string;
  provider: 'google' | 'github';
  providerHandle: string | null;
  lastLoginAt: string | null;
}

/** Editable profile, read-only sign-in details, and interface language. */
export function AccountForm({ account }: { account: Account }) {
  const { t, locale } = useI18n();
  const s = t.settings;
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(account.name);
  const [title, setTitle] = useState(account.title);
  const [description, setDescription] = useState(account.description);
  const [website, setWebsite] = useState(account.website);
  const [contacts, setContacts] = useState(() => account.socialContacts.map((contact, id) => ({ ...contact, id })));
  const [nextContactId, setNextContactId] = useState(account.socialContacts.length);
  const [avatar, setAvatar] = useState(account.avatarBlob);
  const [cropping, setCropping] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const github = account.provider === 'github';
  const providerName = github ? 'GitHub' : 'Google';
  /** GitHub's login as `@handle`; Google's handle is the email, so its account shows as the display name. */
  const handle = github && account.providerHandle ? `@${account.providerHandle}` : null;

  const save = async () => {
    if (saving) return;
    const trimmed = name.trim();
    if (cropping) return setError(s.crop.pending);
    if (!trimmed || Array.from(trimmed).length > DISPLAY_NAME_MAX) return setError(s.errors.name);
    const details = profileChanges({ title, description, website, socialContacts: contacts });
    if ('error' in details) return setError(s.errors[details.error]);
    setSaving(true);
    setError('');
    try {
      const result = await api<{ error?: string }>('/api/account', { method: 'PATCH', json: { name: trimmed, avatarBlob: avatar, ...details.changes } });
      if (!result.ok) {
        const code = result.data.error;
        return setError(code && code in s.errors ? s.errors[code as keyof typeof s.errors] : t.common.errors.generic);
      }
      toast(s.saved);
      router.refresh();
    } catch {
      setError(t.common.errors.generic);
    } finally {
      setSaving(false);
    }
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
          <fieldset className="profile-editor" disabled={saving}>
            <ProfileAvatar name={name.trim() || account.name} value={avatar} onChange={setAvatar} onCropping={setCropping} />
            <div className="field">
              <label htmlFor="profile-name">{s.name}</label>
              <input
                id="profile-name"
                name="name"
                maxLength={DISPLAY_NAME_MAX}
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="profile-title">{s.details.title}</label>
              <input id="profile-title" name="title" maxLength={PROFILE_LIMITS.title} value={title} placeholder={s.details.titlePlaceholder} onChange={(event) => setTitle(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="profile-description">{s.details.description}</label>
              <textarea id="profile-description" name="description" rows={4} maxLength={PROFILE_LIMITS.description} value={description} placeholder={s.details.descriptionPlaceholder} onChange={(event) => setDescription(event.target.value)} aria-describedby="profile-description-count" />
              <small id="profile-description-count" className="profile-character-count">{Array.from(description).length} / {PROFILE_LIMITS.description}</small>
            </div>
            <div className="field">
              <label htmlFor="profile-website">{s.details.website}</label>
              <input id="profile-website" name="website" type="url" autoCapitalize="none" maxLength={PROFILE_LIMITS.website} value={website} placeholder="https://example.com" onChange={(event) => setWebsite(event.target.value)} />
            </div>
            <section className="profile-socials" aria-labelledby="profile-socials-heading">
              <div className="between profile-socials-head">
                <h3 id="profile-socials-heading">{s.details.socials}</h3>
                <button className="btn secondary" type="button" disabled={contacts.length >= PROFILE_LIMITS.socialContacts} onClick={() => {
                  setContacts([...contacts, { id: nextContactId, platform: '', value: '' }]);
                  setNextContactId(nextContactId + 1);
                }}>{s.details.addContact}</button>
              </div>
              <p className="profile-socials-hint">{s.details.socialsHint}</p>
              <div className="profile-social-list">
                {contacts.map((contact, index) => (
                  <div key={contact.id} className="profile-social-row">
                    <div className="field">
                      <label htmlFor={`profile-platform-${contact.id}`}>{s.details.platform}</label>
                      <input id={`profile-platform-${contact.id}`} maxLength={PROFILE_LIMITS.platform} value={contact.platform} placeholder={s.details.platformPlaceholder} onChange={(event) => setContacts(contacts.map((item) => item.id === contact.id ? { ...item, platform: event.target.value } : item))} />
                    </div>
                    <div className="field">
                      <label htmlFor={`profile-contact-${contact.id}`}>{s.details.contact}</label>
                      <input id={`profile-contact-${contact.id}`} maxLength={PROFILE_LIMITS.contact} value={contact.value} placeholder={s.details.contactPlaceholder} onChange={(event) => setContacts(contacts.map((item) => item.id === contact.id ? { ...item, value: event.target.value } : item))} />
                    </div>
                    <button className="profile-social-remove" type="button" aria-label={fill(s.details.removeContact, { index: index + 1 })} onClick={() => setContacts(contacts.filter((item) => item.id !== contact.id))}>{s.details.remove}</button>
                  </div>
                ))}
              </div>
              {contacts.length >= PROFILE_LIMITS.socialContacts && <p className="profile-socials-hint">{s.details.socialsLimit}</p>}
            </section>
            {error && <p role="alert" className="form-error">{error}</p>}
            <button className="btn" type="submit" disabled={saving}>
              {saving && <Spinner />}
              {s.save}
            </button>
          </fieldset>
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
