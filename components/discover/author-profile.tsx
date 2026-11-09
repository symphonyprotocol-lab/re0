'use client';

import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { profileWebUrl, type ProfileDetails } from '@/lib/domain/account';
import { Icon } from '@/components/ui/icons';
import { UserAvatar } from '@/components/ui/ree-avatar';
import { useToast } from '@/components/ui/toast';
import { RoleBadge } from '@/components/discover/role-badge';

interface Author extends ProfileDetails {
  name: string;
  avatar: string | null;
  role: string;
}

/** Public profile only: account email and login-provider details are never passed here. */
export function AuthorProfile({ author }: { author: Author }) {
  const { t } = useI18n();
  const p = t.discover.public.creator;
  const toast = useToast();
  const website = profileWebUrl(author.website);
  const contacts = author.socialContacts.filter((contact) => contact.platform.trim() && contact.value.trim());

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast(p.copied);
    } catch {
      toast(p.copyFailed);
    }
  };

  return (
    <section id="author-profile" aria-labelledby="author-profile-heading" className="mt-7 min-w-0 scroll-mt-24 border-t border-line pt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="author-profile-heading" className="flex items-center gap-2 text-[14px] font-bold">
          <Icon name="user" className="size-4 text-blue" />
          {p.heading}
        </h2>
        {contacts.length > 0 && <a href="#author-contact" className="btn-secondary">{p.viewContacts}</a>}
      </div>
      <div className="mt-4 flex items-start gap-3">
        <UserAvatar name={author.name} avatar={author.avatar} className="size-14" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-y-1">
            <h3 className="text-[16px] font-semibold [overflow-wrap:anywhere]">{author.name}</h3>
            <RoleBadge role={author.role} />
          </div>
          {author.title && <p className="mt-1 text-[12px] text-muted [overflow-wrap:anywhere]">{author.title}</p>}
        </div>
      </div>
      {author.description && <p className="mt-4 text-[13px] leading-relaxed whitespace-pre-wrap text-[#3b4361] [overflow-wrap:anywhere]">{author.description}</p>}
      {website && (
        <a href={website} target="_blank" rel="noopener noreferrer nofollow ugc" className="mt-4 flex items-start gap-2 text-[12px] text-blue hover:underline">
          <Icon name="globe" className="mt-0.5 size-3.5 flex-none" />
          <span className="min-w-0 [overflow-wrap:anywhere]"><span className="text-muted">{p.website} · </span>{website}</span>
          <Icon name="external" className="mt-0.5 size-3 flex-none" />
        </a>
      )}
      {contacts.length > 0 && (
        <div className="mt-5">
          <h3 id="author-contact" tabIndex={-1} className="scroll-mt-24 text-[12px] font-semibold">{p.contacts}</h3>
          <dl className="mt-2 grid gap-2 sm:grid-cols-2">
            {contacts.map((contact, index) => {
              const href = profileWebUrl(contact.value);
              return (
                <div key={`${contact.platform}-${index}`} className="min-w-0 rounded-xl border border-line bg-wash px-3 py-3">
                  <dt className="text-[11px] text-muted [overflow-wrap:anywhere]">{contact.platform}</dt>
                  <dd className="mt-1 flex min-w-0 items-start gap-2 text-[12px]">
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer nofollow ugc" className="flex min-w-0 flex-1 items-start gap-1.5 text-blue hover:underline">
                        <span className="min-w-0 [overflow-wrap:anywhere]">{contact.value}</span>
                        <Icon name="external" className="mt-1 size-3 flex-none" />
                      </a>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 select-text [overflow-wrap:anywhere]">{contact.value}</span>
                        <button type="button" onClick={() => void copy(contact.value)} aria-label={fill(p.copyContact, { platform: contact.platform })} className="flex-none rounded p-1 text-muted hover:text-blue focus-visible:outline-2 focus-visible:outline-blue">
                          <Icon name="copy" className="size-3.5" />
                        </button>
                      </>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      )}
    </section>
  );
}
