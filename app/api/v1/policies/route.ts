/**
 * GET / PATCH /api/v1/policies -- workspace access rules. architecture.md 10.
 *
 * PATCH is incremental on the wire (enable/disable, add/remove/clear); the
 * server materialises a complete immutable Policy Version and answers with
 * the resulting policy and `accessibleAssetCount`. Policies belong to a
 * workspace, so both verbs require an API key -- there is no anonymous form.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { AppError } from '@/contracts/errors';
import { policyPatchSchema } from '@/contracts/schemas';
import { resolveApiKey } from '@/lib/application/auth/api-key';
import { patchPolicy, readPolicy } from '@/lib/application/policies';
import { errorResponse, newRequestId } from '@/lib/http/respond';

export const runtime = 'nodejs';

async function workspaceOf(request: NextRequest): Promise<string> {
  const principal = await resolveApiKey(request.headers.get('authorization'));
  if (!principal) throw new AppError('invalid_api_key', 'an API key is required');
  return principal.workspaceId;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const workspaceId = await workspaceOf(request);
    return NextResponse.json(await readPolicy(workspaceId, requestId), {
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const workspaceId = await workspaceOf(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new AppError('invalid_request', 'the body must be JSON');
    }
    const parsed = policyPatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError('invalid_request', 'unrecognised policy patch shape');
    }

    return NextResponse.json(await patchPolicy(workspaceId, parsed.data, requestId), {
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
