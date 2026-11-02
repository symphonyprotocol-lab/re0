import type { NextRequest } from 'next/server';
import { json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { videoFailure } from '@/lib/http/video';
import { generateScript, introsFor } from '@/lib/services/video';

/* One live answer and up to three generation calls. */
export const maxDuration = 120;

/**
 * Generates or regenerates the four-shot script (rebuild-proposal.md 2.6):
 * 20 credits, held and settled, refunded when the model fails. Refused
 * without a ready source (409 `no_ready_source`).
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const id = (await context.params).id;
  try {
    const video = await generateScript(user.id, id);
    return json({ video, props: (await introsFor([id])).get(id) ?? null });
  } catch (error) {
    return videoFailure(error);
  }
}
