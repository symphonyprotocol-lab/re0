import test from "node:test";
import assert from "node:assert/strict";
import { adminReeStatistics, createAdminReeStatistics } from "../admin-ree-statistics.js";
import { dotStatistics } from "../dot-statistics.js";
import { createAdminReeDetail } from "../admin-ree-detail.js";

const dot={id:"design",owner:"Other creator",name:"设计顾问",description:"产品与设计",public:false,answers:1280,fee:30,knowledge:[{id:"source",title:"设计资料",status:"ready",kind:"document"}]};
const a={id:"a",role:"dot",dot:"design",text:"范围内回答",source:"source",createdAt:"2026-10-31T15:59:59Z"};
function fixture() {
  return {admin:true,signed:false,lang:"zh",dots:[structuredClone(dot),{id:"mine",owner:"me",answers:12,knowledge:[]}],
    dotMessages:{"dot:design":[{role:"user",text:"如何开始？"},a,{id:"no",role:"dot",dot:"design",text:"未作答",noAnswer:true}]},
    chats:[{id:"chat",messages:[{role:"user",text:"重复提问"},{...a},{id:"b",role:"dot",dot:"design",text:"次日回答",createdAt:"2026-10-31T16:00:00Z"},{id:"other",role:"dot",dot:"mine",text:"其他 Ree 正文"}]}],
    earnedCredits:999999,entries:[
      {id:"income",type:"income",dotId:"design",title:"范围内收入",amount:30,createdAt:"2026-10-31T15:59:59Z"},
      {id:"unattributed",type:"income",title:"设计顾问收入",amount:999},
      {id:"other-income",type:"income",dotId:"mine",title:"其他 Ree 收入",amount:60},
      {id:"query",type:"query",dotId:"design",answerId:"a",amount:-50,createdAt:a.createdAt},
    ],console:{users:[{id:"owner",entries:[
      {id:"income",type:"income",dotId:"design",title:"范围内收入",amount:30,createdAt:a.createdAt},
      {id:"owner-income",type:"income",dotId:"design",title:"次日收入",amount:8,createdAt:"2026-10-31T16:00:00Z"},
    ]}]}};
}
function setup(state=fixture(),query="") {
  const captured={};
  const api=createAdminReeStatistics({getState:()=>state,t:zh=>zh,I:()=>"",esc:v=>String(v??"").replaceAll('"','&quot;'),n:String,title:d=>d.name,
    route:()=>({query:new URLSearchParams(query)}),reeRecord:id=>state.admin?state.dots.find(d=>d.id===id):undefined,
    go:path=>captured.path=path,toast:message=>captured.toast=message,
  });
  return {api,captured,state};
}
test("admin statistics include the selected non-owner Ree without weakening the user scope",()=>{
  const state=fixture(),before=structuredClone(state),data=adminReeStatistics(state,"design");
  assert.equal(data.answers,1280);assert.equal(data.records.length,2);assert.equal(data.events.length,2);assert.equal(data.sources.ready,1);
  assert.equal(data.earned,38);assert.equal(data.income.length,2);
  assert.equal(dotStatistics(state,"design"),null);assert.deepEqual(state,before);
});
test("admin data access requires its independent session and demo records stay isolated",()=>{
  const state=fixture();state.admin=false;
  assert.equal(adminReeStatistics(state,"design"),null);
  assert.equal(setup(state).api.page(dot,new URLSearchParams()),"");
  state.admin=true;assert.equal(adminReeStatistics(state,"missing"),null);
  const sample=adminReeStatistics(state,"admin-ree-scale-1200");
  assert.equal(sample.dot.adminDemo,true);assert.equal(sample.records.length,0);assert.equal(sample.income.length,0);
});
test("shared admin renderer has the same date, trend, answers and attributed income logic",()=>{
  const {api}=setup();
  const day=api.page(dot,new URLSearchParams("period=day&date=2026-10-31"));
  assert.match(day,/范围内回答/);assert.doesNotMatch(day,/次日回答|其他 Ree 正文|未作答<\/div>/);
  assert.match(day,/按小时汇总/);assert.match(day,/时段成功回答/);
  assert.match(day,/admin-ree-statistics-period/);assert.match(day,/admin-ree-statistics-filter/);
  const income=api.page(dot,new URLSearchParams("period=day&date=2026-10-31&view=income"));
  assert.match(income,/范围内收入/);assert.doesNotMatch(income,/次日收入|其他 Ree 收入|设计顾问收入/);
});
test("statistics links stay in the admin shell and retain the originating user or Ree list",()=>{
  const {api}=setup(fixture(),"from=%2Fadmin%2Fusers%2Fu-lin%3Ftab%3Ddots");
  const html=api.page(dot,new URLSearchParams("period=week&date=2026-10-31"));
  const hrefs=[...html.matchAll(/href="#([^"]+)"/g)].map(match=>match[1].replaceAll("&amp;","&"));
  assert.ok(hrefs.length>6);
  for(const href of hrefs) {
    const url=new URL(href,"http://localhost");
    assert.equal(url.pathname,"/admin/dots/design");assert.equal(url.searchParams.get("from"),"/admin/users/u-lin?tab=dots");
    assert.ok(["statistics","sources"].includes(url.searchParams.get("tab")));
  }
  assert.ok(hrefs.some(href=>new URL(href,"http://localhost").searchParams.get("sourceStatus")==="ready"));
});
test("admin calendar and detail form submission retain custom dates and reset pagination",async()=>{
  const {api,captured,state}=setup(fixture(),"from=%2Fadmin%2Fdots%3Fstatus%3Dprivate%26size%3D100%26page%3D2");
  const before=structuredClone(state);
  await api.onSubmit({id:"admin-ree-statistics-filter",dataset:{dot:"design"}},new Map([["period","custom"],["start","2026-10-01"],["end","2026-10-31"],["view","income"],["size","50"],["q","收入"],["page","4"]]));
  const params=new URL(captured.path,"http://localhost").searchParams;
  assert.equal(params.get("tab"),"statistics");assert.equal(params.get("from"),"/admin/dots?status=private&size=100&page=2");
  assert.equal(params.get("start"),"2026-10-01");assert.equal(params.get("end"),"2026-10-31");assert.equal(params.get("size"),"50");assert.equal(params.has("page"),false);
  await api.onSubmit({id:"admin-ree-statistics-period",dataset:{dot:"design"}},new Map([["period","month"],["selection","2026-09"],["view","answers"],["size","20"]]));
  assert.equal(new URL(captured.path,"http://localhost").searchParams.get("date"),"2026-09-01");
  assert.deepEqual(state,before);
});
test("clearing saved answers does not erase dated usage and invalid ranges do not navigate",async()=>{
  const state=fixture();state.dotMessages={};state.chats=[];
  const data=adminReeStatistics(state,"design");assert.equal(data.records.length,0);assert.equal(data.events.length,1);assert.equal(data.answers,1280);
  const {api,captured}=setup(state);
  await api.onSubmit({id:"admin-ree-statistics-period",dataset:{dot:"design"}},new Map([["period","custom"],["start","2026-10-31"],["end","2026-10-01"]]));
  assert.equal(captured.path,undefined);assert.ok(captured.toast);
});
test("admin overview puts the fee beside three summary metrics and uses a dedicated statistics tab",()=>{
  let received;
  const ctx={getState:()=>fixture(),t:zh=>zh,I:()=>"",esc:String,n:String,title:d=>d.name,desc:d=>d.description,avatar:()=>"",btn:()=>"",route:()=>({query:new URLSearchParams()}),owner:()=>({id:"owner",name:"Creator"}),categoryLabel:()=>"设计",statisticsPage:(record,query)=>{received=record;return "SHARED_STATISTICS";}};
  const overview=createAdminReeDetail(ctx).page("design");
  const cards=overview.split('class="admin-ree-detail-metrics"')[1].split('class="admin-ree-detail-grid"')[0];
  assert.equal((cards.match(/<article/g)||[]).length,4);assert.match(cards,/成功回答计费/);assert.match(cards,/>50<em>/);
  const stats=createAdminReeDetail({...ctx,route:()=>({query:new URLSearchParams("tab=statistics")})});
  assert.equal(stats.page("design"),"SHARED_STATISTICS");assert.equal(received.id,"design");
  assert.match(stats.navigation("design"),/使用统计/);
});
