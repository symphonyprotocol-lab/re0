import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { PaddleError, PaddleNotConfigured } from '@/lib/infra/paddle';
import { AdminInputError } from '@/lib/services/admin';
import { saveWelcomeCredits, welcomeCredits } from '@/lib/services/signup-reward';
import { currentPricing, savePricing } from '@/lib/services/pricing';
import { saveVideoExportPrice, saveVideoScriptPrice, videoExportPrice, videoScriptPrice } from '@/lib/services/video-pricing';

export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const [prices, welcome, videoScript, videoExport] = await Promise.all([currentPricing(), welcomeCredits(), videoScriptPrice(), videoExportPrice()]);
  return json({ ...prices, welcome, videoScript, videoExport });
}
export async function PUT(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const input = await body(request);
  try {
    if (input.kind === 'welcome') return json({ welcome: await saveWelcomeCredits(administrator.id, input) });
    if (input.kind === 'video_script') return json({ videoScript: await saveVideoScriptPrice(administrator.id, input) });
    if (input.kind === 'video_export') return json({ videoExport: await saveVideoExportPrice(administrator.id, input) });
    if (input.kind !== 'plan' && input.kind !== 'pack') return fail('invalid_kind', 422);
    return json({ price: await savePricing(administrator.id, input.kind, input) });
  } catch (error) {
    if (error instanceof AdminInputError) return fail(error.code, error.code === 'pricing_conflict' ? 409 : 422);
    if (error instanceof PaddleNotConfigured) return fail('payments_unavailable', 503);
    if (error instanceof PaddleError) return fail('payment_provider', 502);
    throw error;
  }
}
