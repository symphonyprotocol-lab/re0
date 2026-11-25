import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { filesFailure, filesScope } from '@/lib/http/files';
import { isUuid } from '@/lib/domain/list';
import { bindPaths, decideAwaiting, moveReeToWorkspace, updateBinding } from '@/lib/services/workspace-rees';

/**
 * A Ree's workspace sources, its owner on the web: `{action}` one of
 * `bind` (`path`, `exclude?`), `auto` (`bindingId`, `value`), `unbind`
 * (`bindingId`), `confirm` / `dismiss` (`ids`: files waiting, 待确认) and
 * `move` (移到工作区: its pasted text into the workspace, nothing charged).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const scope = await filesScope(request, 'write');
  if (scope instanceof Response) return scope;
  const { id } = await params;
  if (!isUuid(id)) return fail('not_found', 404);
  const input = await body(request);
  const ids = Array.isArray(input.ids) ? input.ids.filter((value): value is string => typeof value === 'string').slice(0, 500) : [];
  try {
    switch (input.action) {
      case 'bind':
        return json(await bindPaths(scope, id, { add: [String(input.path ?? '')], exclude: input.exclude }));
      case 'auto':
        await updateBinding(scope.userId, id, String(input.bindingId ?? ''), { autoEnable: input.value === true });
        return json({ ok: true });
      case 'unbind':
        await updateBinding(scope.userId, id, String(input.bindingId ?? ''), { remove: true });
        return json({ ok: true });
      case 'confirm':
      case 'dismiss':
        return json(await decideAwaiting(scope.userId, id, ids, input.action));
      case 'move':
        return json(await moveReeToWorkspace(scope.userId, id));
      default:
        return fail('invalid_action', 422);
    }
  } catch (error) {
    return filesFailure(error);
  }
}
