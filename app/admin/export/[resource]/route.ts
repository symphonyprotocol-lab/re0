/**
 * GET /admin/export/:resource -- CSV of a console list.
 *
 * Under `/admin` rather than `/api`, for the same reason sign-out is: the
 * console session cookie is scoped to that path, so a handler outside it never
 * receives the cookie and could not authorise the request at all.
 *
 * The capability is re-checked per resource. An operator who cannot open the
 * billing screen must not be able to download it either, and a route that
 * exists only because a screen linked to it is not a check.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { CONSOLE_EXPORTS, isExportableResource, recordAudit } from '@/lib/application/administration';
import { requireAdmin } from '@/lib/http/admin';
import { clientAddress } from '@/lib/http/client-address';

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ resource: string }> },
): Promise<NextResponse> {
  const { resource } = await context.params;
  if (!isExportableResource(resource)) {
    return new NextResponse('unknown export', { status: 404 });
  }

  const descriptor = CONSOLE_EXPORTS[resource]!;
  const session = await requireAdmin();
  if (!session.capabilities.includes(descriptor.capability)) {
    return new NextResponse('not entitled to this export', { status: 403 });
  }

  const params = request.nextUrl.searchParams;
  const query = params.get('q')?.slice(0, 200) ?? undefined;
  const status = params.get('status')?.slice(0, 40) ?? undefined;
  const period = params.get('period')?.slice(0, 7) ?? undefined;
  const kind = params.get('kind')?.slice(0, 20) ?? undefined;
  const from = params.get('from')?.slice(0, 10) ?? undefined;
  const to = params.get('to')?.slice(0, 10) ?? undefined;

  const csv = await descriptor.build({ query, status, period, kind, from, to });

  /*
   * Bulk extraction of user and billing data is exactly the kind of action
   * requirement.md 5.3 wants a trail for -- who took a copy, of what, filtered
   * how, and when.
   */
  await recordAudit({
    administratorId: session.administratorId,
    action: 'admin.export',
    targetType: 'console_list',
    targetId: resource,
    afterValue: {
      query: query ?? null,
      status: status ?? null,
      period: period ?? null,
      kind: kind ?? null,
      from: from ?? null,
      to: to ?? null,
      bytes: csv.length,
    },
    clientAddress:
      clientAddress(request.headers),
    result: 'success',
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="re0-${descriptor.filename}-${stamp}.csv"`,
      // A list of administrators is not something to leave in a shared cache.
      'cache-control': 'no-store',
    },
  });
}
