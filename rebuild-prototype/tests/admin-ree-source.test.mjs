import test from "node:test";
import assert from "node:assert/strict";
import { adminReeSourceRoute, adminSourceView, createAdminReeSource, adminSourceSequence } from "../admin-ree-source.js";
import { adminReeSourcePath } from "../admin-ree-detail.js";

const query=value=>new URLSearchParams(value);
const source={id:"s1",title:"审核文档",kind:"document",status:"ready",content:"# 文档正文\n\n实际保留的知识内容。\n\n<script>alert(1)</script>",locator:"第 2 页"};
const dot={id:"ree-1",name:"私有 Ree",public:false,knowledge:[source]};
function setup(overrides={}) {
  const state={admin:true,lang:"zh",dots:[dot]},captured={};
  const ctx={getState:()=>state,t:zh=>zh,I:()=>"",esc:v=>String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"','&quot;'),n:String,title:d=>d.name,kindLabel:()=>"文档",route:()=>({query:query("")}),go:path=>captured.path=path,reeRecord:id=>state.admin&&id===dot.id?dot:undefined,...overrides};
  return {controller:createAdminReeSource(ctx),state,captured};
}
test("source links retain both list contexts and encoded identifiers",()=>{
  const path=adminReeSourcePath({...dot,id:"ree name"},{id:"doc/one"},"/admin/dots?size=100&page=3",{sourceQ:"设计",sourceStatus:"ready",sourcePage:2},{contentQ:"知识"});
  assert.deepEqual(adminReeSourceRoute(path.split("?")[0]),{reeId:"ree name",sourceId:"doc/one"});
  const params=query(path.split("?")[1]);
  assert.equal(params.get("from"),"/admin/dots?size=100&page=3");assert.equal(params.get("sourceQ"),"设计");assert.equal(params.get("sourcePage"),"2");
  assert.equal(adminReeSourceRoute("/admin/dots/ree-1/sources/%ZZ"),null);
});
test("source preview is restricted to the admin session and the specified parent Ree",()=>{
  const {controller,state}=setup();
  assert.equal(controller.record(dot.id,source.id).source,source);
  assert.equal(controller.record("another-ree",source.id),undefined);
  assert.match(controller.page(dot.id,"missing"),/知识来源不存在或已移除/);
  state.admin=false;
  assert.equal(controller.record(dot.id,source.id),undefined);
  assert.doesNotMatch(controller.page(dot.id,source.id),/实际保留的知识内容/);
});
test("preview renders saved text safely without modifying the source",()=>{
  const {controller,state}=setup(),before=structuredClone(state),html=controller.page(dot.id,source.id);
  assert.match(html,/实际保留的知识内容/);assert.match(html,/&lt;script>/);assert.doesNotMatch(html,/<script>/);
  assert.deepEqual(state,before);
});
test("content search highlights literal matches and preserves the source-list return state",()=>{
  const {controller}=setup({route:()=>({query:query("from=%2Fadmin%2Fdots%3Fpage%3D4&sourceQ=审核&sourceStatus=ready&sourcePage=2&contentQ=知识")})});
  assert.match(controller.page(dot.id,source.id),/<mark>知识<\/mark>/);
  const back=controller.returnPath(dot),params=query(back.split("?")[1]);
  assert.equal(params.get("tab"),"sources");assert.equal(params.get("sourcePage"),"2");assert.equal(params.get("sourceQ"),"审核");assert.equal(params.has("contentQ"),false);
});
test("collections search the full repository and render at most 30 file entries",()=>{
  const repository={kind:"github",files:Array.from({length:117},(_,i)=>({path:`docs/file-${i}.md`,content:`# 文件 ${i}\n\n正文 ${i}`}))};
  assert.equal(adminSourceView(repository,query("")).items.length,30);
  assert.equal(adminSourceView(repository,query("childPage=4")).items.length,27);
  const result=adminSourceView(repository,query("child=116&childQ=file-116"));
  assert.equal(result.items.length,1);assert.equal(result.text,"# 文件 116\n\n正文 116");
  assert.equal(adminSourceView(repository,query("child=-1&childPage=Infinity")).childIndex,0);
});
test("website child text, literal newlines and missing content are handled honestly",()=>{
  const website={kind:"site",content:"parent",pages:[{title:"子页面",content:"# 标题\\n\\n子页面正文"}]};
  assert.equal(adminSourceView(website,query("")).text,"# 标题\n\n子页面正文");
  const empty={...dot,knowledge:[{...source,content:"",status:"failed",error:"无法解析"}]};
  const {controller}=setup({reeRecord:()=>empty});
  const html=controller.page(dot.id,source.id);assert.match(html,/无法解析/);assert.match(html,/暂无可预览的解析内容/);
  assert.doesNotMatch(html,/实际保留的知识内容/);
});
test("preview searches preserve filters and selected child without changing stored data",()=>{
  const {controller,state,captured}=setup({route:()=>({query:query("sourceQ=审核&sourcePage=2&child=4")})}),before=structuredClone(state);
  controller.onSubmit({id:"admin-source-content-search",dataset:{ree:dot.id,source:source.id}},new Map([["contentQ","知识"]]));
  const params=query(captured.path.split("?")[1]);
  assert.equal(params.get("sourceQ"),"审核");assert.equal(params.get("sourcePage"),"2");assert.equal(params.get("contentQ"),"知识");assert.equal(params.get("child"),"4");
  assert.deepEqual(state,before);
});

const reviewDot={...dot,knowledge:Array.from({length:128},(_,i)=>({id:`review-${i}`,title:`${i%2===0?"审核":"其他"} ${i}`,status:i%9===0?"failed":"ready",enabled:i%13!==0,kind:"document",content:`正文 ${i}`}))};
const scoped=reviewDot.knowledge.filter((row,i)=>i%2===0&&i%9!==0&&i%13!==0);
test("previous and next follow the full filtered source order across page boundaries",()=>{
  const before=structuredClone(reviewDot);
  const sequence=adminSourceSequence(reviewDot,scoped[19].id,query("sourceQ=审核&sourceStatus=ready&sourcePage=1"));
  assert.equal(sequence.position,20);assert.equal(sequence.total,scoped.length);
  assert.equal(sequence.previous.source,scoped[18]);assert.equal(sequence.previous.page,1);
  assert.equal(sequence.next.source,scoped[20]);assert.equal(sequence.next.page,2);
  const reverse=adminSourceSequence(reviewDot,scoped[20].id,query("sourceQ=审核&sourceStatus=ready&sourcePage=2"));
  assert.equal(reverse.previous.source,scoped[19]);assert.equal(reverse.previous.page,1);
  assert.deepEqual(reviewDot,before);
});
test("sequence stops at both ends and never jumps outside an empty or mismatched filter",()=>{
  const q=query("sourceQ=审核&sourceStatus=ready");
  assert.equal(adminSourceSequence(reviewDot,scoped[0].id,q).previous,undefined);
  assert.equal(adminSourceSequence(reviewDot,scoped.at(-1).id,q).next,undefined);
  for(const [id,filter] of [["missing",q],["review-1",q],[scoped[0].id,query("sourceQ=NO_MATCH")]]) {
    const result=adminSourceSequence(reviewDot,id,filter);
    assert.equal(result.position,0);assert.equal(result.previous,undefined);assert.equal(result.next,undefined);
  }
});
test("top navigation keeps list filters, updates destination page and resets source-specific searches",()=>{
  const {controller}=setup({reeRecord:()=>reviewDot,route:()=>({query:query("from=%2Fadmin%2Fdots%3Fstatus%3Dprivate%26size%3D100%26page%3D2&sourceQ=审核&sourceStatus=ready&sourcePage=1&contentQ=正文&childQ=file&child=24&childPage=2")})});
  const html=controller.navigation(reviewDot.id,scoped[19].id);
  const href=html.match(/<a class="admin-source-adjacent next" href="#([^"]+)"/)[1].replaceAll("&amp;","&");
  const params=query(href.split("?")[1]);
  assert.equal(adminReeSourceRoute(href.split("?")[0]).sourceId,scoped[20].id);
  assert.equal(params.get("sourceQ"),"审核");assert.equal(params.get("sourceStatus"),"ready");assert.equal(params.get("sourcePage"),"2");
  assert.equal(params.get("from"),"/admin/dots?status=private&size=100&page=2");
  for(const key of ["childQ","child","childPage","contentQ"]) assert.equal(params.has(key),false);
  assert.match(html,/上一个来源/);assert.match(html,/下一个来源/);assert.match(html,/20 \/ /);
});
test("single-source previews render both sequence controls disabled",()=>{
  const {controller}=setup();
  const html=controller.navigation(dot.id,source.id);
  assert.equal((html.match(/class="admin-source-adjacent (previous|next)"[^>]* disabled/g)||[]).length,2);
  assert.doesNotMatch(html,/<a class="admin-source-adjacent/);
});
