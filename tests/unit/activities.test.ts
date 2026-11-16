import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/client';
import { messages } from '@/i18n';
import { activitiesPending, openTasks } from '@/lib/domain/invites';
import { INVITE_DEFAULTS } from '@/lib/constants';
import type { Activities } from '@/lib/services/task-rewards';
import type { CheckInStatus } from '@/lib/services/check-in';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, back: () => undefined, refresh: () => undefined, prefetch: () => undefined }),
  usePathname: () => '/activities',
}));

const { ActivitiesView } = await import('@/components/activities/activities-view');

const settings = { ...INVITE_DEFAULTS };
const off = { ...settings, firstReeCredits: 0, firstQuestionCredits: 0, firstCommentCredits: 0 };

describe('the 活动 navigation dot', () => {
  it('is up for a check-in to be had today or a paying task not yet done, and for nothing else', () => {
    expect(activitiesPending({ checkIn: 'available', settings: off, paidTasks: [] })).toBe(true);
    expect(activitiesPending({ checkIn: 'done_today', settings, paidTasks: [] })).toBe(true);
    expect(activitiesPending({ checkIn: 'done_today', settings, paidTasks: ['first_ree', 'first_question', 'first_comment'] })).toBe(false);
    /* A task whose reward is off is not something to do, paid or not. */
    expect(activitiesPending({ checkIn: 'expired', settings: off, paidTasks: [] })).toBe(false);
    expect(activitiesPending({ checkIn: 'finished', settings: { ...off, firstCommentCredits: 1 }, paidTasks: ['first_ree'] })).toBe(true);
    for (const state of ['done_today', 'finished', 'expired', 'off'] as const) expect(activitiesPending({ checkIn: state, settings: off, paidTasks: [] })).toBe(false);
    expect(openTasks(settings, ['first_question'])).toEqual(['first_ree', 'first_comment']);
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
        { key: 'first_question', done: true, credits: 1_000 },
      ],
      checkIn: checkIn('available'),
      pending: true,
    });
    for (const text of ['活动', '每日打卡', '已打卡 3 / 30 天', '>打卡</button>', '新手任务', '已完成 2 / 3', '+2,500 credits', 'href="/rees/new"', '邀请朋友', 'login?invite=ABCDEFGH', '你的可提现邀请奖励：已用 2 / 20 位', 'href="/settings?tab=invite"'])
      expect(html).toContain(text);
    expect(html).not.toContain('现在没有待领取的奖励');
    /* No dismiss: the page is permanent. */
    expect(html).not.toContain('不再显示');
  });

  it('says plainly when nothing is left: check-ins over, every task done', () => {
    const tasks: Activities['tasks'] = [
      { key: 'signup', done: true, credits: 10_000 },
      { key: 'first_ree', done: true, credits: 2_500 },
    ];
    const finished = render({ tasks, checkIn: checkIn('finished', 30), pending: false });
    for (const text of ['现在没有待领取的奖励', '你已打卡满 30 天', '已完成全部打卡', '新手任务都已完成']) expect(finished).toContain(text);
    expect(finished).not.toContain('<button type="button" class="btn sm"');

    const expired = render({ tasks, checkIn: checkIn('expired', 4), pending: false }, 'en');
    for (const text of ['Nothing to claim right now', '4 of 30 days', 'Check-in period ended', 'Check-ins are open for 3 months after sign-up; yours ended on']) expect(expired).toContain(text);

    /* Rewards off and nothing ever paid: the sections still say what is going on. */
    const none = render({ tasks: [{ key: 'signup', done: true, credits: null }], checkIn: checkIn('off', 0), pending: false });
    for (const text of ['打卡奖励已关闭', '目前没有打卡奖励', '目前没有新手任务奖励']) expect(none).toContain(text);
    expect(none).not.toContain('已完成 1 / 1');
  });

  it('shows the invite tab\'s own status when invitations pay gift credits or are paused', () => {
    const gift = render({ tasks: [{ key: 'signup', done: true, credits: 1 }], checkIn: checkIn('done_today'), pending: true }, 'zh', { ...invite, copy: { withdrawableNote: false, progress: false, status: 'gift_only' } });
    expect(gift).toContain('赠送 credits，可用于消耗，不可提现');
    expect(gift).toContain('今天已打卡');
    const closed = render({ tasks: [{ key: 'signup', done: true, credits: 1 }], checkIn: checkIn('done_today'), pending: true }, 'en', { ...invite, copy: { withdrawableNote: false, progress: false, status: 'closed' } });
    expect(closed).toContain('See your invitations');
    expect(closed).not.toContain('login?invite=');
  });
});
