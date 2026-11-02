import test from 'node:test';
import assert from 'node:assert/strict';
import {ROLE_REQUIREMENTS,roleMetrics,verificationChecks,verificationAccess,validateVerificationInput,verificationListPath,verificationListView,reeOwnerId} from '../user-role-domain.js';
import {createUserRoles} from '../user-roles.js';
import {adminRecordPath,adminRecordBackPath,selectAdminRecords,adminScaleData} from '../admin-scale.js';
import {selectDiscoveryDots} from '../discovery.js';
import {createDotStatistics,statisticsForRee} from '../dot-statistics.js';
const now=new Date('2026-11-01T08:00:00Z');
const user={id:'me',role:'normal',status:'active',createdAt:new Date(+now-14*86400000).toISOString()};
const ree={id:'r1',owner:'me',public:true,answers:9000,rating:100,knowledge:Array.from({length:5},(_,i)=>({id:'k'+i,status:'ready'}))};
function state(){return {signed:true,admin:true,role:'normal',accountCreatedAt:'2000-01-01',dots:[structuredClone(ree)],roleData:{version:1,requests:[],questions:Array.from({length:100},(_,i)=>({id:'q'+i,reeId:'r1',askerId:'other'})),feedback:Array.from({length:10},(_,i)=>({answerId:'a'+i,reeId:'r1',voterId:'other',vote:i<8?'up':'down'}))},console:{users:[],audits:[],notices:[],adminEmail:'admin@example.com'},planCredits:68120,packCredits:100000,earnedCredits:528000,welcomeCredits:0,payouts:[],entries:[]};}
function setup(s=state(),save=()=>true){let i=0;return {s,roles:createUserRoles({getState:()=>s,t:zh=>zh,esc:String,I:()=>'',uid:()=>String(++i),save})};}
const financial=s=>JSON.stringify([s.planCredits,s.packCredits,s.earnedCredits,s.welcomeCredits,s.payouts,s.entries,s.dots]);
test('all five documented threshold boundaries are inclusive, no feedback is not a passing rate',()=>{
 const s=state(),m=roleMetrics(s,user,now);assert.deepEqual(verificationChecks(m).map(c=>c.passed),Array(5).fill(true));assert.equal(m.registeredDays,14);assert.equal(m.helpfulRate,.8);assert.ok(verificationAccess(user,[],m,now).eligible);
 for(const [key,value] of [['registeredDays',13],['publicRees',0],['readySources',4],['externalQuestions',99],['helpfulRate',.79],['helpfulRate',null]])assert.equal(verificationAccess(user,[],{...m,[key]:value},now).reason,'requirements',key);
 s.roleData.feedback=[];assert.equal(roleMetrics(s,user,now).helpfulRate,null);
 assert.equal(roleMetrics(s,{...user,createdAt:new Date(+now-14*86400000+1).toISOString()},now).registeredDays,13);
 assert.equal(ROLE_REQUIREMENTS.cooldownDays,30);
});
test('metrics require attributed external activity, current public sources and current votes',()=>{
 const s=state();s.roleData.questions.push(s.roleData.questions[0],{id:'self',reeId:'r1',askerId:'me'});s.roleData.feedback.push({answerId:'self',reeId:'r1',voterId:'me',vote:'up'},{answerId:'a0',reeId:'r1',voterId:'other',vote:null});
 const m=roleMetrics(s,user,now);assert.equal(m.externalQuestions,100);assert.equal(m.feedbackCount,9);assert.equal(m.helpful,7);
 s.roleData.questions=[];s.roleData.feedback=[];assert.equal(roleMetrics(s,user,now).externalQuestions,0);assert.equal(roleMetrics(s,user,now).helpfulRate,null);
 s.dots.push({...structuredClone(ree),id:'private',public:false},{...structuredClone(ree),id:'hidden',moderated:true});assert.equal(roleMetrics(s,user,now).readySources,5);
 s.dots[0].knowledge[0].status='failed';assert.equal(roleMetrics(s,user,now).readySources,4);
 s.dots[0].public=false;assert.equal(roleMetrics(s,user,now).publicRees,0);
});
test('application validates unicode length, max three links, URL scheme and credentials',()=>{
 assert.ok(!validateVerificationInput('字'.repeat(500),['https://example.com']).error);
 assert.ok(!validateVerificationInput('😀'.repeat(500),[]).error);
 for(const statement of ['', ' '.repeat(4), '字'.repeat(501)])assert.equal(validateVerificationInput(statement,[]).error,'statement');
 for(const links of [['javascript:alert(1)'],['data:text/html,test'],['https://a:b@example.com'],['not a url'],Array(4).fill('https://example.com')])assert.equal(validateVerificationInput('申请',links).error,'links');
 assert.deepEqual(validateVerificationInput('  申请  ',['','https://example.com']).links,['https://example.com/']);
});
test('pending request blocks duplicates and rejected requests require exactly 30 days',()=>{
 const s=state(),m=roleMetrics(s,user,now);
 assert.equal(verificationAccess(user,[{user:'me',status:'pending'}],m,now).reason,'pending');
 const req={user:'me',status:'rejected',decidedAt:new Date(+now-30*86400000+1).toISOString()};assert.equal(verificationAccess(user,[req],m,now).reason,'cooldown');req.decidedAt=new Date(+now-30*86400000).toISOString();assert.ok(verificationAccess(user,[req],m,now).eligible);
 req.decidedAt=now.toISOString();req.closedByRoleChange=true;assert.ok(verificationAccess(user,[req],m,now).eligible);
 for(const role of ['verified','official'])assert.equal(verificationAccess({...user,role},[],m,now).reason,'role');
});
test('application snapshots metrics and does not change money, knowledge or fees',()=>{
 const {s,roles}=setup(),before=financial(s),result=roles.apply('持续维护公开知识',['https://example.com']);assert.equal(result.record.status,'pending');assert.equal(result.record.metrics.externalQuestions,100);s.roleData.questions.pop();assert.equal(result.record.metrics.externalQuestions,100);assert.equal(roles.apply('重复',[]).error,'pending');assert.equal(financial(s),before);
});
test('review requires an administrator and rejection reason; approval/revocation update every owned Ree mark',()=>{
 const {s,roles}=setup(),request=roles.apply('申请认证',[]).record,before=financial(s);s.admin=false;assert.equal(roles.review(request.id,'approved').error,'admin');s.admin=true;
 assert.equal(roles.review(request.id,'rejected','').error,'reason');assert.equal(request.status,'pending');assert.equal(roles.review(request.id,'approved').record.status,'approved');assert.equal(s.role,'verified');assert.match(roles.badgeForRee(ree),/认证/);assert.match(roles.badgeForRee({...ree,id:'r2'}),/认证/);
 assert.equal(roles.review(request.id,'rejected','理由').error,'stale');assert.equal(roles.changeRole('me','revoke','').error,'reason');assert.equal(roles.changeRole('me','revoke','公开内容需重新核对').role,'normal');assert.equal(roles.badgeForRee(ree),'');assert.equal(financial(s),before);assert.equal(s.console.audits.length,2);assert.ok(s.console.notices[0].text.includes('公开内容需重新核对'));
});
test('reject records user-visible explanation and cooldown; official cannot apply',()=>{
 const {s,roles}=setup(),r=roles.apply('申请',[]).record;roles.review(r.id,'rejected','请补充公开作品');assert.equal(roles.access('me').reason,'cooldown');assert.equal(r.reason,'请补充公开作品');assert.match(s.console.notices[0].text,/请补充公开作品/);
 assert.equal(roles.changeRole('me','official','平台自营').role,'official');assert.equal(roles.apply('申请',[]).error,'role');assert.equal(roles.changeRole('me','cancel-official','恢复个人账号').role,'normal');
});
test('setting official closes a pending certification request without rejection cooldown',()=>{
 const {s,roles}=setup();roles.apply('申请',[]);roles.changeRole('me','official','平台自营');assert.ok(s.roleData.requests[0].closedByRoleChange);roles.changeRole('me','cancel-official','恢复个人账号');assert.ok(roles.access('me').eligible);
 s.payouts=[{status:'pending',credits:500000}];assert.equal(roles.changeRole('me','official','平台自营').error,'payout-pending');
});
test('save failure rolls back requests, roles, notifications and audits',()=>{
 const {s,roles}=setup(state(),()=>false),before=structuredClone(s);assert.equal(roles.apply('申请',[]).error,'save');assert.deepEqual(s,before);assert.equal(roles.changeRole('me','official','原因').error,'save');assert.deepEqual(s,before);
});
test('activity ledger deduplicates questions, excludes self, handles feedback toggles',()=>{
 const {s,roles}=setup();s.roleData.questions=[];s.roleData.feedback=[];roles.recordQuestions([ree],'me','x');assert.equal(s.roleData.questions.length,0);roles.recordQuestions([ree],'other','x');roles.recordQuestions([ree],'other','x');assert.equal(s.roleData.questions.length,1);
 const m={id:'reply',dot:'r1',vote:'up'};roles.recordVote(m,'other');m.vote=null;roles.recordVote(m,'other');assert.equal(roleMetrics(s,user,now).feedbackCount,0);m.vote='down';roles.recordVote(m,'other');assert.equal(roleMetrics(s,user,now).helpfulRate,0);
});
test('role migration adds isolated role fixtures once, keeps original financial and knowledge state',()=>{
 const s=state();delete s.roleData;const before=financial(s),{roles}=setup(s);roles.ensure();const count=s.dots.length;roles.ensure();assert.equal(s.dots.length,count);assert.equal(s.console.users.filter(u=>u.roleFixture).length,5);assert.equal(roles.access('u-role-applicant').reason,'pending');assert.equal(roles.roleFor('u-role-official'),'official');assert.equal(roles.access('u-role-rejected').reason,'cooldown');assert.equal(financial({...s,dots:s.dots.filter(r=>!r.roleFixture)}),before);assert.equal(roles.changeRole('scale-user-0001','official','原因').error,'stale');
});
test('owner role comes from account identity, not a Ree field; no fallback to another user',()=>{
 const {s,roles}=setup();s.console.users=[{id:'owner',name:'Creator',role:'verified'}];const dot={owner:'Creator',role:'official'};assert.equal(reeOwnerId(s,dot),'owner');assert.equal(roles.roleForRee(dot),'verified');s.console.users[0].role='normal';assert.equal(roles.roleForRee(dot),'normal');assert.equal(roles.roleForRee({owner:'Unknown',role:'verified'}),'normal');
});
test('role, membership, KYC, account status and search combine and persist through pagination/return',()=>{
 const rows=[{id:'1',name:'test',role:'verified',subscription:'active',kyc:'verified',status:'active'},{id:'2',name:'test',role:'normal',subscription:'active',kyc:'verified',status:'active'}];
 const q=new URLSearchParams('q=test&role=verified&membership=active&kyc=verified&status=active&size=50&page=2');assert.deepEqual(selectAdminRecords('users',rows,q,now).items.map(r=>r.id),['1']);const path=adminRecordPath('users',q);assert.equal(adminRecordBackPath(path),path);assert.ok(adminRecordPath('users',q,{page:3}).includes('role=verified'));assert.ok(!adminRecordPath('users',q,{role:'normal'}).includes('page='));
 assert.equal(verificationListView(new URLSearchParams('status=all')).status,'all');const list=verificationListPath(new URLSearchParams('status=all&q=林&size=50&page=3'));assert.equal(adminRecordBackPath(list),list);assert.ok(!verificationListPath(new URLSearchParams('page=3'),{status:'rejected'}).includes('page='));
});
test('discovery role priority only breaks relevance ties and respects explicit fee sorting',()=>{
 const dots=[{id:'normal',public:true,fee:0,answers:1},{id:'official',public:true,fee:20,answers:1},{id:'verified',public:true,fee:10,answers:1}],score=d=>({normal:3,official:2,verified:2})[d.id],role=d=>d.id;
 const select=(q,sc=score)=>selectDiscoveryDots(dots,new URLSearchParams(q),sc,role).items.map(r=>r.id);
 assert.deepEqual(select('q=test'),['normal','official','verified']);assert.deepEqual(select('q=test',()=>1),['official','verified','normal']);assert.deepEqual(select('sort=free'),['normal','verified','official']);
});
test('official Ree statistics hide income on user side and keep it for admin inspection',()=>{
 const s=state();s.entries=[{id:'income',type:'income',dotId:'r1',title:'private-income',amount:999}];const ctx={getState:()=>s,userRoles:{roleFor:()=> 'official'},t:zh=>zh,I:()=>'',esc:String,n:String,title:()=> 'Ree',shell:x=>x,footer:()=>'',go:()=>{}};const data=statisticsForRee(s,s.dots[0]);
 const html=createDotStatistics(ctx).page(data,new URLSearchParams('view=income'));assert.doesNotMatch(html,/private-income|value="income"|已记录查询收入/);assert.match(html,/仅在管理后台查看/);
 const admin=createDotStatistics(ctx,{allowOfficialIncome:true}).page(data,new URLSearchParams('view=income'));assert.match(admin,/private-income/);assert.equal(s.entries[0].amount,999);
});
