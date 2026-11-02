import type { Shape } from '@/i18n/format';

/** Console users, verification requests and purchase records (step 5). */
export const zh = {
  users: {
    title: '用户管理',
    lede: '查看账号状态、完整账户信息与余额，所有管理操作写入审计。',
    search: '搜索姓名、邮箱或用户编号…',
    cards: { total: '用户总数', activePlans: '有效 Plan', verified: '认证用户', disabled: '已停用' },
    filters: { status: '账号状态', role: '角色', membership: '会员状态', kyc: 'KYC 状态', period: '时间', sort: '排序' },
    allRoles: '全部角色',
    allStatuses: '全部账号状态',
    allMemberships: '全部会员状态',
    allKyc: '全部 KYC 状态',
    status: { active: '有效', disabled: '已停用' },
    membership: { active: 'Plan 生效中', cancelled: '已取消', expired: '已过期', none: '未订阅' },
    kyc: { none: '未提交', pending: '待审核', verified: '已通过', rejected: '已驳回', reset: '待重新验证' },
    kycExempt: '无需 KYC',
    columns: { user: '用户', role: '角色', status: '状态 / 会员', credits: 'Credits', kyc: 'KYC', joined: '加入时间 · UTC+8', action: '操作' },
    manageRole: '管理角色',
    details: '详情',
    plan: 'Plan',
  },
};

export const en: Shape<typeof zh> = {
  users: {
    title: 'Users',
    lede: 'Account status, the whole account and balances. Every management action is audited.',
    search: 'Search name, email or user ID…',
    cards: { total: 'Total users', activePlans: 'Active Plans', verified: 'Verified users', disabled: 'Disabled' },
    filters: { status: 'Account', role: 'Role', membership: 'Membership', kyc: 'KYC', period: 'Time', sort: 'Sort' },
    allRoles: 'All roles',
    allStatuses: 'All account statuses',
    allMemberships: 'All memberships',
    allKyc: 'All KYC statuses',
    status: { active: 'Active', disabled: 'Disabled' },
    membership: { active: 'Active Plan', cancelled: 'Cancelled', expired: 'Expired', none: 'No Plan' },
    kyc: { none: 'Not submitted', pending: 'Pending', verified: 'Verified', rejected: 'Rejected', reset: 'Reverification' },
    kycExempt: 'KYC exempt',
    columns: { user: 'User', role: 'Role', status: 'Status / membership', credits: 'Credits', kyc: 'KYC', joined: 'Joined · UTC+8', action: 'Action' },
    manageRole: 'Manage role',
    details: 'Details',
    plan: 'Plan',
  },
};
