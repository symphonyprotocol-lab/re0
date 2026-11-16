import { json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { dismissTaskGuide } from '@/lib/services/task-rewards';

/** "不再显示" on the starter task guide: hides it for this account for good. */
export async function DELETE(request: Request) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  await dismissTaskGuide(user.id);
  return json({ ok: true });
}
