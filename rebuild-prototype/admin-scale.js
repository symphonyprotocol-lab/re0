import { USER_ROLES, roleOf, verificationListPath } from "./user-role-domain.js";
import { reportingDate, recordTime, recentStatisticsRange, statisticsTimeFilters, statisticsFilterRange, statisticsPeriod } from "./statistics-time.js";

export const ADMIN_RECORD_KINDS = ["users","kyc","purchases","payouts","payout-history","audit"];
export const ADMIN_MEMBERSHIP_STATES = ["active","cancelled","expired"];
export const ADMIN_USER_KYC_STATES = ["none","pending","processing","verified","rejected","reset"];
export const ADMIN_SCALE_COUNTS = {users:1200,kyc:1400,purchases:1600,payouts:1200,"payout-history":2400,audit:1800};
export const ADMIN_AUDIT_ACTIONS = ["user.disable","user.restore","credits.adjust","kyc.verified","kyc.rejected","payout.approved","payout.paid","payout.failed","ree.takedown","ree.restore","model.activate","kyc.files.view","verification.approved","verification.rejected","user.role.official","user.role.cancel-official","user.role.revoke"];
const pad = value => String(value).padStart(4,"0");
const DAY = 86400000;
let catalog, catalogDay;
export function adminScaleData(now = new Date()) {
  const day = reportingDate(now);
  if (catalogDay === day) return catalog;
  const base = Date.parse(day+"T12:00:00+08:00");
  const when = (i,spread=120) => new Date(base-((i*37+Math.floor(i/spread))%spread)*DAY-((i*7)%12)*3600000).toISOString();
  const names=["林舟","Alex Chen","陈思远","Mia","Studio June","田中悠","赵明","Knowledge Studio"];
  const users=Array.from({length:1200},(_,i)=>({
    id:"scale-user-"+pad(i+1),adminScale:true,role:i%4===0?"verified":"normal",
    name:names[i%names.length]+(i%37===0?" · 跨领域研究与知识内容创作工作室":"")+" · "+pad(i+1),
    email:(i%41===0?"research-and-content-management-team-":"creator-")+pad(i+1)+"@example.com",
    status:i%9===0?"disabled":"active",subscription:["active","active","cancelled","expired"][i%4],
    kyc:["verified","verified","pending","rejected","reset","none"][i%6],
    plan:(i*137)%100001,pack:(i%8)*100000,earned:(i*971)%980000,created:when(i),
  }));
  const kyc=Array.from({length:1400},(_,i)=>({
    id:"scale-kyc-"+pad(i+1),adminScale:true,user:users[i%1200].id,
    status:["pending","verified","verified","rejected","reset"][i%5],provider:"manual",
    legalName:users[i%1200].name,country:["Malaysia","Singapore","United States","Japan"][i%4],
    kind:["passport","id","residence"][i%3],last4:pad(i%10000),expires:"2030-12-31",
    submitted:when(i),created:when(i),decided:i%5===0?null:when(Math.max(0,i-2)),
    tax:i%4===2?"W-9":"W-8BEN",declared:true,reviewer:i%5===0?"—":"reviewer-"+(i%7+1)+"@example.com",
    reason:i%5===3?"演示：证件边缘被裁切，请重新提交完整清晰的照片。":"",
    filesDeleted:[1,2].includes(i%5)&&Date.parse(when(i))<base-30*DAY,
  }));
  const purchases=Array.from({length:1600},(_,i)=>({
    id:"scale-txn-"+pad(i+1)+"-paddle-transaction-demo",adminScale:true,user:users[i%1200].id,
    kind:i%3===0?"pack":"plan",amount:(i%5+1)*10,credits:(i%5+1)*100000,
    status:["paid","paid","paid","refunded","chargeback"][(i*3+Math.floor(i/5))%5],created:when(i),
  }));
  const payouts=Array.from({length:2400},(_,i)=>{
    const status=i<1200?(i%2===0?"pending":"approved"):["paid","failed","rejected"][(i-1200)%3];
    const credits=500000+(i%30)*50000,fee=status==="paid"?1+(i%9)/10:0;
    return {id:"scale-payout-"+pad(i+1),adminScale:true,user:users[i%1200].id,name:users[i%1200].name,
      email:"paypal-recipient-"+pad(i%1200+1)+"@example.com",credits,status,fee,
      actual:status==="paid"?credits/10000-fee:undefined,tax:i%4===2?"W-9":"W-8BEN",created:when(i),
      reviewer:status==="pending"?"—":"reviewer-"+(i%7+1)+"@example.com",
      reviewedAt:status==="pending"?null:when(Math.max(0,i-1)),
      transferId:status==="paid"?"DEMO-PAYPAL-TRANSFER-"+pad(i+1)+"-LONG-REFERENCE":"",
      paidBy:status==="paid"?"payment-ops@example.com":"",paidAt:status==="paid"?when(Math.max(0,i-2)):null,
      note:status==="failed"?"演示：收款账户无法接收款项，冻结额度已释放。":status==="rejected"?"演示：账户资料需要补充，申请已驳回。":"",
    };
  });
  const actions=ADMIN_AUDIT_ACTIONS.filter(action => !/^(verification\.|user\.role\.)/.test(action));
  const audit=Array.from({length:1800},(_,i)=>{
    const action=actions[i%actions.length];
    const changes={
      "user.disable":[{status:"active"},{status:"disabled"}],
      "user.restore":[{status:"disabled"},{status:"active"}],
      "credits.adjust":[{earned:500000},{earned:550000,adjustment:50000}],
      "kyc.verified":[{status:"pending"},{status:"verified"}],
      "kyc.rejected":[{status:"pending"},{status:"rejected"}],
      "payout.approved":[{status:"pending"},{status:"approved"}],
      "payout.paid":[{status:"approved"},{status:"paid",fee:1.5}],
      "payout.failed":[{status:"approved"},{status:"failed"}],
      "ree.takedown":[{public:true,moderated:false},{public:false,moderated:true}],
      "ree.restore":[{public:false,moderated:true},{public:true,moderated:false}],
      "model.activate":[{enabled:false},{enabled:true}],
      "kyc.files.view":[null,{slot:"document",accessSeconds:60}],
    }[action];
    return {id:"scale-audit-"+pad(i+1),adminScale:true,actor:"operator-"+(i%9+1)+"@example.com",action,
      target:action.startsWith("user.")||action.startsWith("credits.")?users[i%1200].id:action.startsWith("kyc.")?kyc[i%1400].id:action.startsWith("payout.")?payouts[i%2400].id:action.startsWith("ree.")?"admin-ree-scale-"+pad(i%1200+1):"demo-model-generation",
      created:when(i),before:changes[0],after:{...changes[1],reason:i%17===0?"演示：较长的操作原因，用于核对列表信息密度与详情展示，不影响真实账户。":"演示操作记录"},
    };
  });
  catalogDay=day;
  return catalog={users,kyc,purchases,payouts,audit};
}
export const adminRecordTime = row => {
  if(row.adminTimeUnknown)return null;
  const value = row.submitted && row.submitted !== "—" ? row.submitted : row.createdAt || row.created;
  // Older local audit entries stored wall time in the reporting timezone.
  return recordTime({createdAt: typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value) ? value.replace(" ","T")+":00+08:00" : value});
};
export const adminFinanceEnabled = (kind,query) => kind === "payouts" || kind === "payout-history" || (kind === "purchases" && query.get("tab") !== "subscriptions");
export function adminRecordView(kind,query,now=new Date()) {
  const finance=adminFinanceEnabled(kind,query);
  const calendar=finance&&["day","week","month","custom"].includes(query.get("period")) ? statisticsTimeFilters(query,now) : null;
  if(calendar&&calendar.date>reportingDate(now))calendar.date=reportingDate(now);
  const subscriptions=kind==="purchases"&&query.get("tab")==="subscriptions";
  const allowed={users:["active","disabled"],kyc:["pending","verified","rejected","reset","none","processing"],purchases:subscriptions?["active","cancelled","expired"]:["paid","refunded","chargeback"],payouts:["pending","approved"],"payout-history":["pending","approved","paid","failed","rejected"],audit:[]}[kind]||[];
  const fallback=["kyc","payouts"].includes(kind)?"oldest":"newest";
  const sorts=["oldest","newest",...(["purchases","payouts","payout-history"].includes(kind)&&!subscriptions?["amount-high","amount-low"]:[])];
  const page=Number(query.get("page"));
  return {action:kind==="audit" && ADMIN_AUDIT_ACTIONS.includes(query.get("action")) ? query.get("action") : "all", q:(query.get("q")||"").trim().slice(0,400),status:allowed.includes(query.get("status"))?query.get("status"):"all",
    role:kind==="users"&&USER_ROLES.includes(query.get("role"))?query.get("role"):"all",
    membership:kind==="users"&&ADMIN_MEMBERSHIP_STATES.includes(query.get("membership"))?query.get("membership"):"all",
    kyc:kind==="users"&&ADMIN_USER_KYC_STATES.includes(query.get("kyc"))?query.get("kyc"):"all",
    period:calendar?.period||(["7","30","90"].includes(query.get("period"))?query.get("period"):"all"),
    date:calendar?.date||reportingDate(now),start:calendar?.start,end:calendar?.end,
    metric:finance&&query.get("metric")==="count"?"count":"amount",
    sort:sorts.includes(query.get("sort"))?query.get("sort"):fallback,size:[20,50,100].includes(Number(query.get("size")))?Number(query.get("size")):20,
    page:Number.isFinite(page)&&page>0?Math.min(100000,Math.floor(page)):1,tab:subscriptions?"subscriptions":"all",allowed,sorts,fallback};
}
export function adminRecordPath(kind,query=new URLSearchParams(),changes={}) {
  const next=new URLSearchParams(query);
  for(const [key,value] of Object.entries(changes)) value===null||value===""||value==="all"?next.delete(key):next.set(key,String(value));
  if(["q","status","period","date","start","end","sort","size","tab","action","role","membership","kyc"].some(key=>key in changes)) next.delete("page");
  const f=adminRecordView(kind,next),result=new URLSearchParams();
  if(f.tab==="subscriptions")result.set("tab",f.tab);
  for(const key of ["q","status","role","membership","kyc","period","action"])if(f[key]&&f[key]!=="all")result.set(key,f[key]);
  if(f.period==="custom"){result.set("start",f.start);result.set("end",f.end);}
  else if(["day","week","month"].includes(f.period))result.set("date",f.date);
  if(f.metric==="count")result.set("metric","count");
  if(f.sort!==f.fallback)result.set("sort",f.sort);
  if(f.size!==20)result.set("size",f.size);
  if(f.page>1)result.set("page",f.page);
  return "/admin/"+kind+(result.size?"?"+result:"");
}
export function adminRecordBackPath(value,fallback="users") {
  if(typeof value!=="string")return "/admin/"+fallback;
  const match=/^\/admin\/(users|kyc|purchases|payouts|payout-history|audit|verifications)(?:\?([^#]*))?$/.exec(value);
  return match?(match[1]==="verifications"?verificationListPath(new URLSearchParams(match[2])):adminRecordPath(match[1],new URLSearchParams(match[2]))):"/admin/"+fallback;
}
export function selectAdminRecords(kind,rows,query,now=new Date()) {
  const view=adminRecordView(kind,query,now),q=view.q.toLocaleLowerCase();
  const recent=recentStatisticsRange(Number(view.period),now);
  const range=view.period==="all"?null:recent?statisticsPeriod("custom",recent.start,recent.end):statisticsFilterRange(view);
  const times=new Map(rows.map(row=>[row,adminRecordTime(row)]));
  const matched=rows.filter(row=>{
    const time=times.get(row);
    return (kind!=="payouts"||["pending","approved"].includes(row.status))&&
      (view.status==="all"||row.status===view.status)&&(view.action==="all"||String(row.action||"").replace(/^dot\./i,"ree.")===view.action)&&(!range||(time!==null&&time>=range.start&&time<range.end))&&
      (view.role==="all"||roleOf(row.role)===view.role)&&(view.membership==="all"||row.subscription===view.membership)&&(view.kyc==="all"||(row.kyc||"none")===view.kyc)&&
      (!q||[row.id,row.name,row.email,row.userEmail,row.legalName,row.country,row.actor,row.actionLabel,row.action?.replace(/^dot\./,"ree."),row.target,row.transferId,row.reason].join(" ").toLocaleLowerCase().includes(q));
  });
  const amount=row=>Number(row.amount??Number(row.credits)/10000)||0;
  matched.sort((a,b)=>{
    if(view.sort.startsWith("amount-"))return (amount(a)-amount(b))*(view.sort==="amount-high"?-1:1)||String(a.id).localeCompare(String(b.id));
    const at=times.get(a),bt=times.get(b);
    if(at===null&&bt!==null)return 1;if(bt===null&&at!==null)return -1;
    return ((at||0)-(bt||0))*(view.sort==="newest"?-1:1)||String(a.id).localeCompare(String(b.id));
  });
  const total=matched.length,pages=Math.max(1,Math.ceil(total/view.size));view.page=Math.min(view.page,pages);
  const offset=(view.page-1)*view.size;
  return {view,total,pages,start:total?offset+1:0,end:Math.min(offset+view.size,total),items:matched.slice(offset,offset+view.size),matched};
}
