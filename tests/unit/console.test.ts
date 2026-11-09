import { describe, expect, it } from 'vitest';
import { actionsLabelled } from '@/lib/domain/audit';
import { parseModelConfig } from '@/lib/domain/models';
import { adminLoginHref, safeAdminNext } from '@/lib/http/admin-next';
import { en as consoleEn, zh as consoleZh } from '@/i18n/pages/console';

describe('console sign-in return path', () => {
  it('returns only to console pages other than the sign-in page', () => {
    expect(safeAdminNext('/admin/users/abc?tab=kyc&from=%2Fadmin%2Fkyc')).toBe('/admin/users/abc?tab=kyc&from=%2Fadmin%2Fkyc');
    expect(safeAdminNext('/admin/overview')).toBe('/admin/overview');
    expect(safeAdminNext('/admin/login')).toBeNull();
    expect(safeAdminNext('/admin/login?next=/admin/users')).toBeNull();
    expect(safeAdminNext('/admin')).toBeNull();
    expect(safeAdminNext('/dashboard')).toBeNull();
    expect(safeAdminNext('https://evil.example/admin/users')).toBeNull();
    expect(safeAdminNext('//evil.example/admin/users')).toBeNull();
    expect(safeAdminNext('/admin//evil.example')).toBeNull();
    expect(safeAdminNext('/admin/\\evil.example')).toBeNull();
    expect(safeAdminNext('/admin/users\n')).toBeNull();
    expect(safeAdminNext(['/admin/users'])).toBeNull();
    expect(safeAdminNext('')).toBeNull();
  });

  it('builds the signed-out redirect', () => {
    expect(adminLoginHref('/admin/rees?status=public')).toBe('/admin/login?next=%2Fadmin%2Frees%3Fstatus%3Dpublic');
    expect(adminLoginHref('/admin/login')).toBe('/admin/login');
    expect(adminLoginHref('')).toBe('/admin/login');
  });
});

describe('model entry limits (prototype suite.js model form)', () => {
  const entry = { name: 'g', kind: 'generation', transport: 'gateway', model: 'openai/gpt-5-mini' };
  it('caps the name at 50 and the model id at 120 characters', () => {
    expect(parseModelConfig({ ...entry, name: 'n'.repeat(50) })).toMatchObject({ name: 'n'.repeat(50) });
    expect(parseModelConfig({ ...entry, name: 'n'.repeat(51) })).toEqual({ error: 'name' });
    expect(parseModelConfig({ ...entry, model: `a/${'m'.repeat(118)}` })).toMatchObject({ model: `a/${'m'.repeat(118)}` });
    expect(parseModelConfig({ ...entry, model: `a/${'m'.repeat(119)}` })).toEqual({ error: 'model' });
  });

  it('takes timeouts of 5 to 300 seconds', () => {
    expect(parseModelConfig({ ...entry, timeoutMs: 4_999 })).toEqual({ error: 'timeout' });
    expect(parseModelConfig({ ...entry, timeoutMs: 5_000 })).toMatchObject({ timeoutMs: 5_000 });
    expect(parseModelConfig({ ...entry, timeoutMs: 300_000 })).toMatchObject({ timeoutMs: 300_000 });
    expect(parseModelConfig({ ...entry, timeoutMs: 600_000 })).toEqual({ error: 'timeout' });
  });
});

describe('audit search by action label', () => {
  const labels = [consoleZh.actions, consoleEn.actions];
  it('maps either language to the codes', () => {
    expect(actionsLabelled('下架', labels)).toEqual(['ree.takedown']);
    expect(actionsLabelled('Take down', labels)).toEqual(['ree.takedown']);
    expect(actionsLabelled('提现', labels)).toEqual(['payout.approved', 'payout.rejected']);
    expect(actionsLabelled('  ', labels)).toEqual([]);
    expect(actionsLabelled('nothing like this', labels)).toEqual([]);
  });
});
