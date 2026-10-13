/**
 * Use case: download the PDF invoice for one of the workspace's documents.
 *
 * The invoice is the provider's, not ours. Paddle is the merchant of record,
 * so the legal document -- seller, tax lines, the buyer's address -- is the
 * one it issues; rendering our own from the mirror would be a second invoice
 * that disagrees with the first. All this does is check that the document is
 * the caller's and collected, then ask the provider for a fresh link to it.
 */
import { and, eq } from 'drizzle-orm';
import { isCollected } from '@/lib/domain/billing';
import { paymentAdapter } from '@/lib/infrastructure/payment/provider';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { BILLING_ROLES } from './checkout';
import { isUuid } from './list-documents';

export const INVOICE_REFUSALS = [
  'not_connected',
  'forbidden',
  /** No such document in this workspace -- including another workspace's. */
  'not_found',
  /** Not collected, or zero-valued: the provider issues no invoice for it. */
  'unavailable',
] as const;

export type InvoiceRefusal = (typeof INVOICE_REFUSALS)[number];

export function isInvoiceRefusal(value: unknown): value is InvoiceRefusal {
  return typeof value === 'string' && (INVOICE_REFUSALS as readonly string[]).includes(value);
}

export class InvoiceRefused extends Error {
  constructor(readonly code: InvoiceRefusal) {
    super(`invoice refused: ${code}`);
    this.name = 'InvoiceRefused';
  }
}

/**
 * Whether a document has an invoice to download, by what the mirror holds.
 * The settings table shows the button on exactly these rows.
 */
export function hasInvoice(document: { status: Parameters<typeof isCollected>[0]; amountMinor: number }) {
  return isCollected(document.status) && document.amountMinor > 0;
}

/** Returns a short-lived URL that downloads the invoice PDF. */
export async function invoiceDownloadUrl(caller: {
  workspaceId: string;
  role: string;
  documentId: string;
}): Promise<string> {
  /* The invoice carries the billing address: the same roles as the portal. */
  if (!BILLING_ROLES.has(caller.role)) throw new InvoiceRefused('forbidden');
  let adapter;
  try {
    adapter = paymentAdapter();
  } catch {
    throw new InvoiceRefused('not_connected');
  }
  if (!isUuid(caller.documentId)) throw new InvoiceRefused('not_found');

  const [document] = await db()
    .select({
      provider: schema.billingDocument.provider,
      externalId: schema.billingDocument.externalId,
      status: schema.billingDocument.status,
      amountMinor: schema.billingDocument.amountMinor,
    })
    .from(schema.billingDocument)
    .where(
      and(
        eq(schema.billingDocument.id, caller.documentId),
        eq(schema.billingDocument.workspaceId, caller.workspaceId),
      ),
    )
    .limit(1);
  if (!document) throw new InvoiceRefused('not_found');
  /* A document mirrored from a provider this deployment no longer talks to. */
  if (document.provider !== adapter.provider || !hasInvoice(document)) {
    throw new InvoiceRefused('unavailable');
  }
  return adapter.invoiceUrl(document.externalId);
}
