import type { NextRequest } from 'next/server';
import { after } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { body, json } from '@/lib/http/respond';
import { activateModelConfig } from '@/lib/services/models';
import { latestReembedJob, reembedStalled, runReembed } from '@/lib/services/reembed';

export const maxDuration = 300;

/**
 * `{ to }`: switch the embedding model (2.5). Creates the full re-embed job
 * and starts working on it after the response; with nothing indexed yet the
 * entry is simply enabled.
 */
export async function POST(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    const result = await activateModelConfig(administrator.id, String((await body(request)).to ?? ''));
    if (result.reembed) after(() => runReembed().then(() => undefined));
    return json({ ...result, job: await latestReembedJob() }, result.reembed ? 202 : 200);
  } catch (error) {
    return adminFailure(error);
  }
}

/** Progress. A poll that finds the job quiet for a while takes the next step itself. */
export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const job = await latestReembedJob();
  if (job && reembedStalled(job)) after(() => runReembed().then(() => undefined));
  return json({ job });
}
