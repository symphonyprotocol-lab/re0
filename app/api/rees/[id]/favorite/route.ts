import { isUuid } from '@/lib/domain/list';
import { fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { setReeFavorite } from '@/lib/services/ree-favorites';

async function write(request: Request, { params }: { params: Promise<{ id: string }> }, favorite: boolean) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { id } = await params;
  if (!isUuid(id) || !(await setReeFavorite(user.id, id, favorite))) return fail('not_found', 404);
  return json({ favorite });
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  return write(request, context, true);
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return write(request, context, false);
}
