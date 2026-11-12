import { modelFor } from '@/lib/infra/ai/models';
import { db } from '@/lib/infra/db';
import { hasActivePlan } from '@/lib/services/billing';
import type { CallPurpose } from '@/lib/domain/model-calls';

/**
 * Resolve membership for each operation so an expired Plan immediately uses
 * Free. A signed-out visitor (`null`, anonymous chat) always uses Free and
 * its calls are logged without a user.
 */
export async function generationForUser(userId: string | null, purpose: CallPurpose = 'other') {
  if (!userId) return modelFor('generation', 'free', { purpose });
  return modelFor('generation', await hasActivePlan(db(), userId) ? 'plan' : 'free', { userId, purpose });
}
