import type { Shape } from '@/i18n/format';

/** 站内通知（step 5，8.2「通知」：设置页一个列表 + 侧栏小红点）. */
export const zh = {
  title: '通知',
  tab: '通知',
  lede: '下架与恢复、credits 调整、认证审核结果与角色变更会通知到这里，不另发邮件。',
  markAll: '全部标为已读',
  unread: '未读',
  unreadCount: '{n} 条未读通知',
  empty: '暂无通知',
  emptyBody: '管理员处理与你账号相关的事项后，会在这里告诉你。',
  reason: '原因：{text}',
  note: '说明：{text}',
  buckets: { pack: 'Pack', plan: 'Plan' },
  lines: {
    takedown: '你的 Ree「{ree}」已被管理员下架，暂停公开展示。',
    restore: '你的 Ree「{ree}」已恢复公开展示。',
    creditsAdd: '管理员向你的 {bucket} 余额增加了 {n} credits。',
    creditsDeduct: '管理员从你的 {bucket} 余额扣除了 {n} credits。',
    approved: '你的账号认证申请已通过，账号现为认证用户。',
    rejected: '你的账号认证申请未通过，30 天后可再次申请。',
    role: '你的账号角色已由「{from}」变更为「{to}」。',
    kyc: '你的身份核验状态有更新。',
    payout: '你的提现申请状态有更新。',
    other: '你有一条新的账户通知。',
  },
  open: {
    ree: '查看 Ree',
    billing: '查看余额',
    role: '查看角色',
  },
};

export const en: Shape<typeof zh> = {
  title: 'Notices',
  tab: 'Notices',
  lede: 'Takedowns and restores, credit adjustments, verification decisions and role changes are reported here. No email is sent.',
  markAll: 'Mark all as read',
  unread: 'Unread',
  unreadCount: '{n} unread notices',
  empty: 'No notices yet',
  emptyBody: 'When an administrator acts on something about your account, you will find it here.',
  reason: 'Reason: {text}',
  note: 'Note: {text}',
  buckets: { pack: 'Pack', plan: 'Plan' },
  lines: {
    takedown: 'Your Ree “{ree}” was taken down by an administrator and is no longer public.',
    restore: 'Your Ree “{ree}” is public again.',
    creditsAdd: 'An administrator added {n} credits to your {bucket} balance.',
    creditsDeduct: 'An administrator deducted {n} credits from your {bucket} balance.',
    approved: 'Your verification request was approved. Your account is now verified.',
    rejected: 'Your verification request was not approved. You can reapply in 30 days.',
    role: 'Your account role changed from “{from}” to “{to}”.',
    kyc: 'Your identity verification status changed.',
    payout: 'Your payout request status changed.',
    other: 'You have a new account notice.',
  },
  open: {
    ree: 'View Ree',
    billing: 'View balance',
    role: 'View role',
  },
};
