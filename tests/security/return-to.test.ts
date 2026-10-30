import { describe, expect, it } from 'vitest';
import { DEFAULT_RETURN_TO, safeReturnTo } from '@/lib/domain/auth';

/**
 * The post-login redirect is the classic open-redirect surface: whatever gets
 * through here is where a user lands with a fresh session cookie.
 * architecture.md 15.3 requires a strict return URL.
 */
describe('safeReturnTo', () => {
  it('keeps allowed in-app paths, including query and hash', () => {
    expect(safeReturnTo('/dashboard')).toBe('/dashboard');
    expect(safeReturnTo('/dashboard/api-keys')).toBe('/dashboard/api-keys');
    expect(safeReturnTo('/channels?sort=recent')).toBe('/channels?sort=recent');
    expect(safeReturnTo('/assets/claim?asset=%2Fwebsites%2Fx')).toBe('/assets/claim?asset=%2Fwebsites%2Fx');
    expect(safeReturnTo('/u/alice')).toBe('/u/alice');
    /* Retired in P1, with no redirects (agent-first-proposal.md 3.5). */
    expect(safeReturnTo('/libraries?q=next')).toBe('/dashboard');
    expect(safeReturnTo('/playground#top')).toBe('/playground#top');
  });

  it('refuses anything that can leave the origin', () => {
    for (const hostile of [
      'https://evil.example/steal',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      '/dashboard\\@evil.example',
      '/dashboard\nLocation: https://evil.example',
    ]) {
      expect(safeReturnTo(hostile)).toBe(DEFAULT_RETURN_TO);
    }
  });

  it('refuses paths outside the allow list', () => {
    expect(safeReturnTo('/admin/overview')).toBe(DEFAULT_RETURN_TO);
    expect(safeReturnTo('/api/auth/logout')).toBe(DEFAULT_RETURN_TO);
    // A prefix must match a whole segment, not a string prefix.
    expect(safeReturnTo('/dashboardevil')).toBe(DEFAULT_RETURN_TO);
  });

  it('falls back for missing, oversized or non-string input', () => {
    expect(safeReturnTo(undefined)).toBe(DEFAULT_RETURN_TO);
    expect(safeReturnTo(['/dashboard'])).toBe(DEFAULT_RETURN_TO);
    expect(safeReturnTo(`/dashboard/${'a'.repeat(600)}`)).toBe(DEFAULT_RETURN_TO);
  });
});
