import test from 'node:test';
import assert from 'node:assert/strict';
import {ADMIN_RECORD_KINDS, ADMIN_SCALE_COUNTS, adminScaleData, adminRecordTime, adminRecordView, adminRecordPath, adminRecordBackPath, selectAdminRecords} from '../admin-scale.js';
import {createAdminRecords} from '../admin-records.js';
const query=value=>new URLSearchParams(value);
const now=new Date('2026-11-01T10:00:00Z');
const fixture=()=>adminScaleData(now);

test('every requested catalog exceeds 1,000, with unique IDs and resolvable user references',()=>{
  const data=fixture(),ids=new Set(data.users.map(r=>r.id));
  for(const kind of ADMIN_RECORD_KINDS){
    const records=kind==='payouts'?data.payouts.filter(r=>['pending','approved'].includes(r.status)):kind==='payout-history'?data.payouts:data[kind];
    assert.equal(records.length,ADMIN_SCALE_COUNTS[kind]);assert.ok(records.length>1000);
    assert.equal(new Set(records.map(r=>r.id)).size,records.length);
    assert.ok(records.every(r=>r.adminScale));
    assert.ok(records.every(r=>!r.user||ids.has(r.user)));
  }
});
test('stable pagination visits the complete catalog exactly once for all three sizes',()=>{
  const records=fixture().payouts,before=structuredClone(records);
  for(const size of [20,50,100]){
    const first=selectAdminRecords('payout-history',records,query('size='+size),now),seen=[];
    for(let page=1;page<=first.pages;page++){
      const result=selectAdminRecords('payout-history',records,query(`size=${size}&page=${page}`),now);
      assert.ok(result.items.length<=size);seen.push(...result.items.map(r=>r.id));
    }
    assert.equal(seen.length,2400);assert.equal(new Set(seen).size,2400);
  }
  assert.deepEqual(records,before);
});
test('filters operate on the full catalog before pagination and clamp empty or out-of-range pages',()=>{
  const data=fixture(),found=selectAdminRecords('users',data.users,query('q=1200&page=200'),now);
  assert.equal(found.total,1);assert.equal(found.view.page,1);assert.equal(found.items[0].id,'scale-user-1200');
  const empty=selectAdminRecords('users',data.users,query('q=does-not-exist&page=99'),now);
  assert.equal(empty.start,0);assert.equal(empty.end,0);assert.equal(empty.pages,1);assert.equal(empty.items.length,0);
  assert.ok(selectAdminRecords('payouts',data.payouts,query('status=approved'),now).matched.every(r=>r.status==='approved'));
});
test('recent-date filters use UTC+8 inclusive calendar days and omit unknown dates',()=>{
  const rows=[{id:'start',created:'2026-10-25T16:00:00Z'},{id:'before',created:'2026-10-25T15:59:59Z'},{id:'last',created:'2026-11-01T15:59:59Z'},{id:'future',created:'2026-11-01T16:00:00Z'},{id:'unknown',created:'—'}];
  assert.deepEqual(selectAdminRecords('users',rows,query('period=7'),now).items.map(r=>r.id),['last','start']);
  assert.equal(selectAdminRecords('users',rows,query(''),now).total,5);
  assert.equal(adminRecordTime({created:'2026-10-31 09:30'}),Date.parse('2026-10-31T09:30:00+08:00'));
});
test('review queues default to oldest first; records can sort by amount independently of page',()=>{
  const data=fixture(),result=selectAdminRecords('payouts',data.payouts,query('size=100'),now);
  assert.equal(result.total,1200);assert.equal(result.view.sort,'oldest');
  assert.ok(result.items.every((r,i,a)=>i===0||adminRecordTime(a[i-1])<=adminRecordTime(r)));
  const amounts=selectAdminRecords('payout-history',data.payouts,query('sort=amount-high'),now).items.map(r=>r.credits);
  assert.ok(amounts.every((v,i)=>!i||amounts[i-1]>=v));
});
test('audit action filter understands legacy Ree event codes and matches translated labels',()=>{
  const rows=[{id:'legacy',action:'dot.takedown',actionLabel:'下架 Ree'},{id:'current',action:'ree.takedown'},{id:'other',action:'user.disable'}];
  assert.equal(selectAdminRecords('audit',rows,query('action=ree.takedown'),now).total,2);
  assert.equal(selectAdminRecords('audit',rows,query('q=下架'),now).items[0].id,'legacy');
});
test('filter URLs reset pagination, preserve the other filters and reject unsafe return targets',()=>{
  assert.equal(adminRecordPath('payouts',query('status=approved&size=50&page=7'),{period:'30'}),'/admin/payouts?status=approved&period=30&size=50');
  assert.equal(adminRecordPath('audit',query('page=9'),{action:'ree.takedown'}),'/admin/audit?action=ree.takedown');
  assert.equal(adminRecordBackPath('/admin/kyc?status=pending&size=100&page=3'),'/admin/kyc?status=pending&size=100&page=3');
  for(const invalid of ['https://example.com','//example.com','/admin/users/u-lin','/admin/users#escape'])assert.equal(adminRecordBackPath(invalid),'/admin/users');
  assert.equal(adminRecordView('users',query('size=5000&page=-1&sort=bad&status=paid')).size,20);
});
function controller(path='/admin/users',search=''){
  let location={path,query:query(search)},output;
  const state={admin:true,lang:'zh'},realUser={id:'real-user',name:'Real','email':'real@example.com',status:'active',subscription:'active',created:'2026-11-01'};
  const actual={users:[realUser],purchases:[{id:'real-txn',user:realUser.id,status:'paid',kind:'plan',amount:10,credits:100000,created:'2026-11-01'}],audit:[{id:'real-audit',action:'dot.takedown',actor:'real@example.com',target:'mine',before:{x:'=test'},after:{x:'<script>'},created:'2026-11-01 12:00'}]};
  const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const api=createAdminRecords({t:zh=>zh,I:()=>'<svg></svg>',esc,n:v=>Number(v).toLocaleString('en-US'),route:()=>location,go:()=>{},tag:s=>`<span>${esc(s)}</span>`,sectionHead:(h,p)=>`<h1>${h}</h1><p>${p}</p>`,table:(heads,rows)=>`<table><thead>${heads.join('|')}</thead><tbody>${rows.map(c=>'<tr>'+c.map(v=>'<td>'+v+'</td>').join('')+'</tr>').join('')}</tbody></table>`,getState:()=>state,actualRows:kind=>actual[kind]||[],download:(name,text,type)=>{output={name,text,type};},toast:()=>{}});
  return {api,state,actual,setRoute:(path,search='')=>location={path,query:query(search)},getOutput:()=>output};
}
test('six list renderers bound the DOM and do not persist catalogs or mutate existing records',()=>{
  const c=controller(),before=structuredClone(c.actual);
  for(const kind of ADMIN_RECORD_KINDS){c.setRoute('/admin/'+kind);const result=c.api.resolve('/admin/'+kind,query(''));assert.equal((result.body.match(/<tr>/g)||[]).length,20);assert.ok(result.body.includes('admin-record-jump'));assert.ok(result.body.includes('value="100"'));}
  assert.deepEqual(c.actual,before);assert.deepEqual(c.state,{admin:true,lang:'zh'});
  c.state.admin=false;assert.equal(c.api.resolve('/admin/users',query('')),null);
});
test('sample details stay read-only, preserve exact list context and escape audit payloads',()=>{
  const c=controller('/admin/kyc/scale-kyc-0001','from='+encodeURIComponent('/admin/kyc?status=pending&size=50&page=2'));
  const detail=c.api.resolve('/admin/kyc/scale-kyc-0001',query(''));
  assert.ok(detail.body.includes('record-identity-pair'));assert.ok(detail.body.includes('只读示例'));assert.ok(!detail.body.includes('<form'));
  assert.ok(c.api.header('/admin/kyc/scale-kyc-0001').breadcrumbs.includes('/admin/kyc?status=pending&amp;size=50&amp;page=2'));
  assert.ok(detail.body.includes('from=%2Fadmin%2Fkyc%3Fstatus%3Dpending%26size%3D50%26page%3D2'));
  assert.ok(!detail.body.includes('from=%2Fadmin%2Fkyc%2Fscale-kyc'));
  c.setRoute('/admin/audit/real-audit');const audit=c.api.resolve('/admin/audit/real-audit',query(''));
  assert.ok(audit.body.includes('&lt;script&gt;'));assert.ok(audit.body.includes('ree.takedown'));assert.ok(!audit.body.includes('dot.takedown'));
});
test('real mutable user/KYC/payout details remain under their original controllers',()=>{
  const c=controller();assert.equal(c.api.resolve('/admin/users/real-user',query('')),null);
  c.setRoute('/admin/users');assert.ok(c.api.rows('users').some(r=>r.id==='real-user'&&!r.adminScale));
});
test('CSV exports all matching records, beyond the visible page, and neutralizes formula cells',()=>{
  const c=controller('/admin/purchases','size=20&status=paid');
  assert.equal(c.api.onAction('admin-record-export'),true);
  const csv=c.getOutput().text;const expected=c.api.rows('purchases').filter(r=>r.status==='paid').length;
  assert.equal(csv.split('\r\n').length,expected+1);assert.ok(expected>20);
  c.setRoute('/admin/audit','q=real@example.com');c.actual.audit[0].actor='=formula-real@example.com';
  c.api.onAction('admin-record-export');assert.ok(c.getOutput().text.includes("'=formula-real@example.com"));
  c.state.admin=false;const last=c.getOutput();c.api.onAction('admin-record-export');assert.equal(c.getOutput(),last);
});
test('subscriptions reuse the same full-catalog paging and live tabs stay in the main header',()=>{
  const c=controller('/admin/purchases','tab=subscriptions&size=100&page=2'),q=query('tab=subscriptions&size=100&page=2');
  assert.equal(c.api.rows('purchases',q).length,1201);
  const result=c.api.resolve('/admin/purchases',q);assert.equal((result.body.match(/<tr>/g)||[]).length,100);
  assert.ok(!result.body.includes('record-tabs'));assert.ok(c.api.header('/admin/purchases').actions.includes('Plan 订阅'));
});

