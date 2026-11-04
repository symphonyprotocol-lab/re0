/**
 * The one list of audit action codes (rebuild-proposal.md 8.3), shared by the
 * code that writes `admin_audit` and the filter that reads it.
 */
export const AUDIT_ACTIONS = [
  'admin.bootstrap',
  'admin.login',
  'admin.create',
  'admin.disable',
  'pricing.update',
  'model.create',
  'model.update',
  'model.cost_backfill',
  'model.probe',
  'model.activate',
  'model.reembed.start',
  'model.reembed.done',
  'model.reembed.failed',
  'firecrawl.key.create',
  'firecrawl.key.update',
  'firecrawl.key.delete',
  'user.disable',
  'user.restore',
  'user.credits.adjust',
  'user.role.official',
  'user.role.cancel_official',
  'user.role.revoke',
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
