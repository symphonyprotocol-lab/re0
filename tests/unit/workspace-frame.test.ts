/**
 * The signed-in frame loads only what its navigation shows (review
 * 2026-11-18, #159 item 3): the sidebar lists no conversations -- they are
 * gone (migration 0070) -- so the frame reads nothing but its counters.
 */
import { describe, expect, it, vi } from 'vitest';

const shellBilling = vi.fn(async () => ({ balance: 0, welcome: 0, debt: 0, plan: null }));
const unreadNotices = vi.fn(async () => 0);
const reeCount = vi.fn(async () => 0);
const activitiesIndicator = vi.fn(async () => ({ visible: false, dot: false }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/lib/services/billing', () => ({ shellBilling }));
vi.mock('@/lib/services/notices', () => ({ unreadNotices }));
vi.mock('@/lib/services/rees', () => ({ reeCount }));
vi.mock('@/lib/services/task-rewards', () => ({ activitiesIndicator }));
vi.mock('@/components/shell/app-shell', () => ({ AppShell: () => null }));

const { WorkspaceFrame } = await import('@/components/shell/workspace-frame');

describe('workspace frame', () => {
  it('reads only the counters its navigation shows', async () => {
    await WorkspaceFrame({ user: { id: 'u', name: 'U', avatarBlob: null } as never, children: null });
    expect(shellBilling).toHaveBeenCalledTimes(1);
    expect(unreadNotices).toHaveBeenCalledTimes(1);
    expect(reeCount).toHaveBeenCalledTimes(1);
    expect(activitiesIndicator).toHaveBeenCalledTimes(1);
  });
});
