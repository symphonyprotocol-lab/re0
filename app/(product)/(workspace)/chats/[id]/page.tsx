import { redirect } from 'next/navigation';

/**
 * `/chats/[id]`: one conversation, retired with the chat pages (2026-11-20).
 * Private questions are private posts now; old links land on 我的帖子's 私密.
 * The conversation itself is left alone until PR B removes the data.
 */
export default function ConversationPage() {
  redirect('/me/posts?tab=private');
}
