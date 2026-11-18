import { redirect } from 'next/navigation';

/** `/chats` is now 我的帖子 (`/me/posts`, v5): old links and bookmarks, with their search, tab and selection, go there. */
export default async function ChatsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, one);
  }
  redirect(params.size ? `/me/posts?${params}` : '/me/posts');
}
