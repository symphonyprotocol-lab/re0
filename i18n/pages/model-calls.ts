import type { Shape } from '@/i18n/format';
export const zh = {
  title: '生成模型调用', lede: '按模型、用户组和用途查看调用量、Token 用量与每次调用费用。',
  note: '统计包含每次供应商请求与重试。费用为供应商成本，不是用户扣除的积分。历史费用可按当前单价补算并标注估算，缺少的身份、状态或费用仍显示为未知。',
  search: '搜索模型、配置、用户、邮箱或请求 ID', allModels: '全部模型', model: '模型', audience: '用户组', purpose: '调用用途',
  audiences: { all: '全部用户组', free: '免费用户', plan: 'Plan 用户', unknown: '未知 / 后台测试' },
  purposes: { all: '全部用途', answer: '问答', retrieval: '检索改写', verify: '回答核验', synthesis: '圆桌综合', suggestions: '示例问题', video_answer: '视频示例回答', video_script: '视频脚本', probe: '连通测试', other: '其他' },
  statuses: { all: '全部状态', succeeded: '成功', failed: '失败', aborted: '中断', unknown: '未知（历史记录）' },
  basis: { provider_reported: '供应商实际费用', configured_rate: '按配置单价计算', gateway_catalog: '按 AI Gateway 报价估算', historical_estimate: '按当前单价补算（估算）', estimated: '估算', unresolved: '未知' },
  cards: { calls: '调用次数', succeeded: '成功', failed: '失败 / 中断', tokens: '输入 / 输出 Token', cost: '已知成本（USD）', estimated: '估算成本（USD）', unpriced: '费用未知的调用', latency: '平均耗时' },
  groupTitle: '按模型与用户组汇总', records: '调用明细', config: '配置', user: '用户', status: '状态', time: '开始时间', duration: '耗时', input: '输入 Token', output: '输出 Token', cost: '本次费用（USD）', basisLabel: '计价依据', details: '详情',
  costHigh: '费用从高到低', costLow: '费用从低到高', manage: '模型配置', pricing: '设置生成模型单价', refresh: '刷新',
  priceUnknown: '费用未知', historicalPriceMissing: '历史记录未保存费用', priceMissing: '缺少价格或完整用量',
  detail: { title: '生成调用详情', back: '返回调用列表', record: '调用信息', usage: '用量与费用', id: '记录 ID', endpoint: '服务地址', requestId: '供应商请求 ID', error: '错误类别', inputPrice: 'USD / 输入 Token', outputPrice: 'USD / 输出 Token', source: '单价来源', revision: '单价版本', unknown: '未知', noUsage: '此记录没有完整的用量信息，无法确认全部 Token 消耗。', backfillNote: '本条费用按已记录的 Token 用量及补算时的模型当前单价估算，并非历史实际扣费；用户积分不受影响。', snapshot: '单价按请求时保存，之后修改价格不会重算历史费用。供应商实际费用可能包含缓存等折扣。' },
};
export const en: Shape<typeof zh> = {
  title: 'Generation calls', lede: 'Inspect requests, token usage and per-call costs by model, audience and purpose.',
  note: 'Counts include individual provider attempts and retries. Costs are supplier costs, separate from customer credits. Historical costs backfilled at current prices are labelled as estimates; missing identity, status or costs remain unknown.',
  search: 'Search model, configuration, user, email or request ID', allModels: 'All models', model: 'Model', audience: 'Audience', purpose: 'Purpose',
  audiences: { all: 'All audiences', free: 'Free users', plan: 'Plan users', unknown: 'Unknown / admin tests' },
  purposes: { all: 'All purposes', answer: 'Answer', retrieval: 'Query rewrite', verify: 'Answer check', synthesis: 'Round-table synthesis', suggestions: 'Example questions', video_answer: 'Video example answer', video_script: 'Video script', probe: 'Connection test', other: 'Other' },
  statuses: { all: 'All statuses', succeeded: 'Succeeded', failed: 'Failed', aborted: 'Aborted', unknown: 'Unknown (historical)' },
  basis: { provider_reported: 'Provider-reported cost', configured_rate: 'Configured unit prices', gateway_catalog: 'AI Gateway quote estimate', historical_estimate: 'Backfilled at current prices (estimate)', estimated: 'Estimate', unresolved: 'Unknown' },
  cards: { calls: 'Calls', succeeded: 'Succeeded', failed: 'Failed / aborted', tokens: 'Input / output tokens', cost: 'Known cost (USD)', estimated: 'Estimated cost (USD)', unpriced: 'Unpriced calls', latency: 'Average duration' },
  groupTitle: 'By model and audience', records: 'Call records', config: 'Configuration', user: 'User', status: 'Status', time: 'Started', duration: 'Duration', input: 'Input tokens', output: 'Output tokens', cost: 'Call cost (USD)', basisLabel: 'Cost basis', details: 'Details',
  costHigh: 'Highest cost', costLow: 'Lowest cost', manage: 'Model settings', pricing: 'Set generation unit prices', refresh: 'Refresh',
  priceUnknown: 'Cost unknown', historicalPriceMissing: 'No historical cost recorded', priceMissing: 'Price or complete usage missing',
  detail: { title: 'Generation call details', back: 'Back to calls', record: 'Request', usage: 'Usage and cost', id: 'Record ID', endpoint: 'Endpoint', requestId: 'Provider request ID', error: 'Error category', inputPrice: 'USD / input token', outputPrice: 'USD / output token', source: 'Price source', revision: 'Price revision', unknown: 'Unknown', noUsage: 'This record has incomplete usage; total token consumption is unknown.', backfillNote: 'This cost is estimated from recorded tokens and the model prices at backfill time, not the historical bill. Customer credits are unchanged.', snapshot: 'Unit prices are saved per attempt. Later changes do not recalculate historical costs. Provider-reported costs may include cache discounts.' },
};
