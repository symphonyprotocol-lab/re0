import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { AdminInputError } from '@/lib/services/admin';
import { saveFirecrawlDefaultPricing } from '@/lib/services/firecrawl-keys';

export async function PUT(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try { return json(await saveFirecrawlDefaultPricing(administrator.id, await body(request))); }
  catch (error) { if (error instanceof AdminInputError) return fail(error.code, 422); throw error; }
}
