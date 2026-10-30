/**
 * The creator's payout profile (agent-first-proposal.md 6.9): the PayPal
 * address cash goes to, and a record of the tax document the creator sent
 * to operations -- which kind, submitted when, verified by whom and when.
 *
 * The document itself is never uploaded here: re0 does not hold creators'
 * tax forms in the product database, and which forms re0's entity must
 * collect is still an open business item (proposal 13.2 item 1). So the
 * record claims nothing about sufficiency for any jurisdiction: `submitted`
 * says the creator says they sent it, `verified` says an operator checked
 * what arrived. Income accrues whatever the record says; a cash payout
 * needs `verified` and an address (`requestPayout`).
 */
import { eq } from 'drizzle-orm';
import { normalizeReason } from '@/lib/domain/admin';
import { normalizePayeeEmail, PayoutRefused } from '@/lib/domain';
import { uuidv7 } from '@/lib/domain/id';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { recordAudit } from '@/lib/application/administration/audit';
import { CHANNEL_SELLER_AGREEMENT } from '@/lib/application/channels/subscriptions';

/**
 * The kinds a creator can say they sent. Examples from the proposal, not a
 * statement that any of them is what re0 must collect (13.2 item 1).
 */
export const TAX_FORM_KINDS = ['W-9', 'W-8BEN', 'W-8BEN-E', 'other'] as const;
export type TaxFormKind = (typeof TAX_FORM_KINDS)[number];

export function isTaxFormKind(value: unknown): value is TaxFormKind {
  return typeof value === 'string' && (TAX_FORM_KINDS as readonly string[]).includes(value);
}

async function ensureAccount(workspaceId: string): Promise<void> {
  await db()
    .insert(schema.publisherAccount)
    .values({ id: uuidv7(), workspaceId, agreementVersion: CHANNEL_SELLER_AGREEMENT })
    .onConflictDoNothing({ target: schema.publisherAccount.workspaceId });
}

/** The PayPal address payouts go to. */
export async function savePayoutProfile(input: { workspaceId: string; payeeEmail: string }): Promise<void> {
  const payeeEmail = normalizePayeeEmail(input.payeeEmail);
  if (!payeeEmail) throw new PayoutRefused('invalid_email', 'a PayPal email address is required');
  await ensureAccount(input.workspaceId);
  await db().update(schema.publisherAccount).set({ payeeEmail }).where(eq(schema.publisherAccount.workspaceId, input.workspaceId));
}

/** The creator records that they sent a tax document of this kind; an operator verifies it later. */
export async function submitTaxDocument(input: { workspaceId: string; kind: unknown; now?: Date }): Promise<void> {
  if (!isTaxFormKind(input.kind)) throw new PayoutRefused('profile_incomplete', 'choose which document you sent');
  await ensureAccount(input.workspaceId);
  await db()
    .update(schema.publisherAccount)
    .set({ taxFormKind: input.kind, taxFormStatus: 'submitted', taxFormSubmittedAt: input.now ?? new Date(), taxFormVerifiedAt: null, taxFormVerifiedBy: null })
    .where(eq(schema.publisherAccount.workspaceId, input.workspaceId));
}

/** An operator's check of what arrived: verified, or sent back to `missing`. Audited. */
export async function verifyTaxDocument(input: {
  actor: { administratorId: string; clientAddress?: string | null };
  publisherAccountId: string;
  verified: boolean;
  reason: string;
}): Promise<void> {
  const reason = normalizeReason(input.reason);
  const [before] = await db()
    .select({ status: schema.publisherAccount.taxFormStatus, kind: schema.publisherAccount.taxFormKind })
    .from(schema.publisherAccount)
    .where(eq(schema.publisherAccount.id, input.publisherAccountId));
  if (!before) throw new PayoutRefused('no_account', 'no such publisher account');
  const now = new Date();
  await db()
    .update(schema.publisherAccount)
    .set(
      input.verified
        ? { taxFormStatus: 'verified', taxFormVerifiedAt: now, taxFormVerifiedBy: input.actor.administratorId }
        : { taxFormStatus: 'missing', taxFormVerifiedAt: null, taxFormVerifiedBy: null },
    )
    .where(eq(schema.publisherAccount.id, input.publisherAccountId));
  await recordAudit({
    administratorId: input.actor.administratorId,
    action: input.verified ? 'publisher.tax_verify' : 'publisher.tax_reject',
    targetType: 'publisher_account',
    targetId: input.publisherAccountId,
    reason,
    beforeValue: before,
    afterValue: { status: input.verified ? 'verified' : 'missing', kind: before.kind },
    clientAddress: input.actor.clientAddress,
    result: 'success',
  });
}
