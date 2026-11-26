/**
 * The one list of audit action codes (rebuild-proposal.md 8.3), shared by the
 * code that writes `admin_audit` and the filter that reads it.
 */
export const AUDIT_ACTIONS = [
  'admin.bootstrap',
  'admin.login',
  'admin.create',
  'admin.disable',
  'admin.invite.reissue',
  'admin.login.locked',
  'admin.export',
  'pricing.update',
  'anonymous_chat.update',
  'rewards.update',
  'payout.minimum.update',
  'earned.settings.update',
  'user.payout_minimum',
  'model.create',
  'model.update',
  'model.delete',
  'model.cost_backfill',
  'model.probe',
  'model.activate',
  'model.reembed.start',
  'model.reembed.done',
  'model.reembed.failed',
  'model.chain.update',
  'model.cooldown',
  'model.recover',
  'model.cooldown.clear',
  'firecrawl.key.create',
  'firecrawl.key.update',
  'firecrawl.key.delete',
  'rate_limit.update',
  'rate_limit.reset',
  'rate_limit.ceiling.update',
  'rate_limit.ceiling.reset',
  'rate_limit.exempt.add',
  'rate_limit.exempt.update',
  'rate_limit.exempt.remove',
  'user.disable',
  'user.restore',
  'user.credits.adjust',
  'user.role.official',
  'user.role.cancel_official',
  'user.role.revoke',
  'user.api_key.revoke',
  'verification.approved',
  'verification.rejected',
  'kyc.verified',
  'kyc.rejected',
  'kyc.reset',
  'kyc.files.view',
  'payout.approved',
  'payout.rejected',
  'payout.paid',
  'payout.failed',
  'ree.takedown',
  'ree.restore',
  'ree.pin',
  'ree.unpin',
  'ree.qa.hide',
  'ree.qa.restore',
  'post.hide',
  'post.restore',
  'post.quote.keep',
  'post.quote.hide_answers',
  'post.ai.hide',
  'post.ai.restore',
  'redeem.batch.create',
  'redeem.batch.update',
  'redeem.batch.export',
  'redeem.code.reveal',
  'redeem.code.disable',
  'redeem.code.enable',
  'workspace.publication.takedown',
  'workspace.publication.restore',
  'workspace.publication.freeze',
  'workspace.publication.unfreeze',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === 'string' && (AUDIT_ACTIONS as readonly string[]).includes(value);
}

/**
 * The action codes whose label, in any of the given languages, contains `q`
 * (case-insensitive), so the audit search also finds "下架" or "take down"
 * (prototype admin-records.js searches the localised action name).
 */
export function actionsLabelled(q: string, labels: readonly Partial<Record<string, string>>[]): AuditAction[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return AUDIT_ACTIONS.filter((code) => labels.some((names) => (names[code] ?? '').toLowerCase().includes(needle)));
}
