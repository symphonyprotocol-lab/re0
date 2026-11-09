/** Profile fields shared by settings and the account API. Social contacts may be URLs or handles. */
export const PROFILE_LIMITS = { title: 80, description: 1000, website: 2048, socialContacts: 10, platform: 40, contact: 300 } as const;

export interface SocialContact {
  platform: string;
  value: string;
}

export interface ProfileDetails {
  title: string;
  description: string;
  website: string;
  socialContacts: SocialContact[];
}

export type ProfileError = keyof ProfileDetails;

/** Only explicit web URLs become public links; handles and other text remain copyable. */
export function profileWebUrl(value: string): string | null {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    return /^https?:\/\//i.test(trimmed) && ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? trimmed : null;
  } catch {
    return null;
  }
}

/** Validates only supplied fields so language/avatar updates preserve existing profile details. */
export function profileChanges(input: Record<string, unknown>): { changes: Partial<ProfileDetails> } | { error: ProfileError } {
  const changes: Partial<ProfileDetails> = {};
  for (const field of ['title', 'description', 'website'] as const) {
    if (!(field in input)) continue;
    const raw = input[field];
    if (typeof raw !== 'string' || Array.from(raw.trim()).length > PROFILE_LIMITS[field]) return { error: field };
    changes[field] = raw.trim();
  }
  if (changes.website && !profileWebUrl(changes.website)) return { error: 'website' };
  if ('socialContacts' in input) {
    if (!Array.isArray(input.socialContacts) || input.socialContacts.length > PROFILE_LIMITS.socialContacts) return { error: 'socialContacts' };
    const contacts: SocialContact[] = [];
    for (const item of input.socialContacts) {
      if (!item || typeof item !== 'object' || typeof item.platform !== 'string' || typeof item.value !== 'string') return { error: 'socialContacts' };
      const platform = item.platform.trim();
      const value = item.value.trim();
      if (!platform && !value) continue;
      if (!platform || !value || Array.from(platform).length > PROFILE_LIMITS.platform || Array.from(value).length > PROFILE_LIMITS.contact) return { error: 'socialContacts' };
      contacts.push({ platform, value });
    }
    changes.socialContacts = contacts;
  }
  return { changes };
}
