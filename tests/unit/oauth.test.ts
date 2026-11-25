import { describe, expect, it } from 'vitest';
import {
  basicCredentials,
  canonicalResource,
  documentLifetimeSeconds,
  isAllowedRedirectUri,
  isCodeChallenge,
  isCodeVerifier,
  isLoopbackRedirect,
  isMetadataDocumentUrl,
  parseClientMetadata,
  parsePermissions,
  redirectLabel,
  scopeOf,
  suggestedPermissions,
} from '@/lib/domain/oauth';
import { normalizePath } from '@/lib/domain/workspace';

describe('OAuth rules (lib/domain/oauth.ts)', () => {
  it('allows HTTPS, loopback HTTP and reverse-domain app schemes as redirect URIs, nothing else', () => {
    for (const ok of ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:33418/cb', 'http://127.0.0.1/cb', 'http://[::1]:8080/cb', 'com.example.app:/oauth', 'cursor.anysphere://cb']) expect(isAllowedRedirectUri(ok), ok).toBe(true);
    for (const bad of ['http://example.com/cb', 'https://a.test/cb#x', 'https://u:p@a.test/cb', 'javascript:alert(1)', 'data:text/html,x', 'file:///x', 'myapp://cb', '/relative', 'https://a.test/c b', '', 42]) {
      expect(isAllowedRedirectUri(bad), String(bad)).toBe(false);
    }
    expect(isLoopbackRedirect('http://127.0.0.1:4567/cb')).toBe(true);
    expect(isLoopbackRedirect('https://localhost/cb')).toBe(false);
    expect(redirectLabel('https://claude.ai/api/mcp/auth_callback')).toBe('claude.ai');
    expect(redirectLabel('com.example.app:/oauth')).toBe('com.example.app://');
  });

  it('takes a metadata document URL only as HTTPS with a path', () => {
    expect(isMetadataDocumentUrl('https://claude.ai/oauth/client.json')).toBe(true);
    for (const bad of ['http://claude.ai/c.json', 'https://claude.ai/', 'https://claude.ai', 'https://a.test/../c.json', 'https://a.test:8443/c.json', 'https://a.test/c.json#f', 'https://u@a.test/c.json', 're0_client_abc']) {
      expect(isMetadataDocumentUrl(bad), bad).toBe(false);
    }
  });

  it('checks PKCE syntax and compares resources canonically', () => {
    expect(isCodeVerifier('a'.repeat(43))).toBe(true);
    expect(isCodeVerifier('a'.repeat(42))).toBe(false);
    expect(isCodeVerifier('a'.repeat(129))).toBe(false);
    expect(isCodeChallenge('A'.repeat(43))).toBe(true);
    expect(isCodeChallenge('A'.repeat(44))).toBe(false);
    expect(canonicalResource('HTTPS://RE0.io/api/mcp/')).toBe('https://re0.io/api/mcp');
    expect(canonicalResource('https://re0.io/api/mcp#x')).toBeNull();
    expect(canonicalResource('re0.io/api/mcp')).toBeNull();
  });

  it('reads permissions as scopes and back', () => {
    expect(scopeOf({ canWrite: false, workspaceAccess: 'none', workspaceOnly: false, workspaceRoot: '/' })).toBe('read');
    expect(scopeOf({ canWrite: true, workspaceAccess: 'write', workspaceOnly: false, workspaceRoot: '/' })).toBe('read write workspace:write');
    expect(scopeOf({ canWrite: false, workspaceAccess: 'read', workspaceOnly: true, workspaceRoot: '/a' })).toBe('workspace:read');
    expect(suggestedPermissions('')).toEqual({ canWrite: false, workspaceAccess: 'none', workspaceOnly: false, workspaceRoot: '/' });
    expect(suggestedPermissions('openid read write offline_access')).toMatchObject({ canWrite: true, workspaceAccess: 'none', workspaceOnly: false });
    expect(suggestedPermissions('workspace:write')).toMatchObject({ canWrite: false, workspaceAccess: 'write', workspaceOnly: true });
    expect(parsePermissions({}, normalizePath)).toEqual({ canWrite: false, workspaceAccess: 'none', workspaceOnly: false, workspaceRoot: '/' });
    expect(parsePermissions({ workspaceOnly: true, workspaceAccess: 'none' }, normalizePath)).toBeNull();
    expect(parsePermissions({ workspaceAccess: 'admin' }, normalizePath)).toBeNull();
    expect(parsePermissions({ workspaceOnly: true, workspaceAccess: 'write', canWrite: true, workspaceRoot: '/notes' }, normalizePath)).toEqual({ canWrite: false, workspaceAccess: 'write', workspaceOnly: true, workspaceRoot: '/notes' });
  });

  it('parses client metadata with the right default authentication', () => {
    expect(parseClientMetadata({ redirect_uris: ['https://a.test/cb'] }, 'registration')).toMatchObject({ clientName: 'a.test', tokenEndpointAuthMethod: 'client_secret_basic' });
    expect(parseClientMetadata({ redirect_uris: ['https://a.test/cb'], client_name: '  My\u0000 App  ' }, 'document')).toMatchObject({ clientName: 'My App', tokenEndpointAuthMethod: 'none' });
    expect(() => parseClientMetadata({ redirect_uris: ['https://a.test/cb'], token_endpoint_auth_method: 'client_secret_post' }, 'document')).toThrow();
    expect(() => parseClientMetadata({ redirect_uris: 'https://a.test/cb' }, 'registration')).toThrow();
    expect(parseClientMetadata({ redirect_uris: ['https://a.test/cb'], client_uri: 'javascript:x' }, 'registration').clientUri).toBeNull();
  });

  it('reads Basic client credentials and document cache lifetimes', () => {
    expect(basicCredentials(`Basic ${btoa('re0_client_x:s%3Acret')}`)).toEqual({ clientId: 're0_client_x', secret: 's:cret' });
    expect(basicCredentials('Bearer x')).toBeNull();
    expect(documentLifetimeSeconds(null)).toBe(3600);
    expect(documentLifetimeSeconds('max-age=60')).toBe(300);
    expect(documentLifetimeSeconds('public, max-age=600')).toBe(600);
    expect(documentLifetimeSeconds('max-age=999999')).toBe(86400);
    expect(documentLifetimeSeconds('no-store')).toBe(300);
  });
});
