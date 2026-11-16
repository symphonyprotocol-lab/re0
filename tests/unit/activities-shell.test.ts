import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/client';
import { messages } from '@/i18n';
import type { ActivityState } from '@/lib/domain/invites';

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT ${url}`);
});
vi.mock('next/navigation', () => ({
  redirect: (url: string) => redirect(url),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, back: () => undefined, refresh: () => undefined, prefetch: () => undefined }),
  usePathname: () => '/rees',
  useSearchParams: () => new URLSearchParams(),
}));

const state = vi.hoisted(() => ({ value: { visible: true, claimable: true, dot: true } as ActivityState }));
const invitePanel = vi.fn();
vi.mock('@/lib/http/session', () => ({ currentUser: async () => ({ id: 'user-1' }) }));
vi.mock('@/i18n/server', async () => {
  const { messages: all } = await import('@/i18n');
  return { serverMessages: async () => ({ t: all('zh'), locale: 'zh' }) };
});
vi.mock('@/lib/services/task-rewards', () => ({
  activities: async () => ({ tasks: [{ key: 'signup', done: true, credits: 1 }], checkIn: { state: 'done_today' }, state: state.value }),
}));
vi.mock('@/lib/services/invites', () => ({
  invitePanel: (...args: unknown[]) => {
    invitePanel(...args);
    return { code: 'ABCDEFGH', state: 'open', inviteCredits: 5_000, withdrawableOpen: true, withdrawableQuota: 1_000, ownWithdrawable: 0, ownCap: 20 };
  },
}));
vi.mock('@/lib/http/cookies', () => ({ appBaseUrl: () => 'https://re0.ai' }));

const { default: ActivitiesPage } = await import('@/app/(product)/(workspace)/activities/page');
const { AppShell } = await import('@/components/shell/app-shell');

beforeEach(() => {
  redirect.mockClear();
  invitePanel.mockClear();
});

describe('/activities', () => {
  it('redirects to My Rees when no activity is available, before reading anything else', async () => {
    state.value = { visible: false, claimable: false, dot: false };
    await expect(ActivitiesPage()).rejects.toThrow('NEXT_REDIRECT /rees');
    expect(invitePanel).not.toHaveBeenCalled();
  });

  it('renders while one is available, even with nothing to claim today', async () => {
    state.value = { visible: true, claimable: false, dot: false };
    await expect(ActivitiesPage()).resolves.toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
    expect(invitePanel).toHaveBeenCalledOnce();
  });
});

const plan = { active: false, cancelAtPeriodEnd: false, warn: false, used: 0, allowance: 0, remaining: 0, percent: 0 };
const shell = (activities: { visible: boolean; dot: boolean }) =>
  renderToStaticMarkup(
    createElement(I18nProvider, {
      locale: 'zh',
      t: messages('zh'),
      children: createElement(AppShell, {
        user: { name: 'User', avatar: null, balance: 0, welcome: 0, debt: 0, plan: plan as never, reeCount: 0, history: [], unreadNotices: 0, activities },
        initialCollapsed: false,
        children: null,
      }),
    }),
  );

describe('the 活动 navigation item', () => {
  it('is absent when nothing is available, present without a dot, or present with one', () => {
    const none = shell({ visible: false, dot: false });
    expect(none).not.toContain('/activities');
    expect(none).not.toContain('nav-dot');
    /* A dot is never shown for an item that is not there. */
    expect(shell({ visible: false, dot: true })).not.toContain('nav-dot');

    const quiet = shell({ visible: true, dot: false });
    expect(quiet).toContain('href="/activities"');
    expect(quiet).toContain('aria-label="活动"');
    expect(quiet).not.toContain('nav-dot');

    const dot = shell({ visible: true, dot: true });
    expect(dot).toContain('aria-label="活动 · 有可领取的奖励"');
    expect(dot).toContain('nav-dot');
  });
});
