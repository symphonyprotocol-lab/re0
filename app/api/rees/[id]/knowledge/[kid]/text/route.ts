import type { NextRequest } from 'next/server';
import { fail } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { knowledgeText } from '@/lib/services/knowledge';
import { ownedRee } from '@/lib/services/rees';

/** "下载解析文本": the extracted text as a UTF-8 .txt attachment. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string; kid: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { id, kid } = await context.params;
  const ree = await ownedRee(db(), user.id, id);
  if (!ree) return fail('not_found', 404);
  const text = await knowledgeText(ree.id, kid);
  if (!text) return fail('not_found', 404);
  const name = `${text.title.replace(/\.[^./]+$/, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'knowledge'}.txt`;
  return new Response(text.content, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="knowledge.txt"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
