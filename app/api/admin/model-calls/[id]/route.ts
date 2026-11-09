import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { fail, json } from '@/lib/http/respond';
import { modelCallDetail } from '@/lib/services/admin-model-calls';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const call = await modelCallDetail((await context.params).id);
  return call ? json({ call }) : fail('not_found', 404);
}
