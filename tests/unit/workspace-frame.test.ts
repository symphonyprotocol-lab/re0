/**
 * The signed-in frame loads only what its navigation shows (review
 * 2026-11-18, #159 item 3): the sidebar no longer lists conversations, so
 * no request pays for the history query.
 */
import { describe, expect, it, vi } from 'vitest';

const sidebarHistory = vi.fn(async () => []);
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/lib/services/conversations', () => ({ sidebarHistory }));
vi.mock('@/lib/services/billing', () => ({ shellBilling: async () => ({ balance: 0, welcome: 0, debt: 0, plan: null }) }));
vi.mock('@/lib/services/notices', () => ({ unreadNotices: async () => 0 }));
vi.mock('@/lib/services/rees', () => ({ reeCount: async () => 0 }));
vi.mock('@/lib/services/task-rewards', () => ({ activitiesIndicator: async () => ({ visible: false, dot: false }) }));
vi.mock('@/components/shell/app-shell', () => ({ AppShell: () => null }));

const { WorkspaceFrame } = await import('@/components/shell/workspace-frame');

describe('workspace frame', () => {
  it('does not query the conversation history', async () => {
    await WorkspaceFrame({ user: { id: 'u', name: 'U', avatarBlob: null } as never, children: null });
    expect(sidebarHistory).not.toHaveBeenCalled();
  });
});
