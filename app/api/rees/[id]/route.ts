import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { deleteRee, ownedRee, ReeInputError, updateRee } from '@/lib/services/rees';

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const ree = await ownedRee(db(), user.id, (await context.params).id);
  return ree ? json({ ree }) : fail('not_found', 404);
}

/** Settings: identity, knowledge & personality, publishing & pricing, validated as one form. */
export async function PATCH(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const input = await body(request);
  try {
    const ree = await updateRee(user.id, (await context.params).id, {
      name: String(input.name ?? ''),
      description: String(input.description ?? ''),
      category: input.category,
      tags: Array.isArray(input.tags) ? input.tags : [],
      systemPrompt: String(input.systemPrompt ?? ''),
      sampleQuestions: Array.isArray(input.sampleQuestions) ? input.sampleQuestions.map(String) : String(input.sampleQuestions ?? ''),
      queryFee: input.queryFee,
      isPublic: input.isPublic === true,
      color: input.color,
      avatarBlob: typeof input.avatarBlob === 'string' ? input.avatarBlob : null,
    });
    return ree ? json({ ree }) : fail('not_found', 404);
  } catch (error) {
    if (error instanceof ReeInputError) return fail(error.field, 422);
    throw error;
  }
}

/** Soft delete. */
export async function DELETE(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  return (await deleteRee(user.id, (await context.params).id)) ? json({ deleted: true }) : fail('not_found', 404);
}
