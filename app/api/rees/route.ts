import { after, type NextRequest } from 'next/server';
import { REE_PAGE_SIZES } from '@/lib/constants';
import { InsufficientCredits } from '@/lib/domain/credits';
import { parseList } from '@/lib/domain/list';
import { fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { KnowledgeInputError, processKnowledge } from '@/lib/services/knowledge';
import { createReeFromDraft, listRees, reeSelection, REE_SORTS, REE_VISIBILITIES, ReeInputError } from '@/lib/services/rees';

export const maxDuration = 300;

/**
 * `?q&status=all|public|private&sort&size=12|24|48&page` → `{items, total, page, size}`;
 * with `select=1`, every matching Ree's id, name and visibility (`{items}`), for "选中全部结果".
 */
export async function GET(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const params = request.nextUrl.searchParams;
  const query = parseList(params, { statuses: REE_VISIBILITIES, sorts: REE_SORTS, sizes: REE_PAGE_SIZES });
  if (params.get('select') === '1') return json({ items: await reeSelection(user.id, { q: query.q, visibility: query.status }) });
  return json(await listRees(user.id, { ...query, visibility: query.status }));
}

/** The wizard's final step: creates the Ree (and its first source) from the saved draft. */
export async function POST(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  try {
    const { ree, knowledgeId } = await createReeFromDraft(user.id);
    if (knowledgeId) after(() => processKnowledge(knowledgeId));
    return json({ id: ree.id, knowledgeId }, 201);
  } catch (error) {
    if (error instanceof ReeInputError) return fail(error.field, 422, { step: error.step });
    if (error instanceof KnowledgeInputError) return fail(error.code, 422, { step: 3 });
    if (error instanceof InsufficientCredits) return fail('insufficient_credits', 402, { needed: error.needed, balance: error.available });
    throw error;
  }
}
