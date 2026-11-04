import { modelFor } from '@/lib/infra/ai/models';
import { db } from '@/lib/infra/db';
import { hasActivePlan } from '@/lib/services/billing';
import type { CallPurpose } from '@/lib/domain/model-calls';

/** Resolve membership for each operation so an expired Plan immediately uses Free. */
export async function generationForUser(userId: string, purpose: CallPurpose = 'other') {
  return modelFor('generation', await hasActivePlan(db(), userId) ? 'plan' : 'free', { userId, purpose });
}
