import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { csvResponse, wantsCsv } from '@/lib/http/admin-lists';
import { json } from '@/lib/http/respond';
import { reportingTime } from '@/lib/domain/statistics';
import { modelCallsView } from '@/lib/domain/model-calls';
import { modelCallReport } from '@/lib/services/admin-model-calls';

export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const report = await modelCallReport(modelCallsView(request.nextUrl.searchParams), { all: wantsCsv(request) });
  if (!wantsCsv(request)) return json(report);
  return csvResponse('model-calls', ['ID', 'Time (UTC+8)', 'Model', 'Configuration', 'User ID', 'User', 'Email', 'Audience', 'Purpose', 'Status', 'Duration ms', 'Input tokens', 'Output tokens', 'Usage known', 'Cost USD', 'Cost basis', 'Input USD/token', 'Output USD/token', 'Price source', 'Price revision', 'Endpoint', 'Provider request ID', 'Error code'],
    report.items.map((r) => [r.id, reportingTime(r.createdAt), r.model, r.configName, r.userId, r.userName, r.userEmail, r.audience, r.purpose, r.status, r.durationMs, r.inputTokens, r.outputTokens, r.usageKnown, r.costUsd, r.costBasis, r.rate?.usdPerUnit, r.rate?.outputUsdPerUnit, r.rate?.source, r.priceRevision, r.endpoint, r.requestId, r.errorCode]));
}
