import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import type { ReeCard } from '@/lib/services/explore';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';

/** The composer's private tab with these Rees chosen and the question written: `/?compose=private&rees=…&ask=…`. */
export function roundtableHref(question: string, reeIds: readonly string[]): string {
  return `/?${new URLSearchParams({ compose: 'private', rees: reeIds.join(','), ask: question })}`;
}

/**
 * "一起问前 3 个 Ree" (ree-council-proposal.md 4.4): above the search
 * results, never on a card (2.4 keeps cards free of inputs and buttons).
 * Private questions are posts now (2026-11-20): it opens the composer's
 * 私密提问 with the top Rees chosen and the question written, so the asker
 * sees the price and sends it themselves. A visitor signs in first and
 * lands on that same composer.
 */
export function RoundtableEntry({ question, rees, signedIn }: { question: string; rees: Pick<ReeCard, 'id' | 'name' | 'price' | 'avatarBlob' | 'color'>[]; signedIn: boolean }) {
  const { t, locale } = useI18n();
  const e = t.discover.explore.roundtable;
  const cost = rees.reduce((sum, ree) => sum + ree.price, 0);
  const href = roundtableHref(question, rees.map((ree) => ree.id));

  return (
    <section className="roundtable-entry" aria-label={fill(e.title, { n: rees.length })}>
      <div className="roundtable-entry-avatars" aria-hidden="true">
        {rees.map((ree) => (
          <ReeAvatar key={ree.id} avatar={ree.avatarBlob} color={ree.color} size="sm" className="roundtable-entry-avatar" />
        ))}
      </div>
      <div className="roundtable-entry-text">
        <strong>{fill(e.title, { n: rees.length })}</strong>
        <span>
          {rees.map((ree) => ree.name).join(' · ')} — {e.body}
        </span>
      </div>
      {signedIn ? (
        <Link href={href} className="btn sm">
          <Icon name="users" />
          {e.ask}
          <small>· {fill(e.cost, { n: formatNumber(cost, locale) })}</small>
        </Link>
      ) : (
        <Link href={`/login?returnTo=${encodeURIComponent(href)}`} className="btn sm">
          <Icon name="users" />
          {e.login}
        </Link>
      )}
    </section>
  );
}
