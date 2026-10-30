/**
 * An uploaded file of a published platform asset, for anyone.
 *
 * Citations of a platform PDF asset point here (`lib/infrastructure/
 * connectors/pdf.ts`). Only published assets answer: a draft's files are
 * the operator's to preview, through `/admin/files/[fileId]`, whose session
 * cookie never reaches this path. The dashboard's `/dashboard/files/[fileId]`
 * is the workspace counterpart; the three stay separate because their
 * authorities do (requirement.md 3.2).
 */
import { platformFileRedirect } from '@/lib/http/platform-file';

export async function GET(
  _request: Request,
  context: { params: Promise<{ fileId: string }> },
): Promise<Response> {
  const { fileId } = await context.params;
  return platformFileRedirect(fileId, { includeUnpublished: false });
}
