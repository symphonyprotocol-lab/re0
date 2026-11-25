import { closeUnavailableRequests } from '@/lib/services/posts';
import { after, type NextRequest } from 'next/server';
import { parseVisitorAskSettings } from '@/lib/domain/visitor-ask';
import { isShareStyle, parseProductSheet } from '@/lib/domain/share-style';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { refreshProfile } from '@/lib/services/profile';
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
  const coverBlob = input.coverBlob;
  if (coverBlob !== undefined && coverBlob !== null && typeof coverBlob !== 'string') return fail('invalid_cover', 422);
  /* Visitor asks on the share page (lib/domain/visitor-ask.ts): left as they are when not sent. */
  const visitorAskSettings = input.visitorAskSettings === undefined ? undefined : parseVisitorAskSettings(input.visitorAskSettings);
  if (typeof visitorAskSettings === 'string') return fail(visitorAskSettings, 422);
  /* The share page's style and product sheet (lib/domain/share-style.ts): each left as it is when not sent. */
  if (input.shareStyle !== undefined && !isShareStyle(input.shareStyle)) return fail('share_style', 422);
  const productSheet = input.productSheet === undefined ? undefined : parseProductSheet(input.productSheet);
  if (typeof productSheet === 'string') return fail(productSheet, 422);
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
      coverBlob,
      publicQaEnabled: typeof input.publicQaEnabled === 'boolean' ? input.publicQaEnabled : undefined,
      answersPosts: typeof input.answersPosts === 'boolean' ? input.answersPosts : undefined,
      visitorAskSettings,
      shareStyle: isShareStyle(input.shareStyle) ? input.shareStyle : undefined,
      productSheet,
    });
    /* What the profile is made of may have changed: a public Ree's is rebuilt, free (2.4). */
    if (ree?.isPublished) after(() => refreshProfile(ree.id).catch(() => undefined));
    /* A paid Ree gone private, off posts or free closes the requests waiting on it, so their posts' fees settle now (2026-11-19). */
    if (ree) after(() => closeUnavailableRequests(ree.id).then(() => undefined, () => undefined));
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
  const id = (await context.params).id;
  if (!(await deleteRee(user.id, id))) return fail('not_found', 404);
  after(() => closeUnavailableRequests(id).then(() => undefined, () => undefined));
  return json({ deleted: true });
}
