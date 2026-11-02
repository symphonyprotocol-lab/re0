import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { AUDIT_CSV, listOrCsv } from '@/lib/http/admin-lists';
import { auditView } from '@/lib/domain/admin-lists';
import { listAudit } from '@/lib/services/admin-audit';

/** The audit trail: `q`, `action` (8.3's codes), `period`, `sort`, `size`, `page`; `format=csv`. */
export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const view = auditView(request.nextUrl.searchParams);
  return listOrCsv(request, (all) => listAudit(view, { all }), AUDIT_CSV);
}
