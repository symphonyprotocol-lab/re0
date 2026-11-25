import type { NextRequest } from 'next/server';
import { body, json } from '@/lib/http/respond';
import { filesFailure, filesScope } from '@/lib/http/files';
import { createReeFromFolder } from '@/lib/services/workspace-rees';

/** `{path, name, category, description?, exclude?, maxCost?}` → a new private Ree bound to the folder, as `create_ree_from_folder` makes it. */
export async function POST(request: NextRequest) {
  const scope = await filesScope(request, 'write');
  if (scope instanceof Response) return scope;
  const input = await body(request);
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  try {
    const made = await createReeFromFolder(scope, {
      path: String(input.path ?? ''),
      name: text(input.name),
      category: text(input.category) as never,
      description: text(input.description),
      exclude: input.exclude,
      maxCost: typeof input.maxCost === 'number' ? input.maxCost : undefined,
    });
    return json({ reeId: made.ree.id, estimate: made.estimate }, 201);
  } catch (error) {
    return filesFailure(error);
  }
}
