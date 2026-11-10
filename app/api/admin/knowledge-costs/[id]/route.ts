import { apiAdministrator } from '@/lib/http/admin';
import { adminParams } from '@/lib/http/admin-params';
import { fail, json } from '@/lib/http/respond';
import { knowledgeCostDetail } from '@/lib/services/admin-knowledge-costs';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  const detail = await knowledgeCostDetail(params.id);
  return detail ? json(detail) : fail('not_found', 404);
}
