import {adminScaleData} from './admin-scale.js';
import {reportingDate} from './statistics-time.js';

// A read-only projection, like the other console scale catalogs. These records
// never become applications belonging to the signed-in account or enter storage.
let cachedDay, cachedRecords;
export function verificationDemoRequests(now = new Date()) {
  const day = reportingDate(now);
  if (cachedDay === day) return cachedRecords;
  const users = adminScaleData(now).users.filter(user => Number(now) - Date.parse(user.created) >= 14 * 86400000);
  const topics = ['产品设计', '技术开发', '阅读写作', '知识管理', '商业增长', '用户研究'];
  cachedRecords = users.map((user, index) => {
    const topic = topics[index % topics.length];
    const available = Number(now) - Date.parse(user.created) - 14 * 86400000;
    const submitted = Date.parse(user.created) + 14 * 86400000 + available * ((index % 7 + 1) / 9);
    const status = user.role === 'verified' ? 'approved' : Math.floor(index / 7) % 3 === 0 ? 'rejected' : 'pending';
    const helpful = 80 + index % 20;
    return {
      id: 'scale-verification-' + user.id.slice(-4), user: user.id, adminScale: true,
      statement: `我持续整理${topic}领域的公开知识，维护原始来源与引用，并根据使用反馈改进回答。申请展示${topic}方面的专业积累与长期创作记录。` + (index % 17 === 0 ? '我也参与跨领域研究与团队协作，定期复核内容时效性，为不同经验的使用者补充背景、案例与可核对的材料。' : ''),
      links: Array.from({length:index % 4}, (_,i) => `https://example.com/creators/${user.id}/${['portfolio','articles','projects'][i]}`),
      metrics: {registeredDays:Math.floor((submitted-Date.parse(user.created))/86400000),publicRees:1+index%8,readySources:5+index%79,externalQuestions:100+index*13,helpful,unhelpful:100-helpful,feedbackCount:100,helpfulRate:helpful/100},
      reeSummary: {name:topic+'实践与研究 · '+user.id.slice(-4),readySources:5+index%79},
      status,createdAt:new Date(submitted).toISOString(),
      decidedAt:status==='pending'?null:new Date(submitted+(Number(now)-submitted)*.6).toISOString(),
      reviewedBy:status==='pending'?null:'reviewer-'+(index%7+1)+'@example.com',
      reason:status==='rejected'?'申请说明与公开作品的关联需要补充，请提供可核对的原创内容与维护记录。':''
    };
  });
  cachedDay = day;
  return cachedRecords;
}
