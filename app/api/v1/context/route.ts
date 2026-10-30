/**
 * GET /api/v1/context -- retrieval within one asset. architecture.md 12.1.
 *
 * The route is a thin shell: authentication and the anonymous rate limit in
 * `retrievalCaller`, parameter validation against the shared contract, then
 * the single retrieval use case (architecture.md 9.2 -- REST, MCP and the
 * playground all call the same function). `type=txt` is rendered from the
 * canonical JSON by the formatter, never assembled separately.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { AppError } from '@/contracts/errors';
import { queryDocsInputSchema } from '@/contracts/schemas';
import { requireScope } from '@/lib/application/auth';
import { queryDocs } from '@/lib/application/retrieval';
import { renderContextText } from '@/lib/application/retrieval/format';
import { retrievalCaller, trialHeaders } from '@/lib/http/retrieval-caller';
import { errorResponse, newRequestId } from '@/lib/http/respond';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const caller = await retrievalCaller(request, requestId);
    requireScope(caller, 'knowledge:read');

    const params = request.nextUrl.searchParams;
    const maxTokens = params.get('maxTokens');
    const parsed = queryDocsInputSchema.safeParse({
      assetId: params.get('assetId') ?? undefined,
      query: params.get('query') ?? undefined,
      ...(maxTokens === null ? {} : { maxTokens: Number(maxTokens) }),
      format: params.get('type') ?? undefined,
    });
    if (!parsed.success) {
      throw new AppError(
        'invalid_request',
        'assetId and query are required; maxTokens 256-64000; type json or txt',
      );
    }

    const output = await queryDocs(caller, parsed.data);

    if (parsed.data.format === 'txt') {
      return new NextResponse(renderContextText(output), {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'private, no-store',
          ...trialHeaders(caller.trial),
        },
      });
    }
    return NextResponse.json(output, {
      headers: { 'cache-control': 'private, no-store', ...trialHeaders(caller.trial) },
    });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
