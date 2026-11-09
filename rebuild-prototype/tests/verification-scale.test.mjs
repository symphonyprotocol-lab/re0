import test from 'node:test';
import assert from 'node:assert/strict';
import {verificationDemoRequests} from '../verification-scale.js';
import {adminScaleData} from '../admin-scale.js';
import {verificationChecks,selectVerificationRequests,verificationListPath,verificationListView} from '../user-role-domain.js';
import {createUserRoles} from '../user-roles.js';
import {createRolePages} from '../role-pages.js';
const now=new Date('2026-11-01T12:00:00Z');
const query=text=>new URLSearchParams(text);
const users=new Map(adminScaleData(now).users.map(user=>[user.id,user]));
const account=id=>users.get(id);
const catalog=()=>verificationDemoRequests(now);

test('verification scale has over 1,000 unique requests, all states, and valid user/metric snapshots',()=>{
 const rows=catalog();assert.ok(rows.length>1000);assert.equal(new Set(rows.map(row=>row.id)).size,rows.length);
 assert.deepEqual([...new Set(rows.map(row=>row.status))].sort(),['approved','pending','rejected']);
 const pending=new Set();for(const row of rows){assert.ok(account(row.user));assert.ok(row.adminScale);assert.ok(verificationChecks(row.metrics).every(check=>check.passed));assert.ok(Date.parse(row.createdAt)>=Date.parse(account(row.user).created)+14*86400000);assert.ok(Date.parse(row.createdAt)<=Number(now));assert.ok(row.statement.length<=500);assert.ok(row.links.length<=3);if(row.status==='pending'){assert.ok(!pending.has(row.user));pending.add(row.user);assert.equal(account(row.user).role,'normal');}else{assert.ok(Date.parse(row.decidedAt)>=Date.parse(row.createdAt));assert.ok(Date.parse(row.decidedAt)<=Number(now));}if(row.status==='rejected')assert.ok(row.reason);}
});
test('every page size visits each matching request once, with stable boundaries',()=>{
 const rows=catalog(),before=structuredClone(rows);
 for(const status of ['all','pending','approved','rejected'])for(const size of [20,50,100]){
   const first=selectVerificationRequests(rows,query(`status=${status}&size=${size}`),account),ids=[];
   for(let page=1;page<=first.pages;page++){const result=selectVerificationRequests(rows,query(`status=${status}&size=${size}&page=${page}`),account);assert.ok(result.items.length<=size);assert.equal(result.start,(page-1)*size+1);ids.push(...result.items.map(row=>row.id));}
   assert.equal(ids.length,first.total);assert.equal(new Set(ids).size,first.total);
 }
 assert.deepEqual(rows,before);
});
test('search combines applicant, case-insensitive email, statement and request ID with status',()=>{
 const rows=catalog(),selected=rows.find(row=>row.links.length===3),user=account(selected.user);
 assert.deepEqual(selectVerificationRequests(rows,query('status=all&q='+selected.id),account).items.map(row=>row.id),[selected.id]);
 assert.deepEqual(selectVerificationRequests(rows,query('status=all&q='+encodeURIComponent(user.email.toUpperCase())),account).items.map(row=>row.id),[selected.id]);
 const combined=selectVerificationRequests(rows,query('status=rejected&q='+encodeURIComponent('知识管理')+'&size=100'),account);assert.ok(combined.total>0);assert.ok(combined.items.every(row=>row.status==='rejected'&&row.statement.includes('知识管理')));
 const names=selectVerificationRequests(rows,query('status=all&q='+encodeURIComponent('Alex Chen')+'&size=100'),account);assert.ok(names.total>20);assert.ok(names.items.every(row=>account(row.user).name.includes('Alex Chen')));
});
test('filter changes reset page; navigation and detail return preserve query/status/size/page',()=>{
 const q=query('q=知识管理&status=rejected&size=50&page=3'),path=verificationListPath(q);
 assert.deepEqual(verificationListView(query(path.split('?')[1])),verificationListView(q));
 assert.ok(verificationListPath(q,{page:4}).includes('page=4'));
 for(const patch of [{q:'技术开发'},{status:'approved'},{size:100}])assert.ok(!verificationListPath(q,patch).includes('page='));
 const encoded=new URLSearchParams({from:path});assert.equal(encoded.get('from'),path);
 assert.equal(verificationListPath(new URLSearchParams(),{status:'all'}),'/admin/verifications?status=all');
});
test('empty and out-of-range pages normalize correctly, and tied times sort by stable ID',()=>{
 const empty=selectVerificationRequests(catalog(),query('q=not-a-real-application&page=500'),account);assert.equal(empty.total,0);assert.equal(empty.view.page,1);assert.equal(empty.pages,1);assert.equal(empty.start,0);assert.equal(empty.end,0);
 const last=selectVerificationRequests(catalog(),query('status=all&page=999999&size=100'),account);assert.equal(last.view.page,last.pages);assert.equal(last.end,last.total);
 const same=[{id:'b',status:'pending',createdAt:now.toISOString()},{id:'a',status:'pending',createdAt:now.toISOString()}];assert.deepEqual(selectVerificationRequests(same,query(''),account).items.map(row=>row.id),['a','b']);
});
test('scale projection does not enter local application storage or permit review mutation',()=>{
 const state={admin:true,role:'normal',roleData:{version:1,requests:[],questions:[],feedback:[]},console:{users:[],audits:[],notices:[]}};
 let saves=0;const roles=createUserRoles({getState:()=>state,t:zh=>zh,esc:String,I:()=>'',save:()=>{saves++;return true;}}),before=structuredClone(state);
 assert.ok(roles.adminRequests().length>1000);assert.equal(roles.requests().length,0);
 const record=roles.adminRequests()[0];assert.equal(roles.review(record.id,'approved').error,'readonly');assert.equal(saves,0);assert.deepEqual(state,before);
});
test('list renders only its current page, and review header retains full list context',async()=>{
 const previous=globalThis.document;globalThis.document={addEventListener(){}};
 try{
   const state={admin:true,role:'normal',lang:'zh',dots:[],roleData:{version:1,requests:[],questions:[],feedback:[]},console:{users:[],audits:[],notices:[]}};
   const roles=createUserRoles({getState:()=>state,t:zh=>zh,esc:String,I:()=>'',save:()=>true});
   let route={path:'/admin/verifications',query:query('status=pending&q=技术开发&size=50&page=2')},destination;
   const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
   const ctx={getState:()=>state,userRoles:roles,t:zh=>zh,I:()=>'',esc,n:String,go:value=>destination=value,route:()=>route,render(){},toast(){}};
   const pages=createRolePages(ctx),data=selectVerificationRequests(roles.adminRequests(),route.query,roles.account),list=pages.admin(route.path).body;
   assert.equal((list.match(/<tr>/g)||[]).length,data.items.length+1);assert.ok(data.items.length<=50);assert.match(list,/role-review-jump/);assert.match(list,/aria-current="page"/);
   const from=verificationListPath(route.query),record=data.items[0];route={path:'/admin/verifications/'+record.id,query:new URLSearchParams({from})};
   const review=pages.admin(route.path).body,header=pages.header(route.path);assert.match(review,/只读示例/);assert.match(review,/提交时的门槛快照/);assert.ok(!review.includes('id="role-review-decision"'));assert.ok(header.breadcrumbs.includes(esc('#'+from).slice(1)));
   route={path:'/admin/verifications',query:query('status=rejected&q=研究&size=50&page=3')};
   await pages.onSubmit({id:'role-review-jump'},new FormData());assert.ok(!destination.includes('page='));
   const fields=new FormData();fields.set('page','4');await pages.onSubmit({id:'role-review-jump'},fields);assert.equal(destination,verificationListPath(route.query,{page:4}));
   route={path:'/admin/verifications',query:query('status=all&q=no-such-record&page=8')};assert.match(pages.admin(route.path).body,/暂无符合条件/);
 }finally{globalThis.document=previous;}
});
