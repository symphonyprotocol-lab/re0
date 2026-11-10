import { describe, expect, it } from 'vitest';
import type { NextConfig } from 'next';
// @ts-expect-error -- next.config.mjs is plain JavaScript without a declaration file.
import rawConfig from '@/next.config.mjs';

const config = rawConfig as NextConfig;

describe('security response headers', () => {
  it('sends the hardening headers on every route, CSP enforced for framing and report-only in full', async () => {
    const rules = await config.headers!();
    const all = rules.find((rule) => rule.source === '/:path*');
    const headers = Object.fromEntries((all?.headers ?? []).map(({ key, value }) => [key.toLowerCase(), value]));
    expect(headers['strict-transport-security']).toMatch(/max-age=\d{8,}/);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['content-security-policy']).toContain("object-src 'none'");
    expect(headers['content-security-policy']).toContain("img-src 'self' data: blob: https:");
    expect(headers['permissions-policy']).toContain('camera=()');
    /* Nothing that Paddle checkout or the in-browser video export depends on is enforced before a browser check. */
    for (const source of ['script-src', 'style-src', 'font-src', 'media-src', 'worker-src', 'connect-src', 'frame-src', 'default-src', 'form-action']) {
      expect(headers['content-security-policy']).not.toContain(source);
    }
    const report = headers['content-security-policy-report-only']!;
    for (const directive of ["default-src 'self'", 'https://cdn.paddle.com', 'frame-src https://*.paddle.com', "worker-src 'self' blob:"]) expect(report).toContain(directive);
  });
});
