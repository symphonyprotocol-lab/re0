import {roleOf,roleMetrics,reeOwnerId,verificationAccess,validateVerificationInput,sampleUserRole} from './user-role-domain.js';
import {verificationDemoRequests} from './verification-scale.js';
import {adminScaleData} from './admin-scale.js';

export function createUserRoles(ctx){
  const {t,esc,I}=ctx,S=ctx.getState;
  function account(id='me'){
    const s=S();
    if(id==='me')return {id,name:s.displayName||'Yu Zhao',email:s.loginIdentity?.email||s.email||'yu@example.com',created:s.accountCreatedAt||'2026-10-24',status:s.disabled?'disabled':'active',role:roleOf(s.role),roleChangedAt:s.roleChangedAt};
    const u=s.console?.users?.find(u=>u.id===id);if(u)return {...u,role:roleOf(u.role)};
    const match=/^scale-user-(\d{4})$/.exec(id);return match?adminScaleData().users[Number(match[1])-1]:null;
  }
  const roleFor=id=>roleOf(account(id)?.role);
  const roleForRee=ree=>{const id=reeOwnerId(S(),ree);return id?.startsWith('discovery-owner-')?sampleUserRole(Number(id.slice(16))):roleFor(id);};
  const label=role=>({normal:t('普通','Normal'),verified:t('认证','Verified'),official:t('官方','Official')})[roleOf(role)];
  function badge(role,normal=false){role=roleOf(role);if(role==='normal'&&!normal)return '';return `<span class="role-badge role-${role}" title="${t('账号角色：','Account role: ')+label(role)}">${role==='normal'?'':I(role==='official'?'globe':'shield')}${label(role)}</span>`;}
  const badgeForRee=ree=>badge(roleForRee(ree));
  const requests=()=>S().roleData?.requests||[];
  const adminRequests=()=>[...requests(),...verificationDemoRequests()];
  const metrics=id=>roleMetrics(S(),account(id)||{id},new Date());
  const access=id=>verificationAccess(account(id)||{id,status:'disabled'},requests(),metrics(id));
  function audit(action,id,before,after){S().console.audits.unshift({id:ctx.uid(),actor:S().console.adminEmail,action,target:id,before,after,created:new Date().toISOString()});}
  function commit(operation){
    const s=S(),snapshot={role:s.role,roleTimestampPresent:Object.hasOwn(s,"roleChangedAt"),roleChangedAt:s.roleChangedAt,roleData:structuredClone(s.roleData),users:structuredClone(s.console.users),audits:structuredClone(s.console.audits),notices:structuredClone(s.console.notices)};
    const result=operation();if(result.error)return result;
    if(ctx.save()===false){s.role=snapshot.role;s.roleChangedAt=snapshot.roleChangedAt;if(!snapshot.roleTimestampPresent)delete s.roleChangedAt;s.roleData=snapshot.roleData;s.console.users=snapshot.users;s.console.audits=snapshot.audits;s.console.notices=snapshot.notices;return {error:'save'};}
    return result;
  }
  function updateRole(id,role,at){if(id==='me'){S().role=role;S().roleChangedAt=at;}else{const u=S().console.users.find(u=>u.id===id);u.role=role;u.roleChangedAt=at;}}
  function apply(statement,links){
    const user=account('me');if(!S().signed)return {error:'login'};
    const allowed=access('me');if(!allowed.eligible)return {error:allowed.reason};
    const input=validateVerificationInput(statement,links);if(input.error)return input;
    return commit(()=>{const record={id:ctx.uid(),user:'me',...input,metrics:structuredClone(metrics('me')),status:'pending',createdAt:new Date().toISOString(),decidedAt:null,reason:'',reviewedBy:null};requests().unshift(record);return {record};});
  }
  function review(id,decision,reason=''){
    if(!S().admin)return {error:'admin'};
    if(verificationDemoRequests().some(r=>r.id===id))return {error:'readonly'};
    const record=requests().find(r=>r.id===id),user=record&&account(record.user);
    if(!record||record.status!=='pending'||!user||user.adminScale||roleOf(user.role)!=='normal')return {error:'stale'};
    if(!['approved','rejected'].includes(decision))return {error:'decision'};
    reason=String(reason).trim();if((decision==='rejected'&&!reason)||Array.from(reason).length>500)return {error:'reason'};
    if(user.status==='disabled'&&decision==='approved')return {error:'disabled'};
    return commit(()=>{const at=new Date().toISOString();Object.assign(record,{status:decision,reason,decidedAt:at,reviewedBy:S().console.adminEmail});if(decision==='approved')updateRole(user.id,'verified',at);audit('verification.'+decision,user.id,{role:user.role,request:id},{role:decision==='approved'?'verified':user.role,reason,request:id});S().console.notices.unshift({id:ctx.uid(),user:user.id,text:decision==='approved'?'账号认证已通过。':'认证申请未通过：'+reason});return {record};});
  }
  function changeRole(id,action,reason){
    if(!S().admin)return {error:'admin'};
    const user=account(id),next={official:'official','cancel-official':'normal',revoke:'normal'}[action];
    if(!user||user.adminScale||!next||(action==='official'?user.role==='official':action==='revoke'?user.role!=='verified':user.role!=='official'))return {error:'stale'};
    reason=String(reason||'').trim();if(!reason||Array.from(reason).length>500)return {error:'reason'};
    const payouts=id==='me'?S().payouts||[]:[...(S().adminPayouts||[]).filter(p=>p.user===id||p.name===user.name),...(S().console.historyPayouts||[]).filter(p=>p.user===id)];
    if(next==='official'&&payouts.some(p=>['pending','approved'].includes(p.status)))return {error:'payout-pending'};
    return commit(()=>{const at=new Date().toISOString();updateRole(id,next,at);for(const request of requests())if(request.user===id&&request.status==='pending'&&next==='official')Object.assign(request,{status:'rejected',closedByRoleChange:true,reason:'账号已由管理员设为官方，认证申请已结束。',decidedAt:at,reviewedBy:S().console.adminEmail});audit('user.role.'+action,id,{role:user.role},{role:next,reason});S().console.notices.unshift({id:ctx.uid(),user:id,text:'账号角色已变更为'+label(next)+'：'+reason});return {role:next};});
  }
  function recordQuestions(rees,askerId,requestId){for(const ree of rees){const owner=reeOwnerId(S(),ree),id=requestId+':'+ree.id;if(owner&&owner!==askerId&&!S().roleData.questions.some(e=>e.id===id))S().roleData.questions.push({id,reeId:ree.id,askerId,createdAt:new Date().toISOString()});}}
  function recordVote(message,voterId){const feedback=S().roleData.feedback;const existing=feedback.find(e=>e.answerId===message.id&&e.voterId===voterId);if(existing)existing.vote=message.vote;else feedback.push({answerId:message.id,reeId:message.dot,voterId,vote:message.vote});}
  function ensure(){
    const s=S();if(!s.console)return;
    s.role=roleOf(s.role);
    if(s.roleData){for(const key of ['requests','questions','feedback'])if(!Array.isArray(s.roleData[key]))s.roleData[key]=[];if(s.roleData.fixtureVersion>=2)return;}
    s.roleData ||= {version:1,requests:[],questions:[],feedback:[]};
    const at=new Date(),submitted=new Date(Number(at)-2*86400000).toISOString(),decided=new Date(Number(at)-86400000).toISOString();
    const fixtures=[['applicant','林溪 · 认证申请示例','normal'],['queue','许安 · 待审示例','normal'],['verified','周宁 · 认证用户示例','verified'],['official','Ree 官方团队','official'],['rejected','陈果 · 申请未通过示例','normal']];
    for(const [key,name,role] of fixtures){
      const id='u-role-'+key;
      if(!s.console.users.some(u=>u.id===id))s.console.users.push({id,name,email:key+'@example.com',role,roleChangedAt:role==='normal'?null:decided,status:'active',created:'2026-10-01',subscription:'expired',kyc:'none',tax:'—',plan:0,pack:0,earned:0,roleFixture:true});
      if(!s.dots.some(r=>r.id==='role-'+key))s.dots.push({id:'role-'+key,slug:'role-'+key,name:role==='official'?'Ree 官方指南':role==='verified'?'知识整理与创作实践':key==='applicant'?'产品知识与设计实践':'内容研究方法库',enName:'Knowledge & practice · '+key,description:'关于知识整理、内容创作和产品实践的来源与方法。',enDescription:'Knowledge, writing and product practices grounded in sources.',owner:name,ownerId:id,public:true,fee:20,answers:128,rating:94,icon:'dot',color:role==='official'?'':'sage',samples:['如何建立可追溯的知识库？','如何评估知识内容的质量？','怎样持续改进回答效果？'],tags:['产品设计'],knowledge:Array.from({length:6},(_,i)=>({id:'role-source-'+key+'-'+i,title:['知识整理方法.md','设计实践.pdf','来源与引用规范.md','内容质量检查.md','使用反馈记录.md','产品案例笔记.md'][i],kind:'document',status:'ready',enabled:true,locator:'第 '+(i+1)+' 节',content:'知识内容应基于可核对的原始来源，保留出处，持续维护，依据使用者的反馈改进。'})),roleFixture:true,verificationBaseline:{externalQuestions:128,helpful:94,unhelpful:6}});
      if(key!=='official'&&!s.roleData.requests.some(r=>r.id==='role-request-'+key)){
        const u=account(id),m=roleMetrics(s,u,new Date(submitted));
        s.roleData.requests.push({id:'role-request-'+key,user:id,statement:'我持续整理公开知识与产品实践，维护来源引用，并根据使用反馈改进内容，希望申请账号认证。',links:['https://example.com/portfolio/'+key],metrics:m,status:['applicant','queue'].includes(key)?'pending':key==='verified'?'approved':'rejected',createdAt:submitted,decidedAt:['applicant','queue'].includes(key)?null:decided,reviewedBy:['applicant','queue'].includes(key)?null:s.console.adminEmail,reason:key==='rejected'?'申请说明与公开作品的关联不够清楚，请补充可核对的创作记录后再次申请。':''});
      }
    }
    if(!s.console.audits.some(a=>a.id==='role-seed-official'))s.console.audits.unshift({id:'role-seed-official',actor:s.console.adminEmail,action:'user.role.official',target:'u-role-official',before:{role:'normal'},after:{role:'official',reason:'平台自营 Ree 示例账号'},created:decided});
    s.roleData.fixtureVersion=2;
    ctx.save();
  }
  return {ensure,account,roleFor,roleForRee,label,badge,badgeForRee,metrics,access,requests,adminRequests,apply,review,changeRole,recordQuestions,recordVote};
}
