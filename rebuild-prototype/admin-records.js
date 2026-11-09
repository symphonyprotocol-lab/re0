import { USER_ROLES, roleOf } from "./user-role-domain.js";
import { createAdminFinance } from "./admin-finance.js";
import { statisticsSelectionDate, validStatisticsRange, reportingDate } from "./statistics-time.js";
import { ADMIN_RECORD_KINDS, ADMIN_MEMBERSHIP_STATES, ADMIN_USER_KYC_STATES, ADMIN_AUDIT_ACTIONS, adminScaleData, adminRecordTime, adminRecordView, adminRecordPath, adminRecordBackPath, selectAdminRecords } from './admin-scale.js';
import { discoveryPageNumbers } from './discovery.js';

// Large catalogs are a separate, read-only projection. They never enter account storage.
export function createAdminRecords(ctx) {
  const {t,I,esc,n,route,go,tag,table,sectionHead,getState} = ctx;
  const titles={users:['用户管理','Users'],kyc:['KYC 记录','KYC records'],purchases:['充值与订阅','Purchases & subscriptions'],payouts:['提现审核','Payout review'],'payout-history':['提现记录','Payout history'],audit:['审计日志','Audit log']};
  const statusNames={active:['有效','Active'],disabled:['已停用','Disabled'],pending:['待审核','Pending review'],approved:['待人工打款','Awaiting payment'],verified:['已通过','Verified'],rejected:['已驳回','Rejected'],reset:['待重新验证','Reverification'],none:['未提交','Not submitted'],processing:['处理中','Processing'],paid:['已支付','Paid'],refunded:['已退款','Refunded'],chargeback:['拒付','Chargeback'],cancelled:['周期末取消','Cancels at period end'],expired:['已过期','Expired'],failed:['失败','Failed']};
  const actionNames={'verification.approved':['批准账号认证','Approve account verification'],'verification.rejected':['拒绝账号认证','Reject account verification'],'user.role.official':['设为官方','Make official'],'user.role.cancel-official':['取消官方','Remove official role'],'user.role.revoke':['撤销账号认证','Revoke verification'],'user.disable':['停用账号','Disable user'],'user.restore':['恢复账号','Restore user'],'credits.adjust':['调整额度','Adjust credits'],'kyc.verified':['通过身份审核','Verify identity'],'kyc.rejected':['驳回身份审核','Reject identity'],'payout.approved':['批准提现','Approve payout'],'payout.paid':['登记支付成功','Record payment'],'payout.failed':['登记支付失败','Record failure'],'ree.takedown':['下架 Ree','Take down Ree'],'ree.restore':['恢复 Ree','Restore Ree'],'model.activate':['启用模型','Activate model'],'kyc.files.view':['查看身份材料','View identity files']};
  let observer,resize;
  const finance=createAdminFinance(ctx);
  const link=(path,label,cls='text-link',attrs='')=>`<a class="${cls}" href="#${esc(path)}" ${attrs}>${label}</a>`;
  const clip=(value,cls='')=>`<span class="record-clip ${cls}" title="${esc(value??'—')}">${esc(value??'—')}</span>`;
  const statusText=status=>statusNames[status]?t(...statusNames[status]):status;
  const stamp=row=>{const time=adminRecordTime(row);return time===null?'—':new Intl.DateTimeFormat(getState().lang==='en'?'en-GB':'zh-CN',{timeZone:'Asia/Kuching',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(time));};
  const usd=value=>'$'+Number(value||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  function rows(kind,query=route().query) {
    const demo=adminScaleData(),real=ctx.actualRows(kind),allUsers=[...ctx.actualRows('users'),...demo.users];
    const byUser=new Map(allUsers.map(user=>[user.id,user]));
    let records;
    if(kind==='purchases'&&adminRecordView(kind,query).tab==='subscriptions') records=allUsers.map(u=>({...u,status:u.subscription,kind:'subscription',user:u.id}));
    else records=[...real,...(demo[kind==='payout-history'?'payouts':kind]||[])];
    return records.map(record=>{const owner=byUser.get(record.user);return {...record,role:ctx.userRoles?ctx.userRoles.roleFor(record.user||record.id):roleOf(record.role),name:record.name||owner?.name,email:kind==='users'||record.kind==='subscription'?record.email:record.email||owner?.email,userEmail:owner?.email, actionLabel:actionNames[String(record.action).replace(/^dot\./i,"ree.")]?t(...actionNames[String(record.action).replace(/^dot\./i,"ree.")]):record.action};});
  }
  const currentList=()=>route().path+(route().query.size?'?'+route().query:'');
  function detailPath(kind,row,back=currentList()) {
    const base=kind==='payout-history'?'payouts':row.kind==='subscription'?'users':kind;
    return '/admin/'+base+'/'+encodeURIComponent(row.id)+(base==='payouts'&&row.status==='approved'?'/payment':'')+'?from='+encodeURIComponent(back);
  }
  function person(row,kind) {
    const id=kind==='users'||row.kind==='subscription'?row.id:row.user;
    const origin=ADMIN_RECORD_KINDS.includes(route().path.slice(7))?currentList():adminRecordBackPath(route().query.get('from'),kind==='payout-history'?'payout-history':kind);
    const path='/admin/users/'+encodeURIComponent(id||'')+'?from='+encodeURIComponent(origin);
    return `<div class="record-person">${id?link(path,clip(row.name||id,'record-name')):clip(row.name)}<small>${clip(row.userEmail||row.email)}</small></div>`;
  }
  function columns(kind,query) {
    if(kind==='users')return [t('用户','User'),t('角色','Role'),t('状态 / 会员','Status / membership'),'Credits',t('KYC','KYC'),t('加入时间 · UTC+8','Joined · UTC+8'),t('操作','Action')];
    if(kind==='kyc')return [t('申请人','Applicant'),t('提交信息','Submission'),t('审核状态','Status'),t('提交时间 · UTC+8','Submitted · UTC+8'),t('审核人','Reviewer'),t('操作','Action')];
    if(kind==='purchases'&&adminRecordView(kind,query).tab==='subscriptions')return [t('用户','User'),t('订阅状态','Status'),t('自动续费','Renewal'),t('Plan 剩余额度','Plan remaining'),t('加入时间 · UTC+8','Joined · UTC+8'),t('操作','Action')];
    if(kind==='purchases')return [t('用户','User'),t('类型 / 金额','Type / amount'),t('交易号','Transaction ID'),'Credits',t('状态 / 时间 · UTC+8','Status / time · UTC+8'),t('操作','Action')];
    if(kind==='audit')return [t('时间 · UTC+8','Time · UTC+8'),t('管理员','Administrator'),t('操作','Action'),t('对象','Target'),t('详情','Details')];
    return [t('申请人','Applicant'),t('申请金额 / 实付','Requested / net paid'),t('PayPal 收款邮箱','PayPal email'),t('状态 / 申请时间 · UTC+8','Status / requested · UTC+8'),t('审核 / 支付信息','Review / payment'),t('操作','Action')];
  }
  function cells(kind,row,query) {
    const action=label=>link(detailPath(kind,row),esc(row.adminScale&&(kind==='kyc'||kind==='payouts'||kind==='payout-history')?t('查看详情','Details'):label),'btn secondary sm record-open')+(row.adminScale?`<small class="record-readonly" title="${t('只读示例','Read-only sample')}">${t('示例','Sample')}</small>`:'');
    if(kind==='users')return [person(row,kind),`${ctx.userRoles?.badge(row.role,true)||esc(({normal:t('普通','Normal'),verified:t('认证','Verified'),official:t('官方','Official')})[roleOf(row.role)])}${!row.adminScale?link('/admin/users/'+encodeURIComponent(row.id)+'?tab=roles&from='+encodeURIComponent(currentList()),t('管理角色','Manage role'),'text-link cell-subline'):''}`,`${tag(row.status)}<small class="cell-subline">Plan · ${statusText(row.subscription)}</small>`,`<span class="mono">${n((row.plan||0)+(row.pack||0)+(row.earned||0))}</span>`,row.role==='official'?`<span class="tag">${t('无需 KYC','KYC exempt')}</span>`:tag(row.kyc||'none'),stamp(row),action(t('详情','Details'))];
    if(kind==='kyc')return [person(row,kind),`${clip(row.country||'—')}<small class="cell-subline">${esc(row.tax||'—')} · ${esc(row.last4?'•••• '+row.last4:'—')}</small>`,tag(row.status),stamp(row),clip(row.reviewer||'—'),row.status==='none'?`<span class="muted">${t('未提交资料','No submission')}</span>`:action(row.status==='pending'?t('审核资料','Review'):t('详情','Details'))];
    if(kind==='purchases'&&row.kind==='subscription')return [person(row,kind),tag(row.status),row.status==='active'?t('开启','On'):t('关闭','Off'),`<span class="mono">${n(row.plan||0)}</span>`,stamp(row),action(t('用户详情','User details'))];
    if(kind==='purchases')return [person(row,kind),`<strong class="mono">${usd(row.amount)}</strong><small class="cell-subline">${esc(row.kind==='plan'?'Plan':'Pack')}</small>`,clip(row.id,'mono record-id'),n(row.credits),`${tag(row.status)}<small class="cell-subline">${stamp(row)}</small>`,action(t('交易详情','Transaction'))];
    if(kind==='audit'){const code=String(row.action||'').replace(/^dot\./i,'ree.');return [stamp(row),clip(row.actor),`${esc(actionNames[code]?t(...actionNames[code]):code)}<small class="cell-subline">${clip(code,'mono')}</small>`,clip(row.target,'mono'),action(t('查看变更','View changes'))];}
    return [person(row,kind),`<strong class="mono">${usd(row.credits/10000)}</strong><small class="cell-subline">${row.status==='paid'?t('实付','Net')+' '+usd(row.actual??row.credits/10000-(row.fee||0)):n(row.credits)+' credits'}</small>`,clip(row.email),`${tag(row.status)}<small class="cell-subline">${stamp(row)}</small>`,`${clip(row.reviewer||'—')}<small class="cell-subline">${clip(row.transferId||row.note||'—')}</small>`,action(row.status==='pending'?t('审核申请','Review'):row.status==='approved'?t('登记打款结果','Record payment'):t('查看详情','Details'))];
  }
  function pager(kind,data) {
    const {view,pages}=data;
    const pageLink=(p,label,name)=>p<1||p>pages?`<span class="is-disabled" aria-disabled="true">${label}</span>`:link(adminRecordPath(kind,route().query,{page:p}),label,'record-page-link',`aria-label="${esc(name)}"`);
    return `<div class="admin-ree-pagination record-pagination"><span>${t('第','Page')} ${view.page} / ${pages} ${t('页','')}</span><nav class="admin-ree-pages" aria-label="${t('记录分页','Records pagination')}">${pageLink(view.page-1,I('chevron'),t('上一页','Previous page'))}${discoveryPageNumbers(view.page,pages).map(p=>p===null?'<span class="pagination-ellipsis">…</span>':p===view.page?`<span class="is-current" aria-current="page">${p}</span>`:pageLink(p,p,t('第 ','Page ')+p+t(' 页',''))).join('')}${pageLink(view.page+1,I('chevron'),t('下一页','Next page'))}</nav><form id="admin-record-jump"><label for="record-page">${t('跳至','Go to')}</label><input id="record-page" aria-label="${t('跳转页码','Page number')}" name="page" type="number" min="1" max="${pages}" value="${view.page}" required ${pages===1?'disabled':''}><button class="btn secondary sm" ${pages===1?'disabled':''}>${t('跳转','Go')}</button></form></div>`;
  }
  function filters(kind,view) {
    const options=(list,value)=>list.map(([id,label])=>`<option value="${id}" ${id===value?'selected':''}>${label}</option>`).join('');
    if(kind==='users') {
      const select=(label,name,aria,items,value)=>`<label><span>${label}</span><select name="${name}" aria-label="${aria}">${options(items,value)}</select></label>`;
      const filtered=view.q||view.status!=='all'||view.role!=='all'||view.membership!=='all'||view.kyc!=='all'||view.period!=='all'||view.sort!==view.fallback;
      return `<form id="admin-record-filter" class="record-filter record-user-filter"><div class="record-user-search"><div class="search-small">${I('search')}<input aria-label="${t('搜索记录','Search records')}" name="q" maxlength="400" value="${esc(view.q)}" placeholder="${t('搜索姓名、邮箱或用户编号…','Search name, email or user ID…')}"></div><button class="btn secondary sm">${t('搜索','Search')}</button>${filtered?link(adminRecordPath(kind,new URLSearchParams(),{size:view.size}),t('重置','Reset')):''}${select(t('每页','Per page'),'size',t('每页条数','Rows per page'),[20,50,100].map(size=>[size,size+' '+t('条','rows')]),view.size)}</div><div class="record-user-criteria">${select(t('账号状态','Account'),'status',t('账号状态筛选','Account status filter'),[['all',t('全部账号状态','All account statuses')],...view.allowed.map(status=>[status,statusText(status)])],view.status)}${select(t('角色','Role'),'role',t('角色筛选','Role filter'),[['all',t('全部角色','All roles')],...USER_ROLES.map(role=>[role,({normal:t('普通','Normal'),verified:t('认证','Verified'),official:t('官方','Official')})[role]])],view.role)}${select(t('会员状态','Membership'),'membership',t('会员状态筛选','Membership status filter'),[['all',t('全部会员状态','All memberships')],...ADMIN_MEMBERSHIP_STATES.map(status=>[status,status==='active'?t('Plan 生效中','Active Plan'):statusText(status)])],view.membership)}${select(t('KYC 状态','KYC'),'kyc',t('KYC 状态筛选','KYC status filter'),[['all',t('全部 KYC 状态','All KYC statuses')],...ADMIN_USER_KYC_STATES.map(status=>[status,statusText(status)])],view.kyc)}${select(t('时间','Time'),'period',t('时间范围','Date range'),[['all',t('全部时间','All time')],['7',t('最近 7 天','Last 7 days')],['30',t('最近 30 天','Last 30 days')],['90',t('最近 90 天','Last 90 days')]],view.period)}${select(t('排序','Sort'),'sort',t('排序方式','Sort order'),view.sorts.map(sort=>[sort,sort==='oldest'?t('最早优先','Oldest first'):t('最新优先','Newest first')]),view.sort)}</div></form>`;
    }
    return `<form id="admin-record-filter" class="record-filter"><div class="search-small">${I('search')}<input aria-label="${t('搜索记录','Search records')}" name="q" maxlength="400" value="${esc(view.q)}" placeholder="${t(kind==='audit'?'搜索管理员、操作或对象编号…':'搜索姓名、邮箱或记录编号…',kind==='audit'?'Administrator, action or target ID…':'Name, email or record ID…')}"></div>${kind==='audit'?`<label><span>${t('操作','Action')}</span><select name="action" aria-label="${t('操作类型','Action type')}">${options([['all',t('全部操作','All actions')],...ADMIN_AUDIT_ACTIONS.map(code=>[code,t(...actionNames[code])])],view.action)}</select></label>`:''}${view.allowed.length?`<label><span>${t('状态','Status')}</span><select name="status" aria-label="${t('状态筛选','Status filter')}">${options([['all',t('全部状态','All statuses')],...view.allowed.map(s=>[s,statusText(s)])],view.status)}</select></label>`:''}${finance.enabled(kind,route().query)?`<input type="hidden" name="period" value="${esc(view.period)}">`:`<label><span>${t('时间','Time')}</span><select name="period" aria-label="${t('时间范围','Date range')}">${options([['all',t('全部时间','All time')],['7',t('最近 7 天','Last 7 days')],['30',t('最近 30 天','Last 30 days')],['90',t('最近 90 天','Last 90 days')]],view.period)}</select></label>`}<label><span>${t('排序','Sort')}</span><select name="sort" aria-label="${t('排序方式','Sort order')}">${options(view.sorts.map(s=>[s,({oldest:t('最早优先','Oldest first'),newest:t('最新优先','Newest first'),'amount-high':t('金额从高到低','Amount: high to low'),'amount-low':t('金额从低到高','Amount: low to high')})[s]]),view.sort)}</select></label><button class="btn secondary sm">${t('搜索','Search')}</button>${view.q||view.status!=='all'||view.period!=='all'||view.sort!==view.fallback||view.action!=='all'?link(adminRecordPath(kind,new URLSearchParams(),{tab:view.tab,size:view.size}),t('重置','Reset')):''}<label class="record-size"><span>${t('每页','Per page')}</span><select name="size" aria-label="${t('每页条数','Rows per page')}">${options([20,50,100].map(size=>[size,size+' '+t('条','rows')]),view.size)}</select></label></form>`;
  }
  function summary(kind,all) {
    const count=s=>n(all.filter(r=>r.status===s).length);
    const view=adminRecordView(kind,route().query);
    let entries=kind==='users'?[[t('用户总数','Total users'),n(all.length),'all-users'],[t('有效 Plan','Active Plans'),n(all.filter(r=>r.subscription==='active').length),{membership:'active'}],[t('已通过 KYC','Verified KYC'),n(all.filter(r=>r.kyc==='verified').length),{kyc:'verified'}],[t('已停用','Disabled'),count('disabled'),{status:'disabled'}]]:kind==='kyc'?[[t('KYC 记录','KYC records'),n(all.length),'all-records'],[t('待审核','Pending review'),count('pending'),'pending'],[t('已通过','Verified'),count('verified'),'verified'],[t('已驳回','Rejected'),count('rejected'),'rejected']]:kind==='payouts'?[[t('待处理总数','Awaiting action'),n(all.length),'all-records'],[t('待审核','Pending review'),count('pending'),'pending'],[t('待人工打款','Awaiting payment'),count('approved'),'approved'],[t('申请冻结总额','Held amount'),usd(all.reduce((s,r)=>s+r.credits/10000,0)),'all-records',false]]:kind==='payout-history'?[[t('全部申请','All requests'),n(all.length),'all-records'],[t('已支付','Paid'),count('paid'),'paid'],[t('支付失败','Failed'),count('failed'),'failed'],[t('已驳回','Rejected'),count('rejected'),'rejected']]:kind==='purchases'?[[t('记录总数','Total records'),n(all.length),'all-records'],[t('已支付','Paid'),count('paid'),'paid'],[t('已退款','Refunded'),count('refunded'),'refunded'],[t('拒付','Chargebacks'),count('chargeback'),'chargeback']]:[[t('审计记录','Audit records'),n(all.length)],[t('管理员','Administrators'),n(new Set(all.map(r=>r.actor)).size)],[t('操作类型','Action types'),n(new Set(all.map(r=>r.action)).size)]];
    if(kind==='purchases'&&view.tab==='subscriptions')entries=[[t('订阅总数','Total subscriptions'),n(all.length),'all-records'],[t('生效中','Active'),count('active'),'active'],[t('周期末取消','Cancels at period end'),count('cancelled'),'cancelled'],[t('已过期','Expired'),count('expired'),'expired']];
    return `<div class="record-summary" aria-label="${t('全量数据概览','Full catalog summary')}">${entries.map(([label,value,filter,highlight=true])=>{
      const content=`<span>${label}</span><strong class="mono">${value}</strong>`;
      if(!filter)return `<div class="record-summary-item">${content}</div>`;
      if(filter==='all-users'||filter==='all-records') {
        const selected=highlight&&!view.q&&['status','role','membership','kyc','period'].every(key=>view[key]==='all');
        const resetLabel=kind==='users'?t('清除搜索和筛选，显示全部用户','Clear search and filters to show all users'):kind==='kyc'?t('清除搜索和筛选，显示全部 KYC 记录','Clear search and filters to show all KYC records'):kind==='payouts'?t('清除搜索和筛选，显示全部待处理申请','Clear search and filters to show all pending requests'):kind==='purchases'&&view.tab==='subscriptions'?t('清除搜索和筛选，显示全部订阅','Clear search and filters to show all subscriptions'):t('清除搜索和筛选，显示全部记录','Clear search and filters to show all records');
        return link(adminRecordPath(kind,new URLSearchParams(),{tab:view.tab,size:view.size}),content,'record-summary-item'+(selected?' is-filtered':''),`title="${resetLabel}" ${selected?'aria-current="true"':''}`);
      }
      const changes=typeof filter==='string'?{status:filter}:filter;
      const selected=highlight&&Object.entries(changes).every(([key,status])=>view[key]===status);
      return link(adminRecordPath(kind,route().query,changes),content,'record-summary-item'+(selected?' is-filtered':''),`title="${t('点击筛选：','Filter by: ')}${esc(label)}" ${selected?'aria-current="true"':''}`);
    }).join('')}</div>`;
  }
  function page(kind,query) {
    const catalog=rows(kind,query),data=selectAdminRecords(kind,catalog,query),{view}=data;
    const canonical=adminRecordPath(kind,query,{page:view.page});
    if(typeof history!=='undefined'&&currentList()!==canonical)history.replaceState(null,'','#'+canonical);
    const subtitle=kind==='payouts'?t('按申请时间优先处理；待审核与待人工打款分开筛选。','Process oldest requests first; filter review and payment queues separately.'):kind==='audit'?t('只读追溯管理员、操作对象与变更前后内容。','Trace administrators, targets and before/after changes.'):kind==='kyc'?t('按提交时间优先审核；资料在独立页面并排核对。','Review oldest submissions first; compare documents on a dedicated page.'):t('支持全量检索、状态与时间筛选，查看详情后保留列表位置。','Search the complete catalog and retain filters when returning from details.');
    return `<div class="admin-record-page ${finance.enabled(kind,query)?'has-finance-chart':''}" data-record-kind="${kind}">${sectionHead(t(...titles[kind]),subtitle)}${summary(kind,kind==='payouts'?catalog.filter(r=>['pending','approved'].includes(r.status)):catalog)}${finance.render(kind,data,query)}<section class="card record-table">${filters(kind,view)}<div class="record-results" role="status" aria-live="polite"><span>${t('共','')} <strong>${n(data.total)}</strong> ${t('条','records')} · ${t('显示','Showing')} ${n(data.start)}–${n(data.end)}</span><small>${t('含规模演示记录 · 示例只读','Includes read-only scale samples')}</small><button class="text-link" data-action="admin-record-export">${I('external')}${t('导出筛选结果','Export results')}</button></div>${table(columns(kind,query),data.items.map(row=>cells(kind,row,query)),t('没有符合条件的记录，试试调整筛选或搜索词。','No matches. Try changing filters or search terms.'))}${pager(kind,data)}</section></div>`;
  }
  function detailRecord(path) {
    const match=/^\/admin\/(users|kyc|purchases|payouts|audit)\/([^/]+)(?:\/payment)?$/.exec(path);
    if(!match)return null;
    const [,kind,id]=match;
    // Existing account, KYC and payout actions stay with their original controllers.
    const record=rows(kind,new URLSearchParams()).find(row=>row.id===id);
    if(!record||(!record.adminScale&&!['purchases','audit'].includes(kind)))return null;
    return {kind,row:record};
  }
  const backPath=kind=>adminRecordBackPath(route().query.get('from'),kind);
  const fields=values=>`<dl class="record-fields">${values.map(([key,value])=>`<div><dt>${key}</dt><dd>${value??'—'}</dd></div>`).join('')}</dl>`;
  function detail(data) {
    const {kind,row}=data;
    let items=[[t('记录编号','Record ID'),esc(row.id)],[t('状态','Status'),tag(row.status)],[t('记录时间 · UTC+8','Recorded · UTC+8'),stamp(row)]];
    const name=row.name||row.actor||row.id;
    let extra='';
    if(kind==='users')items.push([t('角色','Role'),esc(({normal:t('普通','Normal'),verified:t('认证','Verified'),official:t('官方','Official')})[roleOf(row.role)])],[t('显示名称','Display name'),esc(row.name)],[t('登录邮箱','Email'),esc(row.email)],[t('Plan 会员','Membership'),tag(row.subscription)],[t('Plan 剩余额度','Plan balance'),n(row.plan)],[t('Pack 余额','Pack balance'),n(row.pack)],[t('收入 Credits','Earned credits'),n(row.earned)],[t('KYC 状态','KYC status'),tag(row.kyc)]);
    else if(kind==='kyc'){
      items.push([t('申请人','Applicant'),person(row,kind)],[t('法定姓名','Legal name'),esc(row.legalName)],[t('国家 / 地区','Country / region'),esc(row.country)],[t('证件类型','Document type'),esc(({passport:t('护照','Passport'),id:t('身份证','National ID'),residence:t('居留证','Residence permit')})[row.kind]||row.kind)],[t('证件号后四位','Last four digits'),esc(row.last4)],[t('有效期','Expires'),esc(row.expires)],[t('税务声明','Tax declaration'),esc(row.tax)],[t('审核人','Reviewer'),esc(row.reviewer||'—')],[t('审核说明','Review note'),esc(row.reason||'—')]);
      extra=`<section class="card record-detail-section"><h2>${t('身份材料核对','Identity document comparison')}</h2><div class="record-identity-pair">${[t('身份证件照','Identity document'),t('手持证件自拍','Selfie holding document')].map(label=>`<div><h3>${label}</h3><div class="record-image-placeholder">${I('shield')}<strong>${row.filesDeleted?t('材料已按保留期清理','Files removed after retention period'):t('演示材料占位','Illustrative placeholder')}</strong><span>${t('未生成或保存真实证件照片','No real identity photos generated or stored')}</span></div></div>`).join('')}</div></section>`;
    } else if(kind==='purchases')items.push([t('购买用户','User'),person(row,kind)],[t('购买类型','Purchase type'),esc(row.kind==='pack'?'Pack':'Plan')],[t('金额','Amount'),usd(row.amount)],['Credits',n(row.credits)]);
    else if(kind==='payouts')items.push([t('申请人','Applicant'),person(row,kind)],[t('申请金额','Requested amount'),usd(row.credits/10000)],['Credits',n(row.credits)],[t('PayPal 收款邮箱','PayPal destination'),esc(row.email)],[t('税务声明','Tax declaration'),esc(row.tax)],[t('审核人','Reviewer'),esc(row.reviewer||'—')],[t('转账编号','Transfer ID'),esc(row.transferId||'—')],[t('手续费','Fee'),row.status==='paid'?usd(row.fee):'—'],[t('实际打款','Net paid'),row.status==='paid'?usd(row.actual):'—'],[t('结果说明','Result note'),esc(row.note||'—')]);
    else if(kind==='audit'){
      items=items.filter(([label])=>label!==t('状态','Status'));items.push([t('管理员','Administrator'),esc(row.actor)],[t('操作','Action'),esc(String(row.action).replace(/^dot\./i,'ree.'))],[t('操作对象','Target'),esc(row.target)]);
      extra=`<div class="record-diff-grid">${[[t('变更前','Before'),row.before],[t('变更后','After'),row.after]].map(([label,value])=>`<section class="card record-detail-section"><h2>${label}</h2><pre>${esc(JSON.stringify(value??null,null,2))}</pre></section>`).join('')}</div>`;
    }
    return `<div class="admin-record-detail">${sectionHead(kind==='kyc'?t('身份资料审核','Identity review'):kind==='payouts'?t('提现处理详情','Payout details'):kind==='audit'?t('审计变更详情','Audit changes'):kind==='purchases'?t('交易详情','Transaction details'):t('用户详情','User details'),esc(name))}${row.adminScale?`<div class="info-strip mb16">${I('lock')}<span>${t('规模演示记录 · 只读示例，审核、打款与账户修改仅对原有本地记录开放。','Read-only scale sample. Reviews, payments and account changes remain available for existing local records.')}</span></div>`:''}<section class="card record-detail-section"><h2>${t('记录信息','Record information')}</h2>${fields(items)}</section>${extra}</div>`;
  }
  function resolve(path,query) {
    if(!getState().admin)return null;
    const kind=path.slice(7);
    if(ADMIN_RECORD_KINDS.includes(kind))return {body:page(kind,query),key:kind,title:t(...titles[kind])};
    const found=detailRecord(path);
    if(found)return {body:detail(found),key:found.kind,title:t(...titles[found.kind])};
    if(/^\/admin\/(users|kyc|purchases|payouts|audit)\/scale-/.test(path))return {redirect:backPath(path.split('/')[2])};
    return null;
  }
  function header(path) {
    if(path==='/admin/purchases'){
      const selected=adminRecordView('purchases',route().query).tab;
      return {breadcrumbs:`<nav class="header-breadcrumbs" aria-label="${t('页面路径','Breadcrumb')}">${link('/admin/overview',t('管理后台','Console'),'')}${I('chevron')}<span aria-current="page">${t('充值与订阅','Purchases & subscriptions')}</span></nav>`,actions:`<nav class="admin-ree-inline-tabs" aria-label="${t('充值记录类型','Purchase record types')}">${[['all',t('充值交易','Transactions')],['subscriptions',t('Plan 订阅','Plan subscriptions')]].map(([tab,label])=>link(adminRecordPath('purchases',new URLSearchParams(),{tab}),label,selected===tab?'active':'',selected===tab?'aria-current="page"':'')).join('')}</nav>`,context:''};
    }
    const found=detailRecord(path);if(!found)return null;
    const back=backPath(found.kind),parentKind=back.split('/')[2].split('?')[0];
    return {breadcrumbs:`<nav class="header-breadcrumbs" aria-label="${t('页面路径','Breadcrumb')}">${link('/admin/overview',t('管理后台','Console'),'')}${I('chevron')}${link(back,t(...titles[parentKind]),'')}${I('chevron')}<span aria-current="page">${esc(found.row.name||found.row.actor||found.row.id)}</span></nav>`,actions:'',context:''};
  }
  function apply(data){const kind=document.querySelector('.admin-record-page')?.dataset.recordKind;if(kind)go(adminRecordPath(kind,route().query,Object.fromEntries(['q','status','role','membership','kyc','period','sort','size','action'].map(k=>[k,data.get(k)]))));}
  function afterRender(){
    finance.afterRender();
    observer?.disconnect();if(resize)window.removeEventListener('resize',resize);
    const root=document.querySelector('.admin-record-page');if(!root)return;
    const form=root.querySelector('#admin-record-filter'),wrap=root.querySelector('.table-wrap');
    for(const select of form.querySelectorAll('select'))select.addEventListener('change',()=>apply(new FormData(form)));
    wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label',t('记录表格，可滚动查看更多','Records table, scroll for more'));
    resize=()=>{if(!root.isConnected)return;const top=wrap.getBoundingClientRect().top+window.scrollY,foot=root.querySelector('.record-pagination').offsetHeight;root.style.setProperty('--record-table-height',Math.max(190,Math.min(800,window.innerHeight-(root.classList.contains('has-finance-chart')?Math.min(top,160):top)-foot-24))+'px');};
    observer=new ResizeObserver(resize);observer.observe(form);observer.observe(root.querySelector('.page-head'));window.addEventListener('resize',resize);requestAnimationFrame(resize);
  }
  function onSubmit(form,data){
    if(!['admin-record-filter','admin-record-jump','admin-finance-period'].includes(form.id))return false;
    if(!getState().admin){go('/admin/login');return true;}
    if(form.id==='admin-finance-period') {
      const kind=route().path.slice(7),period=data.get('period');
      if(!finance.enabled(kind,route().query))return true;
      if(period==='custom') {
        const start=data.get('start'),end=data.get('end');
        if(!validStatisticsRange(start,end)){ctx.toast(t('请选择有效的开始和结束日期','Choose valid start and end dates'));return true;}
        go(adminRecordPath(kind,route().query,{period,start,end,date:null}));
      } else {
        const date=statisticsSelectionDate(period,data.get('selection'));
        if(!date||date>reportingDate()){ctx.toast(t('请选择有效的日期','Choose a valid date'));return true;}
        go(adminRecordPath(kind,route().query,{period,date,start:null,end:null}));
      }
    } else if(form.id==='admin-record-filter')apply(data);else {const kind=route().path.slice(7);go(adminRecordPath(kind,route().query,{page:data.get('page')}));}return true;
  }
  function onAction(action){
    if(action!=='admin-record-export')return false;
    if(!getState().admin){go('/admin/login');return true;}
    const kind=route().path.slice(7);if(!ADMIN_RECORD_KINDS.includes(kind))return true;
    const data=selectAdminRecords(kind,rows(kind),route().query);
    const subscriptions=kind==='purchases'&&data.view.tab==='subscriptions';
    const headers=['ID','Name','Email','Status','Created (UTC+8)',...(kind==='audit'?['Actor','Action','Target','Before','After']:kind==='users'?['Role','Plan','Pack','Earned','KYC','Membership']:kind==='kyc'?['Country','Document last4','Tax','Reviewer']:kind==='purchases'?(subscriptions?['Membership','Plan remaining','Renewal']:['Type','USD','Credits']):['Credits','Requested USD','Fee USD','Net paid USD','Transfer ID','Reviewer','Note']),'Read-only sample'];
    const values=data.matched.map(r=>[r.id,r.name,r.email,r.status,stamp(r),...(kind==='audit'?[r.actor,String(r.action).replace(/^dot\./i,'ree.'),r.target,JSON.stringify(r.before),JSON.stringify(r.after)]:kind==='users'?[r.role,r.plan,r.pack,r.earned,r.kyc,r.subscription]:kind==='kyc'?[r.country,r.last4,r.tax,r.reviewer]:kind==='purchases'?(subscriptions?[r.status,r.plan,r.status==='active'?'on':'off']:[r.kind,r.amount,r.credits]):[r.credits,r.credits/10000,r.fee,r.actual,r.transferId,r.reviewer,r.note]),r.adminScale?'yes':'no']);
    ctx.download('re0-'+kind+'-filtered.csv','\ufeff'+[headers,...values].map(row=>row.map(value=>{let v=String(value??'');if(/^[\s]*[=+\-@]/.test(v))v="'"+v;return '"'+v.replaceAll('"','""')+'"';}).join(',')).join('\r\n'),'text/csv;charset=utf-8');ctx.toast(t('已导出全部筛选结果，共 '+n(data.total)+' 条','Exported all '+n(data.total)+' filtered records'));return true;
  }
  return {resolve,header,rows,afterRender,onSubmit,onAction};
}
