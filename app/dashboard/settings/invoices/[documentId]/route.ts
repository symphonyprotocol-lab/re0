/**
 * GET /dashboard/settings/invoices/{documentId} -- download a document's PDF invoice.
 *
 * A plain link from the settings billing table. GET is right here: it changes
 * nothing, and what it hands back is scoped to the session's own workspace.
 * The provider's link expires within the hour, so it is fetched per click and
 * the browser is redirected to it rather than the link being printed in the
 * page. A refusal lands back on the billing card with the reason to print.
 */
import { NextResponse } from 'next/server';
import { invoiceDownloadUrl, InvoiceRefused } from '@/lib/application/billing';
import { appRedirect } from '@/lib/http/auth-endpoints';
import { requireSession } from '@/lib/http/session';

export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  context: { params: Promise<{ documentId: string }> },
): Promise<NextResponse> {
  const { documentId } = await context.params;
  const session = await requireSession('/dashboard/settings#billing');

  let url: string;
  try {
    url = await invoiceDownloadUrl({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      documentId,
    });
  } catch (error) {
    const code = error instanceof InvoiceRefused ? error.code : 'failed';
    if (code === 'failed') console.error('invoice download failed', (error as Error).message);
    return appRedirect(`/dashboard/settings?invoice=${code}#billing`);
  }
  return NextResponse.redirect(url, 302);
}
