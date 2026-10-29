/**
 * Use case: backfill one billing document the webhook never delivered.
 *
 * A notification can be lost for good -- a destination pointed at the wrong
 * path, a tunnel that died, a provider that gave up after its last retry --
 * and the buyer has paid for something the mirror never heard about. This is
 * the console's way to catch it up, and it is shaped by the same rule as the
 * rest of billing: re0 never moves money and never makes up a figure
 * (requirement.md 4.3). The operator names the provider's document id and
 * nothing else; the amount, the status and the buyer are re-read from the
 * provider's API and applied through the webhook's own path
 * (`applyPaymentNotification`), so a backfilled document and a delivered one
 * cannot come out different.
 *
 * Each run is recorded as a `payment_event` of its own, with what the provider
 * returned, under a fresh id. Re-running is safe without the event key: the
 * mirror is keyed on the document and the pack grant on the order, and each
 * is guarded against older state.
 * A fresh id also means a run that could not be placed -- no workspace, no
 * pack version -- can be tried again once that is fixed, where a reused key
 * would answer `redelivered` forever.
 */
import { and, eq } from 'drizzle-orm';
import { AdminChangeRefused, normalizeReason } from '@/lib/domain/admin';
import type { BillingDocumentStatus } from '@/lib/domain/billing';
import { uuidv7 } from '@/lib/domain/id';
import {
  paymentAdapter,
  PaymentNotConfigured,
  PaymentProviderError,
  type ProviderDocumentSnapshot,
} from '@/lib/infrastructure/payment/provider';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { recordAudit } from '@/lib/application/administration/audit';
import { applyPaymentNotification } from './webhook';

export const BACKFILL_REFUSALS = [
  'reason_required',
  /** Not shaped like a provider id at all. */
  'invalid_id',
  'not_connected',
  /** The provider has no document by that id. */
  'not_found',
  /** It exists, but is a checkout nobody paid, or not something re0 sells. */
  'not_billable',
  /** Read, but no workspace -- or no pack version -- to place it on. */
  'unresolved',
  /** Read, but the mirror refused what the provider reported. */
  'refused',
  /** The provider or the database could not be reached. Try again. */
  'unavailable',
] as const;

export type BackfillRefusal = (typeof BACKFILL_REFUSALS)[number];

export class BackfillRefused extends Error {
  constructor(readonly code: BackfillRefusal) {
    super(`backfill refused: ${code}`);
    this.name = 'BackfillRefused';
  }
}

export interface BackfillResult {
  documentId: string;
  /** The mirror had no row for this document before the run. */
  created: boolean;
  previousStatus: BillingDocumentStatus | null;
  status: BillingDocumentStatus;
  /** Calls granted by this run; null when it granted none, including an earlier grant. */
  grantedCalls: number | null;
}

/** Wide enough for any provider's ids, narrow enough to keep a URL path segment honest. */
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function backfillProviderDocument(input: {
  actor: { administratorId: string; email: string; clientAddress: string | null };
  externalId: string;
  reason: string;
}): Promise<BackfillResult> {
  let reason: string;
  try {
    reason = normalizeReason(input.reason);
  } catch (error) {
    if (error instanceof AdminChangeRefused) throw new BackfillRefused('reason_required');
    throw error;
  }
  const externalId = input.externalId.trim();
  if (!PROVIDER_ID.test(externalId)) throw new BackfillRefused('invalid_id');

  let adapter;
  try {
    adapter = paymentAdapter();
  } catch (error) {
    if (error instanceof PaymentNotConfigured) throw new BackfillRefused('not_connected');
    throw error;
  }

  const audit = (result: 'success' | 'failure', afterValue: unknown, beforeValue?: unknown) =>
    recordAudit({
      administratorId: input.actor.administratorId,
      action: 'billing.backfill',
      targetType: 'billing_document',
      targetId: externalId,
      reason,
      beforeValue,
      afterValue,
      clientAddress: input.actor.clientAddress,
      result,
    });

  let snapshot: ProviderDocumentSnapshot;
  try {
    snapshot = await adapter.fetchDocument(externalId);
  } catch (error) {
    /* Paddle answers a malformed id with 400 and an unknown one with 404. */
    const missing =
      error instanceof PaymentProviderError && (error.status === 404 || error.status === 400);
    if (!missing) console.error(`billing backfill: ${externalId}: ${(error as Error).message}`);
    await audit('failure', { refusal: missing ? 'not_found' : 'unavailable' });
    throw new BackfillRefused(missing ? 'not_found' : 'unavailable');
  }

  const before = await mirroredState(adapter.provider, externalId);
  let result: BackfillResult;
  try {
    result = await applyProviderSnapshot(adapter.provider, snapshot, {
      administratorId: input.actor.administratorId,
    });
  } catch (error) {
    const code = error instanceof BackfillRefused ? error.code : 'unavailable';
    if (code === 'unavailable') {
      console.error(`billing backfill: ${externalId}: ${(error as Error).message}`);
    }
    await audit('failure', { refusal: code }, before);
    throw error instanceof BackfillRefused ? error : new BackfillRefused('unavailable');
  }

  await audit(
    'success',
    {
      documentId: result.documentId,
      status: result.status,
      grantedCalls: result.grantedCalls,
    },
    before,
  );
  return result;
}

/**
 * Applies what the provider reported through the webhook's own path. Exported
 * for its integration test, which has no provider to read from.
 */
export async function applyProviderSnapshot(
  provider: string,
  snapshot: ProviderDocumentSnapshot,
  meta: { administratorId: string },
): Promise<BackfillResult> {
  const notice = snapshot.document;
  if (!notice) throw new BackfillRefused('not_billable');
  const payload = { source: 'console_backfill', administratorId: meta.administratorId, ...asObject(snapshot.payload) };

  const externalId = notice.document.externalId;
  const before = await mirroredState(provider, externalId);
  const grantBefore = await grantFor(externalId);

  const outcome = await applyPaymentNotification({
    provider,
    externalEventId: `backfill_${uuidv7()}`,
    eventType: 'transaction.backfill',
    payload,
    subject: 'document',
    document: notice,
  });
  if (outcome === 'refused') throw new BackfillRefused('refused');

  const after = await mirroredState(provider, externalId);
  /*
   * `unresolved` covers two cases: nothing was written (no workspace), and
   * the document was written but its pack could not be granted. Either way the
   * customer has not got what they paid for, which is what the operator came
   * here to fix, so both are refused rather than reported as done.
   */
  if (outcome === 'unresolved' || !after) throw new BackfillRefused('unresolved');

  const grantAfter = await grantFor(externalId);
  return {
    documentId: after.id,
    created: before === null,
    previousStatus: before?.status ?? null,
    status: after.status,
    grantedCalls: grantAfter && !grantBefore ? grantAfter.callsGranted : null,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : { value };
}

async function mirroredState(
  provider: string,
  externalId: string,
): Promise<{ id: string; status: BillingDocumentStatus } | null> {
  const [row] = await db()
    .select({ id: schema.billingDocument.id, status: schema.billingDocument.status })
    .from(schema.billingDocument)
    .where(
      and(
        eq(schema.billingDocument.provider, provider),
        eq(schema.billingDocument.externalId, externalId),
      ),
    );
  return row ?? null;
}

async function grantFor(orderId: string): Promise<{ callsGranted: number } | null> {
  const [row] = await db()
    .select({ callsGranted: schema.addonGrant.callsGranted })
    .from(schema.addonGrant)
    .where(eq(schema.addonGrant.providerOrderId, orderId));
  return row ?? null;
}
