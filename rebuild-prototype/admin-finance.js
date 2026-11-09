import {adminFinanceEnabled, adminRecordTime, adminRecordPath} from './admin-scale.js';
import {reportingDate, statisticsPeriod, statisticsFilterRange, recentStatisticsRange} from './statistics-time.js';
import {createStatisticsPeriodControls} from './statistics-period.js';

const DAY=86400000;
const SERIES={purchases:['paid','refunded','chargeback'],payouts:['pending','approved'],'payout-history':['paid','failed','rejected']};
export function financeTimeView(view,now=new Date()) {
  const recent=recentStatisticsRange(Number(view.period),now);
  return recent?{...view,period:'custom',start:recent.start,end:recent.end,date:recent.end}:view;
}
// Amounts use integer USD cents; no balances, fees or transaction states are changed.
// Input records are the complete matching list, before pagination.
export function adminFinanceTrend(kind,records,view,now=new Date()) {
  const keys=SERIES[kind]||[],f=financeTimeView(view,now);
  const eligible=records.filter(row=>keys.includes(row.status));
  const dated=eligible.map(row=>({row,time:adminRecordTime(row)})).filter(item=>item.time!==null);
  let range=statisticsFilterRange(f),step=DAY,months=0;
  if(!range) {
    const today=statisticsPeriod('day',reportingDate(now));
    const first=dated.length?Math.min(...dated.map(item=>item.time)):today.start;
    const last=dated.length?Math.max(today.end,...dated.map(item=>item.time+1)):today.end;
    range={start:statisticsPeriod('month',reportingDate(new Date(first))).start,end:last};
    const a=reportingDate(new Date(range.start)),b=reportingDate(new Date(range.end-1));
    months=Math.max(1,Math.ceil(((Number(b.slice(0,4))-Number(a.slice(0,4)))*12+Number(b.slice(5,7))-Number(a.slice(5,7))+1)/24));
  } else step=f.period==='day'?3600000:f.period==='custom'?Math.max(1,Math.ceil((range.end-range.start)/DAY/31))*DAY:DAY;
  const empty=()=>Object.fromEntries(keys.map(key=>[key,{count:0,cents:0}]));
  const buckets=[];
  for(let start=range.start;start<range.end;) {
    let end;
    if(months){const date=new Date(reportingDate(new Date(start)).slice(0,7)+'-01T00:00:00+08:00');const local=new Date(Number(date)+8*3600000);local.setUTCMonth(local.getUTCMonth()+months);end=Number(local)-8*3600000;}
    else end=start+step;
    buckets.push({start,end:Math.min(end,range.end),values:empty()});start=end;
  }
  const totals=empty();let missingTime=eligible.length-dated.length;
  for(const {row,time} of dated) {
    const bucket=buckets.find(bucket=>time>=bucket.start&&time<bucket.end);
    if(!bucket)continue;
    const raw=kind==='purchases'?Number(row.amount):Number(row.credits)/10000;
    const cents=Number.isFinite(raw)?Math.max(0,Math.round(raw*100)):0;
    bucket.values[row.status].count++;bucket.values[row.status].cents+=cents;
    totals[row.status].count++;totals[row.status].cents+=cents;
  }
  return {keys,buckets,totals,missingTime,range,grouping:months?'month':f.period==='day'?'hour':step>DAY?'range':'day',stepMonths:months,stepDays:step/DAY};
}
export function createAdminFinance(ctx) {
  const {t,esc,n}=ctx,periods=createStatisticsPeriodControls(ctx);

  const usd=cents=>'$'+(cents/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  function render(kind,data,query) {
    if(!adminFinanceEnabled(kind,query))return '';
  const labels={paid:t('已支付','Paid'),refunded:t('已退款','Refunded'),chargeback:t('拒付','Chargeback'),pending:t('待审核','Pending review'),approved:t('待人工打款','Awaiting payment'),failed:t('支付失败','Payment failed'),rejected:t('已驳回','Rejected')};
    const f=data.view,time=financeTimeView(f),trend=adminFinanceTrend(kind,data.matched,f);
    const count=f.metric==='count',field=count?'count':'cents';
    const value=v=>count?n(v)+t(' 笔',' records'):usd(v);
    const total=trend.keys.reduce((sum,key)=>sum+trend.totals[key][field],0);
    const peak=Math.max(1,...trend.buckets.map(bucket=>Math.max(...trend.keys.map(key=>bucket.values[key][field]))));
    const max=Math.max(2,Math.ceil(peak/2)*2);
    const bucketLabel=b=>trend.grouping==='hour'?String(new Date(b.start+8*3600000).getUTCHours()).padStart(2,'0')+':00':trend.grouping==='month'?reportingDate(new Date(b.start)).slice(0,7)+(trend.stepMonths>1?' — '+reportingDate(new Date(b.end-1)).slice(0,7):''):reportingDate(new Date(b.start))+(trend.stepDays>1?' — '+reportingDate(new Date(b.end-1)):'');
    const axis=(b,i)=>{const label=bucketLabel(b),last=i===trend.buckets.length-1;return trend.grouping==='hour'?(i%4===0||last?label.slice(0,2):''):trend.grouping==='month'?label:trend.buckets.length<=8?label.slice(5):i%5===0||last?label.slice(5):'';};
    const grouping=trend.grouping==='hour'?t('按小时汇总','Hourly totals'):trend.grouping==='month'?trend.stepMonths>1?t(`每 ${trend.stepMonths} 个月汇总`,`Totals every ${trend.stepMonths} months`):t('按月汇总','Monthly totals'):trend.stepDays>1?t(`每 ${trend.stepDays} 天汇总`,`Totals every ${trend.stepDays} days`):t('按天汇总','Daily totals');
    const name=kind==='purchases'?t('充值交易统计','Purchase statistics'):kind==='payout-history'?t('提现记录统计','Payout history statistics'):t('提现审核统计','Payout review statistics');
    const metricNav=`<nav class="finance-metric" aria-label="${t('图表指标','Chart metric')}">${[['amount',t('金额','Amount')],['count',t('笔数','Count')]].map(([metric,label])=>`<a href="#${esc(adminRecordPath(kind,query,{metric}))}" ${f.metric===metric?'aria-current="true"':''}>${label}</a>`).join('')}</nav>`;
    const controls=periods.render(time,patch=>adminRecordPath(kind,query,{date:time.date,...patch}),{id:'admin-finance-period'});
    const bars=trend.buckets.map((bucket,i)=>{
      const label=bucketLabel(bucket),description=label+' · '+trend.keys.map(key=>labels[key]+' '+value(bucket.values[key][field])+(count?'':' ('+n(bucket.values[key].count)+t(' 笔',' records')+')')).join(' · ');
      return `<div class="finance-bucket" role="listitem" tabindex="0" aria-label="${esc(description)}" title="${esc(description)}" data-finance-description="${esc(description)}"><div class="finance-column-group">${trend.keys.map(key=>`<i class="finance-column finance-${key}" style="--bar-height:${bucket.values[key][field]/max*100}%"></i>`).join('')}</div><span class="finance-axis-label">${esc(axis(bucket,i))}</span></div>`;
    }).join('');
    const note=kind==='payout-history'?t('仅统计已支付、支付失败和已驳回的记录；按申请时间及当前结果归类，金额为申请金额（未扣手续费），不代表实际打款日期。','Paid, failed and rejected requests only, grouped by request time and current result. Amounts are requested amounts before fees, not net payments or payment-date totals.'):kind==='purchases'?t('按交易创建时间与当前状态统计；退款、拒付归入原交易日期，不代表退款发生时间。','Grouped by transaction creation time and current status. Refunds and chargebacks use the original transaction date.'):t('仅统计当前待审核与待人工打款申请，按申请时间归类，不代表审核发生时间。','Current pending and approved requests only, grouped by request time, not review time.');
    return `<section class="card admin-finance" aria-label="${name}"><div class="finance-heading"><div><h2>${name}</h2><p>${grouping} · ${t('图表与下方列表共用搜索、状态和时间条件','Chart and list share search, status and time filters')}</p></div>${metricNav}</div>${controls}<div class="finance-legend">${trend.keys.map(key=>`<div><span class="finance-key finance-${key}"></span><span>${labels[key]}</span><strong>${usd(trend.totals[key].cents)}</strong><small>${n(trend.totals[key].count)} ${t('笔','records')}</small></div>`).join('')}</div><div class="finance-plot" aria-label="${t('金额或笔数趋势','Amount or count trend')}"><div class="finance-y-axis"><span>${value(max)}</span><span>${value(Math.round(max/2))}</span><span>${value(0)}</span></div><div class="finance-bars" role="list" aria-label="${name+' · '+(count?t('笔数','Count'):t('金额','Amount'))}">${bars}</div></div><p class="finance-inspection" aria-live="polite">${total? t('悬停或聚焦柱形查看明细','Hover or focus a bar to inspect details'):(kind==='payout-history'?t('此时段暂无已支付、支付失败或已驳回记录','No paid, failed or rejected records in this period'):t('此时段没有符合条件的记录','No matching records in this period'))}</p><p class="finance-note">${note}${trend.missingTime?' '+t(`${n(trend.missingTime)} 条记录缺少准确时间，未计入图表。`,`${n(trend.missingTime)} records lack exact timestamps and are omitted from the chart.`):''}</p></section>`;
  }
  function afterRender() {
    const root=document.querySelector('.admin-finance');if(!root)return;
    const inspect=element=>{root.querySelector('.finance-inspection').textContent=element.dataset.financeDescription;root.querySelectorAll('.finance-bucket.is-inspected').forEach(el=>el.classList.remove('is-inspected'));element.classList.add('is-inspected');};
    root.querySelectorAll('.finance-bucket').forEach(el=>{el.addEventListener('pointerenter',()=>inspect(el));el.addEventListener('focus',()=>inspect(el));});
  }
  return {render,afterRender,enabled:adminFinanceEnabled};
}
