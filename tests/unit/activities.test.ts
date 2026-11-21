import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/client';
import { messages } from '@/i18n';
import { ACTIVITIES, activityState, newUserWindowEnd, openTasks, paidTask, STARTER_TASKS, TASK_HREF, type ActivityFacts, type ActivityState } from '@/lib/domain/invites';
import { INVITE_DEFAULTS } from '@/lib/constants';
import type { Activities } from '@/lib/services/task-rewards';
import type { CheckInStatus } from '@/lib/services/check-in';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, back: () => undefined, refresh: () => undefined, prefetch: () => undefined }),
  usePathname: () => '/activities',
}));

const { ActivitiesView } = await import('@/components/activities/activities-view');

const settings = { ...INVITE_DEFAULTS };
const off = { ...settings, firstReeCredits: 0, firstPostCredits: 0, firstHelpfulCredits: 0 };
const allPaid = ['first_ree', 'first_post', 'first_helpful'];

const createdAt = new Date('2026-08-16T04:00:00Z');
const windowEndsAt = newUserWindowEnd(createdAt, settings);
const inside = new Date('2026-10-01T00:00:00Z');
const state = (input: Partial<ActivityFacts> & Pick<ActivityFacts, 'checkIn'>) => activityState({ settings, paidTasks: [], now: inside, windowEndsAt, ...input });
const hidden: ActivityState = { visible: false, claimable: false, dot: false };

describe('which activities an account can take part in', () => {
  it('shows the page for a check-in still open, even one made today, and for an unpaid paying task at any age', () => {
    expect(windowEndsAt.toISOString()).toBe('2026-11-16T04:00:00.000Z');
    expect(ACTIVITIES.map((activity) => activity.key)).toEqual(['check_in', 'starter_tasks']);
    /* (c) something to claim now, inside the window: item and dot. */
    expect(state({ checkIn: 'available', settings: off })).toEqual({ visible: true, claimable: true, dot: true });
    expect(state({ checkIn: 'done_today' })).toEqual({ visible: true, claimable: true, dot: true });
    /* (b) checked in today, every task paid: the item stays (there is tomorrow), without a dot. */
    expect(state({ checkIn: 'done_today', paidTasks: allPaid })).toEqual({ visible: true, claimable: false, dot: false });
    expect(state({ checkIn: 'done_today', settings: off })).toEqual({ visible: true, claimable: false, dot: false });
  });

  it('hides it when the window is over, the days are used up or the rewards are off, and every task is paid or unpaid', () => {
    /* (a) nothing available: no item, no dot. */
    for (const checkIn of ['expired', 'finished', 'off'] as const) {
      expect(state({ checkIn, paidTasks: allPaid })).toEqual(hidden);
      expect(state({ checkIn, settings: off })).toEqual(hidden);
    }
    /* Everything off, then one reward turned back on: the page comes back by itself. */
    expect(state({ checkIn: 'off', settings: off })).toEqual(hidden);
    expect(state({ checkIn: 'off', settings: { ...off, firstHelpfulCredits: 1 }, paidTasks: ['first_ree'] })).toEqual({ visible: true, claimable: true, dot: true });
    expect(openTasks(settings, ['first_post'])).toEqual(['first_ree', 'first_helpful']);
  });

  it('counts a retired first question as the first post done, but a retired first comment as nothing', () => {
    expect(STARTER_TASKS).toEqual(['first_ree', 'first_post', 'first_helpful']);
    expect(openTasks(settings, ['first_question'])).toEqual(['first_ree', 'first_helpful']);
    expect(openTasks(settings, ['first_comment'])).toEqual(['first_ree', 'first_post', 'first_helpful']);
    expect(state({ checkIn: 'done_today', paidTasks: ['first_ree', 'first_question', 'first_helpful'] })).toEqual({ visible: true, claimable: false, dot: false });
    expect(state({ checkIn: 'done_today', paidTasks: ['first_ree', 'first_question', 'first_comment'] }).claimable).toBe(true);
    expect(paidTask('first_post', [{ task: 'first_question', credits: 1_000 }])).toEqual({ task: 'first_question', credits: 1_000 });
    expect(paidTask('first_helpful', [{ task: 'first_comment', credits: 1_000 }])).toBeUndefined();
    expect(TASK_HREF).toEqual({ first_ree: '/rees/new', first_post: '/?compose=public', first_helpful: '/' });
  });

  it('keeps an old account\'s unpaid task available and claimable, but stops it raising the dot at the end of the check-in window', () => {
    const justBefore = new Date(windowEndsAt.getTime() - 1);
    expect(state({ checkIn: 'done_today', paidTasks: ['first_ree'], now: justBefore }).dot).toBe(true);
    expect(state({ checkIn: 'expired', paidTasks: ['first_ree'], now: windowEndsAt })).toEqual({ visible: true, claimable: true, dot: false });
    expect(state({ checkIn: 'finished', now: new Date('2027-06-01T00:00:00Z') })).toEqual({ visible: true, claimable: true, dot: false });
    /* The window's length is the configured check-in window, not a constant. */
    expect(newUserWindowEnd(createdAt, { checkInWindowMonths: 1 }).toISOString()).toBe('2026-09-16T04:00:00.000Z');
  });
});

