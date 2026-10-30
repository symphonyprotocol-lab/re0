/**
 * GET /dashboard/export/requests -- CSV of the workspace's request log.
 * requirement.md 5.2: the same filters as the screen, as the same query
 * string, so what is downloaded is what was on the page and every page after
 * it. Session-gated: a workspace exports its own log and nothing else.
 *
 * Streamed a batch at a time, so a long log neither sits in memory whole nor
 * waits for its last row before the first byte leaves. Never the query text
 * (architecture.md 17.1) -- the log does not hold it.
 *
 * Cells go through the console's `csvCell`, the one implementation of the
 * quoting and formula-injection rules. A second copy had drifted here and
 * guarded a leading `=` but not a leading tab or carriage return, which Excel
 * treats the same way -- and an operation name or asset id is user-chosen.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { csvCell } from '@/lib/application/administration/csv';
import { iterateRequests } from '@/lib/application/plans';
import { parseRequestFilter } from '@/lib/domain/request-log';
import { currentSession } from '@/lib/http/session';

export const runtime = 'nodejs';

const HEADER = [
  'request_id',
  'time',
  'entrypoint',
  'operation',
  'asset',
  'status',
  'latency_ms',
  'returned_tokens',
  'api_key',
];

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await currentSession();
  if (!session) return new NextResponse('sign in to export the request log', { status: 401 });

  const filter = parseRequestFilter(Object.fromEntries(request.nextUrl.searchParams.entries()));
  const workspaceId = session.workspace.id;
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      /* A byte-order mark, so a spreadsheet opens UTF-8 asset titles intact. */
      controller.enqueue(encoder.encode(`﻿${HEADER.join(',')}\r\n`));
      try {
        for await (const batch of iterateRequests(workspaceId, filter)) {
          const lines = batch.map((row) =>
            [
              row.requestId,
              row.createdAt,
              row.entrypoint,
              row.operation,
              row.assetPublicId,
              row.statusCode,
              row.latencyMs,
              row.returnedTokens,
              row.apiKeyMasked,
            ]
              .map(csvCell)
              .join(','),
          );
          controller.enqueue(encoder.encode(`${lines.join('\r\n')}\r\n`));
        }
        controller.close();
      } catch (error) {
        console.error(
          `request export failed: ${error instanceof Error ? error.message : 'unknown'}`,
        );
        controller.error(error);
      }
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="re0-requests-${stamp}.csv"`,
      'cache-control': 'private, no-store',
    },
  });
}
