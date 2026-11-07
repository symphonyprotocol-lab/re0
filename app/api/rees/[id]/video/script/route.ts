import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { VIDEO_TEMPLATES, type VideoTemplate } from '@/lib/constants';
import { apiUser } from '@/lib/http/session';
import { videoFailure } from '@/lib/http/video';
import { generateScript, introsFor } from '@/lib/services/video';

/* One live answer and up to three generation calls. */
export const maxDuration = 120;

/**
 * Generates or regenerates the four-shot script (rebuild-proposal.md 2.6):
 * Script and any voiceover credits are reserved, then settled or refunded. Refused
 * without a ready source (409 `no_ready_source`).
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const id = (await context.params).id;
  const { template, revision, maxCost } = await body(request);
  if (template !== undefined && !VIDEO_TEMPLATES.includes(template as VideoTemplate)) return fail('invalid_template', 422);
  if (revision !== undefined && (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)) return fail('invalid_revision', 422);
  if (maxCost !== undefined && (typeof maxCost !== 'number' || !Number.isSafeInteger(maxCost) || maxCost < 0)) return fail('invalid_price', 422);
  try {
    const { generationCost, ...video } = await generateScript(user.id, id, undefined, { template: template as VideoTemplate | undefined, revision, maxCost });
    return json({ video, cost: generationCost, props: (await introsFor([id])).get(id) ?? null });
  } catch (error) {
    return videoFailure(error);
  }
}