const checkIn = (state: CheckInStatus['state'], used = 3): CheckInStatus => ({ state, credits: state === 'off' ? 0 : 1_500, used, maxDays: 30, windowMonths: 3, windowEndsAt: new Date('2027-02-16T00:00:00Z') });
const invite = { credits: 5_000, link: 'https://re0.ai/login?invite=ABCDEFGH', copy: { withdrawableNote: true, progress: true, status: null }, ownWithdrawable: 2, ownCap: 20 } as const;
const render = (activities: Activities, locale: 'zh' | 'en' = 'zh', inviteSummary: Parameters<typeof ActivitiesView>[0]['invite'] = invite) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale, t: messages(locale), children: createElement(ActivitiesView, { activities, invite: inviteSummary }) }));

describe('the Activities page', () => {
  it('offers the check-in, the open tasks and the invite link to a new account', () => {
    const html = render({
      tasks: [
        { key: 'signup', done: true, credits: 10_000 },
        { key: 'first_ree', done: false, credits: 2_500 },
        { key: 'first_post', done: true, credits: 1_000 },
      ],
      checkIn: checkIn('available'),
      state: { visible: true, claimable: true, dot: true },
    });
    for (const text of ['活动', '每日打卡', '已打卡 3 / 30 天', '>打卡</button>', '新手任务', '已完成 2 / 3', '+2,500 credits', 'href="/rees/new"', '邀请朋友', 'login?invite=ABCDEFGH', '你的可提现邀请奖励：已用 2 / 20 位', 'href="/settings?tab=invite"'])
      expect(html).toContain(text);
    expect(html).not.toContain('今天能领的奖励都已领完');
    /* No dismiss: the page is permanent. */
    expect(html).not.toContain('不再显示');
  });

  it('says when everything for today is claimed, and explains each section that is over', () => {
    const tasks: Activities['tasks'] = [
      { key: 'signup', done: true, credits: 10_000 },
      { key: 'first_ree', done: true, credits: 2_500 },
    ];
    const today = render({ tasks, checkIn: checkIn('done_today', 5), state: { visible: true, claimable: false, dot: false } });
    for (const text of ['今天能领的奖励都已领完', '今天已打卡', '新手任务都已完成']) expect(today).toContain(text);
    const todayEn = render({ tasks, checkIn: checkIn('done_today', 5), state: { visible: true, claimable: false, dot: false } }, 'en');
    expect(todayEn).toContain('You have claimed everything available today.');

    /* The page shows only while something is available; when a task keeps it up, the check-in section still explains why it is over. */
    const open: Activities['tasks'] = [{ key: 'signup', done: true, credits: 10_000 }, { key: 'first_ree', done: false, credits: 2_500 }];
    const finished = render({ tasks: open, checkIn: checkIn('finished', 30), state: { visible: true, claimable: true, dot: false } });
    for (const text of ['你已打卡满 30 天', '已完成全部打卡']) expect(finished).toContain(text);
    expect(finished).not.toContain('>打卡</button>');
    const expired = render({ tasks: open, checkIn: checkIn('expired', 4), state: { visible: true, claimable: true, dot: false } }, 'en');
    for (const text of ['4 of 30 days', 'Check-in period ended', 'Check-ins are open for 3 months after sign-up; yours ended on']) expect(expired).toContain(text);
    const offTasks = render({ tasks: [{ key: 'signup', done: true, credits: null }], checkIn: checkIn('available', 0), state: { visible: true, claimable: true, dot: true } });
    expect(offTasks).toContain('目前没有新手任务奖励');
    expect(offTasks).not.toContain('已完成 1 / 1');
    const offCheckIn = render({ tasks: open, checkIn: checkIn('off', 0), state: { visible: true, claimable: true, dot: true } });
    for (const text of ['打卡奖励已关闭', '目前没有打卡奖励']) expect(offCheckIn).toContain(text);
  });

  it('still offers an old account its unpaid task, without saying there is nothing to claim', () => {
    const html = render({
      tasks: [
        { key: 'signup', done: true, credits: 10_000 },
        { key: 'first_helpful', done: false, credits: 1_000 },
      ],
      checkIn: checkIn('expired', 2),
      state: { visible: true, claimable: true, dot: false },
    });
    for (const text of ['打卡期已结束', '第一次点「有帮助」', '+1,000 credits', '去完成', 'href="/zh"'] /* the feed, in the page's language */) expect(html).toContain(text);
    expect(html).not.toContain('今天能领的奖励都已领完');
  });

  it('lists the post and helpful tasks, not the retired question and comment ones', () => {
    const tasks: Activities['tasks'] = [
      { key: 'signup', done: true, credits: 20_000 },
      { key: 'first_ree', done: true, credits: 2_500 },
      { key: 'first_post', done: false, credits: 1_000 },
      { key: 'first_helpful', done: false, credits: 1_000 },
    ];
    const en = render({ tasks, checkIn: checkIn('done_today'), state: { visible: true, claimable: true, dot: true } }, 'en');
    for (const text of ['Publish your first post', 'Mark something helpful', 'href="/en?compose=public"', 'href="/en"', '2 of 4 done']) expect(en).toContain(text);
    for (const text of ['Ask your first question', 'Post your first comment', '/explore']) expect(en).not.toContain(text);
    const zh = render({ tasks, checkIn: checkIn('done_today'), state: { visible: true, claimable: true, dot: true } });
    for (const text of ['发布第一个帖子', '第一次点「有帮助」']) expect(zh).toContain(text);
  });

  it('shows the invite tab\'s own status when invitations pay gift credits or are paused', () => {
    const gift = render({ tasks: [{ key: 'signup', done: true, credits: 1 }], checkIn: checkIn('done_today'), state: { visible: true, claimable: true, dot: true } }, 'zh', { ...invite, copy: { withdrawableNote: false, progress: false, status: 'gift_only' } });
    expect(gift).toContain('赠送 credits，可用于消耗，不可提现');
    expect(gift).toContain('今天已打卡');
    const closed = render({ tasks: [{ key: 'signup', done: true, credits: 1 }], checkIn: checkIn('done_today'), state: { visible: true, claimable: true, dot: true } }, 'en', { ...invite, copy: { withdrawableNote: false, progress: false, status: 'closed' } });
    expect(closed).toContain('See your invitations');
    expect(closed).not.toContain('login?invite=');
  });
});
