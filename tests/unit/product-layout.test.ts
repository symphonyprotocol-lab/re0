import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import ProductLayout from '@/app/(product)/layout';
import WorkspaceLayout from '@/app/(product)/(workspace)/layout';
import { currentUser } from '@/lib/http/session';
import type { SessionUser } from '@/lib/services/auth';
import { PATH_HEADER } from '@/lib/http/cookies';

vi.mock('@/lib/http/session', () => ({ currentUser: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn((url: string) => { throw new Error(`redirect:${url}`); }) }));
vi.mock('@/components/shell/workspace-frame', () => ({ WorkspaceFrame: ({ children }: { children: React.ReactNode }) => createElement('div', { 'data-shell': 'workspace' }, children) }));
vi.mock('@/components/site/site-shell', () => ({ SiteShell: ({ children }: { children: React.ReactNode }) => createElement('div', { 'data-shell': 'site' }, children) }));

beforeEach(() => vi.clearAllMocks());

describe('shared product layout and private route access', () => {
  it('renders one workspace shell around signed-in private pages', async () => {
    vi.mocked(currentUser).mockResolvedValue({ id: 'signed-in-user' } as SessionUser);
    const children = createElement('p', null, 'Private page');
    const content = await WorkspaceLayout({ children });
    expect(content).toBe(children);
    const html = renderToStaticMarkup(await ProductLayout({ children: content }));
    expect(html.match(/data-shell="workspace"/g)).toHaveLength(1);
    expect(html).toContain('Private page');
  });

  it('uses that same workspace shell for signed-in discovery pages', async () => {
    vi.mocked(currentUser).mockResolvedValue({ id: 'signed-in-user' } as SessionUser);
    const html = renderToStaticMarkup(await ProductLayout({ children: createElement('p', null, 'Discovery page') }));
    expect(html).toContain('data-shell="workspace"');
    expect(html).not.toContain('data-shell="site"');
  });

  it('keeps discovery open to visitors in the public site shell', async () => {
    vi.mocked(currentUser).mockResolvedValue(null);
    const html = renderToStaticMarkup(await ProductLayout({ children: createElement('p', null, 'Public Ree') }));
    expect(html).toContain('data-shell="site"');
    expect(html).toContain('Public Ree');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('still redirects an expired session on a private route back through sign-in', async () => {
    vi.mocked(currentUser).mockResolvedValue(null);
    vi.mocked(headers).mockResolvedValue(new Headers({ [PATH_HEADER]: '/rees?view=all' }) as Awaited<ReturnType<typeof headers>>);
    await expect(WorkspaceLayout({ children: 'Private page' })).rejects.toThrow('redirect:/login?returnTo=%2Frees%3Fview%3Dall');
  });
});
