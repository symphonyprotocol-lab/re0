import test from 'node:test';
import assert from 'node:assert/strict';
import {adminFinanceTrend,financeTimeView,createAdminFinance} from '../admin-finance.js';
import {adminFinanceEnabled,adminRecordView,adminRecordPath,adminRecordBackPath,selectAdminRecords,adminScaleData} from '../admin-scale.js';
import {createAdminRecords} from '../admin-records.js';
const now=new Date('2026-11-01T10:00:00Z'),q=value=>new URLSearchParams(value);
const total=(trend,key,field)=>trend.buckets.reduce((sum,b)=>sum+b.values[key][field],0);

test('daily finance statistics use UTC+8 boundaries and exact integer cents',()=>{
  const rows=[{id:'before',status:'paid',amount:20,created:'2026-10-30T15:59:59Z'},{id:'start',status:'paid',amount:.1,created:'2026-10-30T16:00:00Z'},{id:'second',status:'paid',amount:.2,created:'2026-10-30T16:30:00Z'},{id:'last',status:'refunded',amount:10,created:'2026-10-31T15:59:59Z'},{id:'after',status:'paid',amount:40,created:'2026-10-31T16:00:00Z'},{id:'unknown',status:'paid',amount:5,created:'—'}];
  const query=q('period=day&date=2026-10-31'),selected=selectAdminRecords('purchases',rows,query,now);
  assert.equal(selected.total,3);
  const result=adminFinanceTrend('purchases',selected.matched,selected.view,now);
  assert.equal(result.buckets.length,24);assert.equal(result.buckets[0].values.paid.count,2);
  assert.equal(result.totals.paid.cents,30);assert.equal(result.totals.refunded.cents,1000);
  assert.equal(result.buckets[23].values.refunded.count,1);assert.equal(result.missingTime,0);
});
test('weekly and monthly finance totals handle ISO years and leap days',()=>{
  const rows=[{id:'a',status:'paid',amount:10,created:'2026-12-28'},{id:'b',status:'paid',amount:20,created:'2027-01-03'},{id:'c',status:'paid',amount:30,created:'2027-01-04'}];
  const futureNow=new Date('2028-03-01T10:00:00Z');
  const week=selectAdminRecords('purchases',rows,q('period=week&date=2027-01-01'),futureNow);
  const result=adminFinanceTrend('purchases',week.matched,week.view,futureNow);
  assert.equal(result.buckets.length,7);assert.equal(result.totals.paid.count,2);assert.equal(result.totals.paid.cents,3000);
  const month=adminRecordView('purchases',q('period=month&date=2028-02-29'),futureNow);
  assert.equal(adminFinanceTrend('purchases',[],month,futureNow).buckets.length,29);
});
test('review trends only include the current pending and approved queue, not past payments',()=>{
  const rows=['pending','approved','paid','rejected','failed'].map((status,i)=>({id:String(i),status,credits:500000,created:'2026-10-30'}));
  const selected=selectAdminRecords('payouts',rows,q('period=month&date=2026-10-01'),now);
  assert.equal(selected.total,2);
  const result=adminFinanceTrend('payouts',rows,selected.view,now);
  assert.equal(result.totals.pending.count,1);assert.equal(result.totals.approved.count,1);
  assert.equal(result.totals.pending.cents,5000);assert.deepEqual(result.keys,['pending','approved']);
});
test('chart aggregation uses all matches independent of page size, search and status remain combined',()=>{
  const data=adminScaleData(now).purchases.map(r=>({...r,email:'creator@example.com'}));
  const query='q=creator&status=paid&period=month&date=2026-10-01';
  let reference;
  for(const size of [20,50,100]) {
    const result=selectAdminRecords('purchases',data,q(query+'&size='+size+'&page=2'),now);
    const trend=adminFinanceTrend('purchases',result.matched,result.view,now);
    assert.ok(result.total>100);assert.equal(trend.totals.paid.count,result.total);
    assert.equal(trend.totals.refunded.count,0);assert.equal(trend.totals.chargeback.count,0);
    assert.equal(total(trend,'paid','count'),result.total);assert.equal(total(trend,'paid','cents'),trend.totals.paid.cents);
    if(reference)assert.deepEqual(trend.totals,reference);else reference=trend.totals;
  }
});
test('custom and all-time chart buckets stay bounded and retain every dated total',()=>{
  const rows=Array.from({length:1200},(_,i)=>({id:String(i),status:'paid',amount:10,created:`${2000+i%27}-01-15`}));
  const custom=adminRecordView('purchases',q('period=custom&start=2000-01-01&end=2026-11-01'),now);
  const trend=adminFinanceTrend('purchases',rows,custom,now);
  assert.ok(trend.buckets.length<=31);assert.equal(total(trend,'paid','count'),1200);
  const all=adminFinanceTrend('purchases',rows,adminRecordView('purchases',q(''),now),now);
  assert.ok(all.buckets.length<=24);assert.equal(total(all,'paid','count'),1200);
  assert.equal(all.totals.paid.cents,1200000);
});
test('all-time statistics omit undated records explicitly and keep zero periods finite',()=>{
  const view=adminRecordView('purchases',q(''),now);
  const result=adminFinanceTrend('purchases',[{id:'legacy',status:'paid',amount:10,created:'—'}],view,now);
  assert.equal(result.missingTime,1);assert.equal(result.totals.paid.count,0);assert.ok(result.buckets.length>0);
  for(const b of result.buckets)assert.ok(Object.values(b.values).every(v=>Number.isFinite(v.cents)));
});
test('date, calendar, metric and list scope survive URL round trips and filtered detail return paths',()=>{
  const original=q('q=creator&status=paid&period=week&date=2026-10-29&size=50&page=3');
  const metric=adminRecordPath('purchases',original,{metric:'count'});
  assert.ok(metric.includes('period=week&date=2026-10-29'));assert.ok(metric.includes('metric=count'));assert.ok(metric.includes('page=3'));
  assert.equal(adminRecordBackPath(metric),metric);
  const changed=adminRecordPath('purchases',original,{date:'2026-10-20'});
  assert.ok(!changed.includes('page='));assert.ok(changed.includes('status=paid'));
  const custom=adminRecordPath('payouts',q('status=approved&period=custom&start=2026-10-30&end=2026-10-01&metric=count'));
  assert.ok(custom.includes('start=2026-10-01&end=2026-10-30'));assert.ok(custom.includes('metric=count'));
  const invalid=adminRecordView('purchases',q('period=day&date=2026-02-30'),now);assert.equal(invalid.date,'2026-11-01');
  const future=adminRecordView('purchases',q('period=month&date=2028-01-01'),now);assert.equal(future.date,'2026-11-01');
  assert.equal(adminFinanceEnabled('purchases',q('tab=subscriptions')),false);assert.equal(adminFinanceEnabled('payout-history',q('')),true);
  assert.equal(adminRecordPath('users',q('period=month&date=2026-10-01&metric=count')),'/admin/users');
});
test('legacy recent periods still filter correctly and render as the same custom calendar range',()=>{
  const result=selectAdminRecords('payouts',adminScaleData(now).payouts,q('period=30'),now);
  const time=financeTimeView(result.view,now);
  assert.equal(time.period,'custom');assert.equal(time.start,'2026-10-03');assert.equal(time.end,'2026-11-01');
  const trend=adminFinanceTrend('payouts',result.matched,result.view,now);
  assert.equal(trend.totals.pending.count+trend.totals.approved.count,result.total);
});
function renderer(){
  const state={admin:true,lang:'zh'},location={path:'/admin/purchases',query:q('status=paid&size=50&page=2')};let destination;
  const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
  const ctx={t:(zh)=>zh,esc,I:()=>'',n:v=>String(v),route:()=>location,go:path=>destination=path,getState:()=>state,actualRows:()=>[],tag:v=>String(v),table:()=>'',sectionHead:()=>'',toast:()=>{}};
  return {ctx,state,location,get destination(){return destination;}};
}
test('finance chart renders shared calendar controls and scoped, accessible series without invalid heights',()=>{
  const c=renderer(),chart=createAdminFinance(c.ctx),data=selectAdminRecords('purchases',[],q('period=week&date=2026-10-29'),now);
  const html=chart.render('purchases',data,q('period=week&date=2026-10-29'));
  assert.ok(html.includes('2026-10-26 — 2026-11-01'));assert.ok(html.includes('admin-finance-period'));
  assert.ok(html.includes('statistics-calendar-toggle'));assert.ok(html.includes('图表与下方列表共用搜索'));
  assert.ok(!html.includes('NaN'));assert.ok(!html.includes('Infinity'));assert.ok(html.includes('此时段没有符合条件的记录'));
  assert.equal(chart.render('purchases',data,q('tab=subscriptions')),'');
});
test('calendar submits update automatically with current search/status/size, custom bounds and auth intact',()=>{
  const c=renderer(),records=createAdminRecords(c.ctx);
  assert.equal(records.onSubmit({id:'admin-finance-period'},new Map([['period','month'],['selection','2026-10']])),true);
  assert.equal(c.destination,'/admin/purchases?status=paid&period=month&date=2026-10-01&size=50');
  records.onSubmit({id:'admin-finance-period'},new Map([['period','custom'],['start','2026-10-02'],['end','2026-10-08']]));
  assert.equal(c.destination,'/admin/purchases?status=paid&period=custom&start=2026-10-02&end=2026-10-08&size=50');
  const previous=c.destination;records.onSubmit({id:'admin-finance-period'},new Map([['period','custom'],['start','2026-10-08'],['end','2026-10-02']]));assert.equal(c.destination,previous);
  c.state.admin=false;records.onSubmit({id:'admin-finance-period'},new Map([['period','day'],['selection','2026-10-30']]));assert.equal(c.destination,'/admin/login');
});
test('custom calendar switching preserves the selected end date instead of jumping to today',()=>{
  const c=renderer(),query=q('period=custom&start=2026-10-01&end=2026-10-31'),data=selectAdminRecords('purchases',[],query,now);
  const html=createAdminFinance(c.ctx).render('purchases',data,query);
  assert.ok(html.includes('period=month&amp;date=2026-10-31'));
});
test('fallback display dates are not treated as reliable financial timestamps',()=>{
  const row={id:'legacy-payout',status:'pending',credits:500000,created:'2026-10-31',adminTimeUnknown:true};
  const all=selectAdminRecords('payouts',[row],q(''),now),month=selectAdminRecords('payouts',[row],q('period=month&date=2026-10-01'),now);
  assert.equal(all.total,1);assert.equal(month.total,0);
  const trend=adminFinanceTrend('payouts',all.matched,all.view,now);
  assert.equal(trend.missingTime,1);assert.equal(trend.totals.pending.count,0);
});

