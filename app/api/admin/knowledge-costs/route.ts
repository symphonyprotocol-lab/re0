import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { csvResponse, wantsCsv } from '@/lib/http/admin-lists';
import { json } from '@/lib/http/respond';
import { reportingTime } from '@/lib/domain/statistics';
import { knowledgeCostsView } from '@/lib/domain/knowledge-costs';
import { knowledgeCostReport } from '@/lib/services/admin-knowledge-costs';

export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const report = await knowledgeCostReport(knowledgeCostsView(request.nextUrl.searchParams), { all: wantsCsv(request) });
  if (!wantsCsv(request)) return json(report);
  return csvResponse('knowledge-costs', ['Record ID', 'Run ID', 'Source ID', 'Source', 'Ree', 'User', 'Email', 'Kind', 'Status', 'Known supplier USD', 'Complete supplier USD', 'Net credits', 'Returned credits', 'Held credits', 'Calls', 'Unresolved calls', 'Metered', 'Reserved (UTC+8)', 'Closed (UTC+8)', 'Supplier receipts'],
    report.items.map((r) => [r.id, r.runId, r.knowledgeId, r.title, r.reeName, r.name, r.email, r.kind, r.status, r.knownCostUsd, r.costUsd, r.chargedCredits, r.refundedCredits, r.heldCredits, r.calls, r.unresolved, r.metered, reportingTime(r.createdAt), reportingTime(r.closedAt), r.charges]));
}
