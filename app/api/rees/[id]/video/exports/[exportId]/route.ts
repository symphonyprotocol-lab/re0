import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { videoFailure } from '@/lib/http/video';
import { cancelExport } from '@/lib/services/video';

/** Beyond 5: "取消" during an export abandons it and releases its hold at once, rather than waiting for the cron. */
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string; exportId: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { id, exportId } = await context.params;
  try {
    return (await cancelExport(user.id, id, exportId)) ? json({ cancelled: true }) : fail('export_closed', 409);
  } catch (error) {
    return videoFailure(error);
  }
}
