import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { auditExport, CSV_MAX_ROWS, csvResponse, wantsCsv } from '@/lib/http/admin-lists';
import { fail, json } from '@/lib/http/respond';
import { reportingTime } from '@/lib/domain/statistics';
import { modelCallsView } from '@/lib/domain/model-calls';
import { modelCallReport } from '@/lib/services/admin-model-calls';

export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const view = modelCallsView(request.nextUrl.searchParams);
  if (!wantsCsv(request)) return json(await modelCallReport(view, { all: false }));
  /* Counted on a page first: an export past the cap is refused before it is loaded. */
  const { total } = await modelCallReport(view, { all: false });
  if (total > CSV_MAX_ROWS) return fail('export_too_large', 413, { total, max: CSV_MAX_ROWS });
  const report = await modelCallReport(view, { all: true });
  await auditExport(administrator.id, request, 'model-calls', report.items.length);
  return csvResponse('model-calls', ['ID', 'Time (UTC+8)', 'Model', 'Configuration', 'User ID', 'User', 'Email', 'Audience', 'Purpose', 'Status', 'Duration ms', 'Input tokens', 'Output tokens', 'Usage known', 'Cost USD', 'Cost basis', 'Input USD/token', 'Output USD/token', 'Price source', 'Price revision', 'Endpoint', 'Provider request ID', 'Error code'],
    report.items.map((r) => [r.id, reportingTime(r.createdAt), r.model, r.configName, r.userId, r.userName, r.userEmail, r.audience, r.purpose, r.status, r.durationMs, r.inputTokens, r.outputTokens, r.usageKnown, r.costUsd, r.costBasis, r.rate?.usdPerUnit, r.rate?.outputUsdPerUnit, r.rate?.source, r.priceRevision, r.endpoint, r.requestId, r.errorCode]));
}
