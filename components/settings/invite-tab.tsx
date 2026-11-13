import { inviteLink, invitePanelCopy } from '@/lib/domain/invites';
import { appBaseUrl } from '@/lib/http/cookies';
import type { InvitePanel } from '@/lib/services/invites';
import { INVITEES_SHOWN } from '@/lib/constants';
import { serverMessages } from '@/i18n/server';
import { fill, formatDate, formatNumber } from '@/i18n/format';
import { UserAvatar } from '@/components/ui/ree-avatar';
import { InviteCopy } from '@/components/settings/invite-copy';
import { I } from '@/components/settings/icon';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';

/**
 * `/settings?tab=invite` (docs/design/invitations.md): the account's code
 * and link, whether invitations count right now and whether they still pay
 * withdrawable credits, and who signed up through it with what each earned.
 */
export async function InviteTab({ panel }: { panel: InvitePanel }) {
  const { t, locale } = await serverMessages();
  const p = t.invites.panel;
  const n = (value: number) => formatNumber(value, locale);
  const link = inviteLink(appBaseUrl(), panel.code);
  /* One decision for every note, so they never contradict (a limit of 0 means gift credits only). */
  const copy = invitePanelCopy(panel);
  return (
    <>
      <section className="card role-panel invite-panel">
        <span className="role-eyebrow">{p.eyebrow}</span>
        <h2>{p.title}</h2>
        <p>{panel.inviteCredits > 0 ? fill(p.lede, { n: n(panel.inviteCredits) }) : p.ledeOff}</p>
        {copy.withdrawableNote && (
          <p>
            {fill(p.withdrawableNote, { quota: n(panel.withdrawableQuota), cap: n(panel.ownCap) })}{' '}
            <Link href="/settings?tab=balance" className="text-link">
              {p.payoutLink}
            </Link>
          </p>
        )}
        {copy.status && (
          <p role="status" className="role-state-note">
            {copy.status === 'closed'
              ? p.closed
              : copy.status === 'gift_only'
                ? p.giftOnly
                : copy.status === 'site_quota_used'
                  ? p.quotaUsed
                  : fill(p.ownCapReached, { cap: n(panel.ownCap) })}
          </p>
        )}
        {copy.progress && <p>{fill(p.ownProgress, { used: n(Math.min(panel.ownWithdrawable, panel.ownCap)), cap: n(panel.ownCap) })}</p>}
        <div className="invite-fields">
          <label>
            {p.code}
            <input readOnly value={panel.code} className="mono" aria-label={p.code} />
          </label>
          <label>
            {p.link}
            <input readOnly value={link} aria-label={p.link} />
          </label>
        </div>
        <InviteCopy link={link} />
      </section>

      <section className="card role-panel">
        <div className="invite-stats">
          <div>
            <small>{p.stats.invited}</small>
            <strong className="mono">{n(panel.total)}</strong>
          </div>
          <div>
            <small>{p.stats.withdrawable}</small>
            <strong className="mono">{n(panel.earnedWithdrawable)}</strong>
          </div>
          <div>
            <small>{p.stats.gift}</small>
            <strong className="mono">{n(panel.earnedGift)}</strong>
          </div>
        </div>
        <h2>{p.list}</h2>
        {panel.invitees.length === 0 ? (
          <p>{p.empty}</p>
        ) : (
          <div>
            {panel.invitees.map((invitee, index) => (
              <div key={index} className="role-requirement met invite-person">
                <UserAvatar name={invitee.name} avatar={invitee.avatarBlob} className="size-8" />
                <div>
                  <strong>{invitee.name}</strong>
                  <span>{fill(p.joined, { date: formatDate(invitee.createdAt, locale) })}</span>
                </div>
                <small className="mono">
                  {invitee.rewardCredits > 0
                    ? `+${n(invitee.rewardCredits)} · ${p.kinds[invitee.withdrawable ? 'withdrawable' : 'gift']}${invitee.giftReason ? ` (${p.giftReasons[invitee.giftReason]})` : ''}`
                    : p.noReward}
                </small>
              </div>
            ))}
            {panel.total > INVITEES_SHOWN && (
              <p className="role-footnote">
                <I name="info" /> {fill(p.more, { n: n(INVITEES_SHOWN) })}
              </p>
            )}
          </div>
        )}
      </section>
    </>
  );
}