test('user membership and KYC combine with account status and search before every page',()=>{
  const rows=fixture().users,before=structuredClone(rows);
  const criteria='q=creator-&status=active&membership=active&kyc=verified';
  const expected=rows.filter(r=>r.email.includes('creator-')&&r.status==='active'&&r.subscription==='active'&&r.kyc==='verified');
  const first=selectAdminRecords('users',rows,query(criteria),now),seen=[];
  assert.ok(expected.length>20);assert.equal(first.total,expected.length);
  for(let page=1;page<=first.pages;page++){
    const result=selectAdminRecords('users',rows,query(criteria+'&page='+page),now);
    assert.equal(result.total,expected.length);assert.ok(result.items.length<=20);
    seen.push(...result.items.map(r=>r.id));
  }
  assert.equal(new Set(seen).size,expected.length);
  assert.deepEqual(new Set(seen),new Set(expected.map(r=>r.id)));
  assert.deepEqual(rows,before);
  assert.equal(selectAdminRecords('users',rows,query('status=disabled&membership=expired&kyc=verified'),now).total,0);
});
test('each membership and KYC status is independently selectable, including missing KYC as not submitted',()=>{
  const rows=fixture().users;
  for(const membership of ['active','cancelled','expired']){
    const data=selectAdminRecords('users',rows,query('membership='+membership),now);
    assert.ok(data.total>0);assert.ok(data.matched.every(r=>r.subscription===membership));
  }
  for(const kyc of ['none','pending','verified','rejected','reset']){
    const data=selectAdminRecords('users',rows,query('kyc='+kyc),now);
    assert.ok(data.total>0);assert.ok(data.matched.every(r=>r.kyc===kyc));
  }
  assert.equal(selectAdminRecords('users',[{id:'legacy'}],query('kyc=none'),now).total,1);
  assert.equal(selectAdminRecords('users',[{id:'processing',kyc:'processing'}],query('kyc=processing'),now).total,1);
});
test('user filter URLs survive page changes, return paths and refresh normalization',()=>{
  const original=query('q=Alex&status=active&membership=cancelled&kyc=pending&period=90&size=50&page=3');
  const next=adminRecordPath('users',original,{page:4});
  assert.equal(next,'/admin/users?q=Alex&status=active&membership=cancelled&kyc=pending&period=90&size=50&page=4');
  assert.equal(adminRecordBackPath(next),next);
  assert.equal(adminRecordPath('users',query(next.split('?')[1])),next);
  assert.equal(adminRecordPath('users',original,{membership:'active'}),'/admin/users?q=Alex&status=active&membership=active&kyc=pending&period=90&size=50');
  assert.equal(adminRecordPath('users',original,{kyc:'all'}),'/admin/users?q=Alex&status=active&membership=cancelled&period=90&size=50');
  assert.equal(adminRecordPath('users',query('membership=invalid&kyc=invalid')),'/admin/users');
  assert.equal(adminRecordPath('payouts',query('membership=active&kyc=verified')),'/admin/payouts');
});
test('user list controls and detail breadcrumbs restore combined filters, and exports use the same scope',()=>{
  const filters='q=creator-&status=active&membership=active&kyc=verified&page=2';
  const c=controller('/admin/users',filters),list=c.api.resolve('/admin/users',query(filters));
  assert.ok(list.body.includes('aria-label="会员状态筛选"'));assert.ok(list.body.includes('aria-label="KYC 状态筛选"'));
  assert.ok(list.body.includes('name="membership"'));assert.ok(list.body.includes('name="kyc"'));
  assert.ok(list.body.includes('membership%3Dactive%26kyc%3Dverified%26page%3D2'));
  c.setRoute('/admin/users/scale-user-0001','from='+encodeURIComponent('/admin/users?'+filters));
  const header=c.api.header('/admin/users/scale-user-0001');
  assert.ok(header.breadcrumbs.includes('membership=active&amp;kyc=verified&amp;page=2'));
  c.setRoute('/admin/users',filters);c.api.onAction('admin-record-export');
  const data=c.api.rows('users'),expected=data.filter(r=>r.email?.includes('creator-')&&r.status==='active'&&r.subscription==='active'&&r.kyc==='verified');
  const csv=c.getOutput().text;assert.equal(csv.split('\r\n').length,expected.length+1);
  for(const record of expected)assert.ok(csv.includes('"'+record.id+'"'));
  assert.ok(!csv.includes('"scale-user-0001"'));
});
