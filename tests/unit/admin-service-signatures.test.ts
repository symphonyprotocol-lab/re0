import { describe, expect, it } from 'vitest';

/**
 * Compile-time guard, checked by `npm run typecheck`: the console's read
 * services cannot be called without the administrator a session check
 * returned. Each `@ts-expect-error` fails the typecheck if that parameter is
 * ever dropped. The calls never run.
 */
describe('console read services take the administrator', () => {
  it('rejects calls without one at compile time', async () => {
    const never = false as boolean;
    if (never) {
      const audit = await import('@/lib/services/admin-audit');
      const rees = await import('@/lib/services/admin-rees');
      const purchases = await import('@/lib/services/admin-purchases');
      const redeem = await import('@/lib/services/admin-redeem');
      const overview = await import('@/lib/services/admin-overview');
      const administrators = await import('@/lib/services/admin-administrators');
      const funding = await import('@/lib/services/payout-funding');
      const invites = await import('@/lib/services/invites');
      // @ts-expect-error the administrator is required
      await audit.auditEntry('id');
      // @ts-expect-error the administrator is required
      await rees.adminRee('id');
      // @ts-expect-error the administrator is required
      await purchases.purchaseDetail('id');
      // @ts-expect-error the administrator is required
      await redeem.getBatch('id');
      // @ts-expect-error the administrator is required
      await overview.adminOverview();
      // @ts-expect-error the administrator is required
      await administrators.listAdministrators();
      // @ts-expect-error the administrator is required
      await funding.payoutFunding('id', 'owner');
      // @ts-expect-error the administrator is required
      await funding.payoutFundingLines(['id']);
      // @ts-expect-error the administrator is required
      await invites.inviteOverview();
    }
    expect(never).toBe(false);
  });
});
