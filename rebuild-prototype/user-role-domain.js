import {recordTime} from './statistics-time.js';
export const USER_ROLES=['normal','verified','official'];
export const ROLE_REQUIREMENTS=Object.freeze({registeredDays:14,publicRees:1,readySources:5,externalQuestions:100,helpfulRate:.8,cooldownDays:30,maxStatement:500,maxLinks:3});
export const roleOf=value=>USER_ROLES.includes(value)?value:'normal';
export const rolePriority=value=>({normal:0,verified:1,official:2})[roleOf(value)];
export const sampleUserRole=index=>index%13===0?'official':index%4===0?'verified':'normal';
export function reeOwnerId(state,ree){
  if(!ree)return null;
  if(ree.owner==='me'||ree.ownerId==='me')return 'me';
  if(ree.ownerId)return ree.ownerId;
  const u=(state.console?.users||[]).find(u=>u.id===ree.owner||u.email===ree.ownerEmail||u.name===ree.owner);
  if(u)return u.id;
  const sample=/^知识创作者 (\d+)$/.exec(ree.owner||'');
  return sample?'discovery-owner-'+sample[1]:null;
}
export function roleMetrics(state,user,now=new Date()){
  const id=user.id,created=recordTime({createdAt:user.createdAt||user.created});
  const rees=(state.dots||[]).filter(r=>reeOwnerId(state,r)===id&&r.public&&!r.moderated);
  const ids=new Set(rees.map(r=>r.id));
  const readySources=rees.reduce((sum,ree)=>sum+new Set((ree.knowledge||[]).filter(k=>k.status==='ready').map(k=>k.id)).size,0);
  // Historical answer totals/ratings do not prove who asked or how many feedbacks exist.
  const baseline=rees.reduce((m,r)=>{if(r.roleFixture){m.questions+=r.verificationBaseline?.externalQuestions||0;m.up+=r.verificationBaseline?.helpful||0;m.down+=r.verificationBaseline?.unhelpful||0;}return m;},{questions:0,up:0,down:0});
  const questions=new Set((state.roleData?.questions||[]).filter(e=>ids.has(e.reeId)&&e.askerId&&e.askerId!==id).map(e=>e.id));
  const feedback=new Map();
  for(const e of state.roleData?.feedback||[])if(ids.has(e.reeId)&&e.voterId!==id&&e.voterId)feedback.set(e.answerId,e);
  const votes=[...feedback.values()],up=baseline.up+votes.filter(e=>e.vote==='up').length,down=baseline.down+votes.filter(e=>e.vote==='down').length;
  return {registeredDays:created===null?null:Math.max(0,Math.floor((Number(now)-created)/86400000)),publicRees:rees.length,readySources,externalQuestions:baseline.questions+questions.size,helpful:up,unhelpful:down,feedbackCount:up+down,helpfulRate:up+down?up/(up+down):null};
}
export function verificationChecks(metrics){return ['registeredDays','publicRees','readySources','externalQuestions','helpfulRate'].map(key=>({key,value:metrics[key],target:ROLE_REQUIREMENTS[key],passed:metrics[key]!==null&&Number.isFinite(metrics[key])&&metrics[key]>=ROLE_REQUIREMENTS[key]}));}
export function verificationAccess(user,requests,metrics,now=new Date()){
  const own=requests.filter(r=>r.user===user.id),pending=own.find(r=>r.status==='pending');
  const rejected=own.filter(r=>r.status==='rejected'&&!r.closedByRoleChange&&r.decidedAt).sort((a,b)=>Date.parse(b.decidedAt)-Date.parse(a.decidedAt))[0];
  const retryAt=rejected?new Date(Date.parse(rejected.decidedAt)+ROLE_REQUIREMENTS.cooldownDays*86400000).toISOString():null;
  const reason=user.status==='disabled'?'disabled':roleOf(user.role)!=='normal'?'role':pending?'pending':retryAt&&Date.parse(retryAt)>Number(now)?'cooldown':verificationChecks(metrics).some(c=>!c.passed)?'requirements':null;
  return {eligible:!reason,reason,pending,retryAt:reason==='cooldown'?retryAt:null};
}
export function validateVerificationInput(statement,links){
  statement=String(statement||'').trim();
  if(!statement||Array.from(statement).length>ROLE_REQUIREMENTS.maxStatement)return {error:'statement'};
  const values=links.map(v=>String(v).trim()).filter(Boolean);
  if(values.length>ROLE_REQUIREMENTS.maxLinks)return {error:'links'};
  const normalized=[];
  for(const value of values){try{const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||!u.hostname||u.username||u.password||u.href.length>2048)return {error:'links'};normalized.push(u.href);}catch{return {error:'links'};}}
  return {statement,links:normalized};
}
export function verificationListView(query){const size=Number(query.get('size')),page=Number(query.get('page'));return {q:(query.get('q')||'').trim().slice(0,400),status:['all','approved','rejected'].includes(query.get('status'))?query.get('status'):'pending',size:[20,50,100].includes(size)?size:20,page:Number.isFinite(page)&&page>0?Math.min(100000,Math.floor(page)):1};}
export function verificationListPath(query=new URLSearchParams(),changes={}){const next=new URLSearchParams(query);for(const [key,value] of Object.entries(changes))value===null||value===''?next.delete(key):next.set(key,String(value));if(['q','status','size'].some(k=>k in changes))next.delete('page');const f=verificationListView(next),result=new URLSearchParams();if(f.q)result.set('q',f.q);if(f.status!=='pending')result.set('status',f.status);if(f.size!==20)result.set('size',f.size);if(f.page>1)result.set('page',f.page);return '/admin/verifications'+(result.size?'?'+result:'');}

export function selectVerificationRequests(records, query, account) {
  const view = verificationListView(query), needle = view.q.toLocaleLowerCase();
  const matched = records.filter(record => {
    if (view.status !== 'all' && record.status !== view.status) return false;
    if (!needle) return true;
    const user = account(record.user);
    return [record.id,user?.name,user?.email,record.statement].join(' ').toLocaleLowerCase().includes(needle);
  }).sort((a,b) => {
    const order = Date.parse(a.createdAt)-Date.parse(b.createdAt);
    return (view.status==='pending'?order:-order) || String(a.id).localeCompare(String(b.id));
  });
  const total=matched.length,pages=Math.max(1,Math.ceil(total/view.size));
  view.page=Math.min(view.page,pages);
  const offset=(view.page-1)*view.size;
  return {view,total,pages,start:total?offset+1:0,end:Math.min(offset+view.size,total),items:matched.slice(offset,offset+view.size)};
}
