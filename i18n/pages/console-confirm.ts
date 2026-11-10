import type { Shape } from '@/i18n/format';

/** The console's confirmation step before a final payout or review decision (review C8). */
export const zh = {
  back: '返回修改',
  payout: {
    rejectTitle: '驳回这笔提现？',
    rejectBody: '驳回 {name}（PayPal {paypal}）的 {amount} 提现申请，冻结的收入 credits 退回其余额。驳回后不能撤销。',
    reject: '确认驳回',
    paidTitle: '登记为已打款？',
    paidBody: '确认已向 {name}（PayPal {paypal}）转出 {paid}，转账号 {transfer}。登记后这笔提现结束，冻结的 {amount} 正式扣除，不能撤销。',
    paid: '确认已打款',
    failedTitle: '登记为打款失败？',
    failedBody: '登记 {name}（PayPal {paypal}）的 {amount} 打款失败，冻结的 credits 退回其余额。如果钱其实已经转出，请不要登记失败。登记后不能撤销。',
    failed: '确认打款失败',
  },
  kyc: {
    approveTitle: '通过这份身份认证？',
    approveBody: '确认 {name} 的证件与填写信息一致，通过后可以申请提现。',
    approve: '确认通过',
    rejectTitle: '驳回这份身份认证？',
    rejectBody: '驳回 {name} 的身份认证，对方需要重新提交。',
    reject: '确认驳回',
  },
  verification: {
    approveTitle: '通过这项角色认证？',
    approveBody: '通过后 {name} 的 Ree 将显示该认证角色。',
    approve: '确认通过',
    rejectTitle: '驳回这项角色认证？',
    rejectBody: '驳回 {name} 的角色认证申请。',
    reject: '确认驳回',
  },
};

export const en: Shape<typeof zh> = {
  back: 'Go back',
  payout: {
    rejectTitle: 'Reject this payout?',
    rejectBody: 'Reject the {amount} payout request from {name} (PayPal {paypal}). The held earned credits return to their balance. This cannot be undone.',
    reject: 'Reject payout',
    paidTitle: 'Record as paid?',
    paidBody: 'Confirm that {paid} was sent to {name} (PayPal {paypal}), transfer {transfer}. The payout closes and the held {amount} is deducted for good. This cannot be undone.',
    paid: 'Record as paid',
    failedTitle: 'Record as failed?',
    failedBody: 'Record the {amount} payout to {name} (PayPal {paypal}) as failed. The held credits return to their balance. Do not record a failure if the money was actually sent. This cannot be undone.',
    failed: 'Record as failed',
  },
  kyc: {
    approveTitle: 'Approve this identity check?',
    approveBody: 'Confirm that the documents of {name} match what they entered. Once approved they can request payouts.',
    approve: 'Approve',
    rejectTitle: 'Reject this identity check?',
    rejectBody: 'Reject the identity check of {name}. They will need to submit again.',
    reject: 'Reject',
  },
  verification: {
    approveTitle: 'Approve this role verification?',
    approveBody: 'Once approved, the Rees of {name} show this verified role.',
    approve: 'Approve',
    rejectTitle: 'Reject this role verification?',
    rejectBody: 'Reject the role verification request of {name}.',
    reject: 'Reject',
  },
};