test('payout history plots terminal outcomes only using requested amounts and request timestamps',()=>{
  const rows=[
    {id:'paid',status:'paid',credits:1000000,actual:97.5,fee:2.5,created:'2026-10-12',paidAt:'2026-11-02T02:00:00Z'},
    {id:'failed',status:'failed',credits:500000,created:'2026-10-13'},
    {id:'rejected',status:'rejected',credits:750000,created:'2026-10-14'},
    {id:'pending',status:'pending',credits:2000000,created:'2026-10-12'},
    {id:'approved',status:'approved',credits:2500000,created:'2026-10-13'},
    {id:'undated',status:'paid',credits:500000,created:'—'},
  ];
  for(const period of ['period=day&date=2026-10-12','period=week&date=2026-10-12','period=month&date=2026-10-01','period=custom&start=2026-10-12&end=2026-10-14']){
    const data=selectAdminRecords('payout-history',rows,q(period),now),trend=adminFinanceTrend('payout-history',data.matched,data.view,now);
    assert.deepEqual(trend.keys,['paid','failed','rejected']);
    assert.equal(trend.totals.paid.cents,10000);assert.equal(trend.totals.paid.count,1);
    assert.equal(trend.totals.failed.count,period.startsWith('period=day')?0:1);
    assert.equal(trend.totals.rejected.cents,period.startsWith('period=day')?0:7500);
    for(const key of trend.keys){assert.equal(total(trend,key,'count'),trend.totals[key].count);assert.equal(total(trend,key,'cents'),trend.totals[key].cents);}
  }
  const all=selectAdminRecords('payout-history',rows,q(''),now),trend=adminFinanceTrend('payout-history',all.matched,all.view,now);
  assert.equal(all.total,6);assert.equal(trend.missingTime,1);assert.equal(trend.totals.paid.count,1);
});
test('payout history URL, calendar submissions and full-result aggregation retain their own route',()=>{
  const search='q=scale-payout&status=failed&period=month&date=2026-10-01&metric=count&size=20&page=2';
  const rows=adminScaleData(now).payouts,data=selectAdminRecords('payout-history',rows,q(search),now),trend=adminFinanceTrend('payout-history',data.matched,data.view,now);
  assert.ok(data.total>20);assert.equal(trend.totals.failed.count,data.total);assert.equal(trend.totals.paid.count,0);assert.equal(trend.totals.rejected.count,0);
  const link=adminRecordPath('payout-history',q(search),{page:3});
  assert.ok(link.startsWith('/admin/payout-history?'));assert.ok(link.includes('period=month&date=2026-10-01&metric=count'));assert.ok(link.includes('page=3'));
  assert.equal(adminRecordBackPath(link),link);
  const c=renderer();c.location.path='/admin/payout-history';c.location.query=q(search);
  createAdminRecords(c.ctx).onSubmit({id:'admin-finance-period'},new Map([['period','week'],['selection','2026-W43']]));
  assert.equal(c.destination,'/admin/payout-history?q=scale-payout&status=failed&period=week&date=2026-10-19&metric=count');
});
test('payout history chart labels all three outcomes and distinguishes empty result scope from pending requests',()=>{
  const c=renderer(),chart=createAdminFinance(c.ctx),query=q('period=week&date=2026-10-19');
  const records=[{id:'pending',status:'pending',credits:500000,created:'2026-10-20'}],data=selectAdminRecords('payout-history',records,query,now);
  const html=chart.render('payout-history',data,query);
  assert.ok(html.includes('提现记录统计'));assert.ok(html.includes('finance-paid'));assert.ok(html.includes('finance-failed'));assert.ok(html.includes('finance-rejected'));
  assert.ok(html.includes('未扣手续费'));assert.ok(html.includes('暂无已支付、支付失败或已驳回记录'));
  assert.ok(html.includes('/admin/payout-history?'));assert.ok(!html.includes('/admin/payouts?'));assert.ok(!html.includes('NaN'));
});
