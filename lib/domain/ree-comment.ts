export const REE_COMMENT_MAX_LENGTH = 500;
export const REE_COMMENTS_ANCHOR = 'comments';

export interface ReeComment {
  id: string;
  authorName: string;
  authorAvatar: string | null;
  content: string;
  createdAt: string;
}

export interface ReeCommentPage {
  items: ReeComment[];
  total: number;
  next: string | null;
}

export function reeCommentContent(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const content = value.trim();
  // PostgreSQL text cannot store NUL, and invalid Unicode would not round-trip.
  return content && content.length <= REE_COMMENT_MAX_LENGTH && !/[\u0000\uD800-\uDFFF]/u.test(content) ? content : null;
}
