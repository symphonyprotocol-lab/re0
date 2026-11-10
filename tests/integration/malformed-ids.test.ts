/**
 * Ids that are 36 characters of hex and hyphens but not UUIDs used to pass
 * the loose `/^[0-9a-f-]{36}$/` checks and reach a uuid column, where
 * Postgres refuses them and the route answers 500. They are "not found".
 */
import { TEST_DATABASE_URL } from './setup';
import { describe, expect, it } from 'vitest';
import { parseConversationQuery } from '@/lib/domain/conversation';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const MALFORMED = ['------------------------------------', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa-', '0123456789abcdef0123456789abcdef----'];
const someone = '6f1c3a52-6c55-4a8e-9d0e-2f6ad0c1a111';

suite('malformed ids', () => {
  it('are not found instead of a database error', async () => {
    const { liveConversation } = await import('@/lib/services/conversations');
    const { db } = await import('@/lib/infra/db');
    const { ownedRee } = await import('@/lib/services/rees');
    for (const id of MALFORMED) {
      expect(id).toHaveLength(36);
      expect(parseConversationQuery(new URLSearchParams({ ree: id })).ree).toBeNull();
      await expect(liveConversation(someone, id)).resolves.toBeNull();
      await expect(ownedRee(db(), someone, id)).resolves.toBeNull();
    }
  });
});
