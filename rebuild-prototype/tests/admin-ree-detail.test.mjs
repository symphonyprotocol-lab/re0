import test from "node:test";
import assert from "node:assert/strict";
import { adminReeBackPath, adminReeDetailPath, findAdminRee, adminReeSources, createAdminReeDetail } from "../admin-ree-detail.js";

const query=value=>new URLSearchParams(value);
const dot={id:"private-ree",slug:"private",name:"私有知识伙伴",description:"只读资料",owner:"me",public:false,answers:21,fee:30,prompt:"用清晰的步骤回答",samples:["怎样开始？"],knowledge:Array.from({length:128},(_,i)=>({id:String(i),title:`来源 ${i+1}`,kind:"document",status:i%3===0?"failed":"ready",enabled:i%5!==0,content:"DO_NOT_RENDER_SOURCE_BODY"}))};
function setup(overrides={}) {
  const state={admin:true,dots:[dot],console:{audits:[{target:dot.id,action:"dot.restore"},{target:"other",action:"dot.takedown"}]}}, captured={};
  const ctx={getState:()=>state,t:zh=>zh,I:()=>"",esc:value=>String(value??"").replaceAll("&","&amp;").replaceAll('<','&lt;').replaceAll('"','&quot;'),n:String,title:d=>d.name,desc:d=>d.description,avatar:()=>"AVATAR",btn:()=>"ACTION",route:()=>({query:query("")}),go:path=>captured.path=path,owner:()=>({id:"me",name:"Creator",email:"creator@example.com"}),categoryLabel:()=>"专业知识",kindLabel:()=>"文档",auditTable:rows=>{captured.audits=rows;return "AUDIT_TABLE";},renderTable:(heads,rows)=>{captured.rows=rows;return "SOURCE_TABLE";},...overrides};
  return {controller:createAdminReeDetail(ctx),state,captured};
}
test("detail links retain a normalized list page and filters across tabs",()=>{
  const from="/admin/dots?sample=scale&status=moderated&size=100&page=3&q=React";
  const path=adminReeDetailPath(dot,from,"sources",{sourceStatus:"failed",sourcePage:2});
  const params=query(path.split("?")[1]);
  assert.equal(params.get("from"),"/admin/dots?q=React&status=moderated&size=100&page=3");
  assert.equal(params.get("tab"),"sources"); assert.equal(params.get("sourcePage"),"2");
  assert.equal(adminReeBackPath("/admin/users/u-lin?tab=dots"),"/admin/users/u-lin?tab=dots");
});
test("return links reject external URLs, unrelated admin pages and injected detail paths",()=>{
  for(const path of ["https://evil.test/admin/dots","//evil.test/admin/dots","/admin/dots/private-ree","/admin/payouts","/admin/users/me?tab=dots&next=evil"])
    assert.equal(adminReeBackPath(path),"/admin/dots");
});
test("admin can open private, taken down and scale-demo Rees without changing stored records",()=>{
  const rows=[dot,{...dot,id:"removed",moderated:true}]; const before=structuredClone(rows);
  assert.equal(findAdminRee(rows,dot.id),dot);
  assert.equal(findAdminRee(rows,"removed").moderated,true);
  assert.equal(findAdminRee(rows,"admin-ree-scale-1200").adminDemo,true);
  assert.equal(findAdminRee(rows,"admin-ree-scale-1201"),undefined);
  assert.deepEqual(rows,before);
});
test("private detail stays behind the admin session and missing records have a return entry",()=>{
  const {controller}=setup({getState:()=>({admin:false,dots:[dot]})});
  assert.equal(controller.record(dot.id),undefined);
  assert.doesNotMatch(controller.page(dot.id),/私有知识伙伴|清晰的步骤/);
  assert.match(controller.page("missing"),/Ree 不存在或已删除|返回 Ree 列表/);
});
test("overview is read-only, uses cumulative answers and does not render knowledge bodies",()=>{
  const {controller,state}=setup();const before=structuredClone(state),html=controller.page(dot.id);
  assert.match(html,/私有知识伙伴/);assert.match(html,/累计成功回答/);assert.match(html,/未记录/);
  assert.doesNotMatch(html,/DO_NOT_RENDER_SOURCE_BODY|<textarea|<input/);
  assert.deepEqual(state,before);
});
test("128 sources are filtered before pagination with paused status taking precedence",()=>{
  const all=adminReeSources(dot,query("sourcePage=7"));
  assert.equal(all.total,128);assert.equal(all.items.length,8);assert.equal(all.items[0].title,"来源 121");
  const paused=adminReeSources(dot,query("sourceStatus=paused"));assert.ok(paused.items.every(source=>source.enabled===false));
  const failed=adminReeSources(dot,query("sourceStatus=failed"));assert.ok(failed.items.every(source=>source.status==="failed"&&source.enabled!==false));
  const match=adminReeSources(dot,query("sourceQ=来源 128&sourcePage=100"));assert.equal(match.page,1);assert.equal(match.total,1);
});
test("sources and audit tabs only render current sources or matching management actions",()=>{
  const sources=setup({route:()=>({query:query("tab=sources&sourcePage=2")})});
  sources.controller.page(dot.id);assert.equal(sources.captured.rows.length,20);assert.match(sources.captured.rows[0][0],/来源 21/);
  assert.ok(sources.captured.rows.every(row=>!row.join(" ").includes("DO_NOT_RENDER_SOURCE_BODY")));
  const audit=setup({route:()=>({query:query("tab=audit")})});audit.controller.page(dot.id);
  assert.equal(audit.captured.audits.length,1);assert.equal(audit.captured.audits[0].target,dot.id);
});
test("knowledge search preserves list return context and resets source page",()=>{
  const {controller,captured}=setup({route:()=>({query:query("from=%2Fadmin%2Fdots%3Fsize%3D50%26page%3D2&tab=sources&sourcePage=4")})});
  controller.onSubmit({id:"admin-ree-source-filter",dataset:{id:dot.id}},new Map([["sourceQ","来源 128"],["sourceStatus","ready"]]));
  const params=query(captured.path.split("?")[1]);
  assert.equal(params.get("from"),"/admin/dots?size=50&page=2");assert.equal(params.has("sourcePage"),false);assert.equal(params.get("sourceQ"),"来源 128");
});
