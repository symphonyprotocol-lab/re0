import { redirect } from 'next/navigation';

/** `/chats` is retired (2026-11-20): private questions are private posts, listed under 我的帖子's 私密. */
export default function ChatsPage() {
  redirect('/me/posts?tab=private');
}
