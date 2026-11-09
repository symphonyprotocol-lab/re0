import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { ProcessingFailure } from '@/lib/infra/connectors/failure';
import { listGithubRepositories } from '@/lib/infra/connectors/github';
import { githubTokenFor } from '@/lib/services/connections';

export async function GET(request: NextRequest, context: { params: Promise<{ provider: string }> }) {
  if ((await context.params).provider !== 'github') return fail('not_found', 404);
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const page = Number(request.nextUrl.searchParams.get('page') ?? '1');
  if (!Number.isSafeInteger(page) || page < 1) return fail('invalid_page', 400);
  const token = await githubTokenFor(user.id);
  if (!token) return fail('github_not_connected', 422);

  try {
    return json(await listGithubRepositories(token, page));
  } catch (error) {
    if (error instanceof ProcessingFailure && error.httpStatus === 401) return fail('github_not_connected', 422);
    return fail('github_repositories_unavailable', 502);
  }
}
