import test from "node:test";
import assert from "node:assert/strict";
import { adminReeView, adminReePath, adminReeDemoRows, selectAdminRees, createAdminRees } from "../admin-ree.js";
import { discoveryDemoDots } from "../discovery.js";
const query = value => new URLSearchParams(value);

test("1,200 read-only samples stay separate from real and discovery data", () => {
  const real = [{id:"real",name:"Real",public:true}];
  const before = structuredClone(real), discoveryBefore = structuredClone(discoveryDemoDots());
  const result = selectAdminRees(adminReeDemoRows(), query(""));
  assert.equal(result.total,1200);
  assert.equal(result.items.length,20);
  assert.ok(result.items.every(row=>row.adminDemo));
  assert.deepEqual(real,before);
  assert.deepEqual(discoveryDemoDots(),discoveryBefore);
  assert.equal(selectAdminRees(real,query("")).total,1);
});
test("pagination traverses all 1,200 rows once with bounded page sizes", () => {
  for (const size of [20,50,100]) {
    const ids = [];
    for(let page=1;page<=1200/size;page++) {
      const result = selectAdminRees(adminReeDemoRows(),query(`sample=scale&size=${size}&page=${page}`));
      assert.equal(result.items.length,size);
      ids.push(...result.items.map(row=>row.id));
    }
    assert.equal(new Set(ids).size,1200);
    assert.equal(ids.at(-1),"admin-ree-scale-1200");
  }
});
test("visibility is mutually exclusive, including legacy moderated public records", () => {
  const real = [{id:"public",public:true},{id:"private",public:false},{id:"removed",public:true,moderated:true}];
  for (const [status,id] of [["public","public"],["private","private"],["moderated","removed"]])
    assert.deepEqual(selectAdminRees(real,query(`status=${status}`)).items.map(row=>row.id),[id]);
  assert.equal(selectAdminRees(adminReeDemoRows(),query("sample=scale&status=public")).total,720);
  assert.equal(selectAdminRees(adminReeDemoRows(),query("sample=scale&status=private")).total,240);
  assert.equal(selectAdminRees(adminReeDemoRows(),query("sample=scale&status=moderated")).total,240);
});
test("search runs across the full catalog and owner information before pagination", () => {
  assert.equal(selectAdminRees(adminReeDemoRows(),query("sample=scale&q=ree-scale-1200")).items[0].slug,"ree-scale-1200");
  const result=selectAdminRees([{id:"a",name:"Alpha"},{id:"b",name:"Beta"}],query("q=owner@example.com"),row=>row.id==="b"?"Owner owner@example.com":"Other");
  assert.deepEqual(result.items.map(row=>row.id),["b"]);
});
test("invalid, out-of-range and empty pages are safe and do not invent ranges", () => {
  assert.deepEqual(adminReeView(query("size=10000&page=Infinity&status=bad")),{q:"",status:"all",size:20,page:1});
  assert.equal(adminReeView(query("status=disabled")).status,"moderated");
  const last=selectAdminRees(adminReeDemoRows(),query("sample=scale&page=99999&size=100"));
  assert.equal(last.view.page,12); assert.equal(last.start,1101); assert.equal(last.end,1200);
  const empty=selectAdminRees(adminReeDemoRows(),query("sample=scale&q=NOT_FOUND&page=44"));
  assert.equal(empty.view.page,1); assert.equal(empty.start,0); assert.equal(empty.end,0);
});
test("URLs preserve filters while paging and reset page on filter or size changes", () => {
  const original=query("sample=scale&q=React&status=public&size=50&page=4&ignored=yes");
  assert.equal(adminReePath(original,{page:5}),"/admin/dots?q=React&status=public&size=50&page=5");
  assert.equal(adminReePath(original,{size:100}),"/admin/dots?q=React&status=public&size=100");
  assert.equal(adminReePath(original,{q:null,status:"all"}),"/admin/dots?size=50");
  assert.equal(original.get("page"),"4");
});
test("renderer sends only the current page to the table and form navigation preserves scope", () => {
  let rendered, destination;
  let routeQuery=query("");
  const controller=createAdminRees({
    t:zh=>zh,I:()=>"",esc:String,n:String,route:()=>({query:routeQuery}),go:path=>destination=path,
    table:items=>{rendered=items;return "TABLE";},sectionHead:()=>"HEADING",rows:()=>[],getState:()=>({admin:true}),
  });
  const initial=controller.page();
  assert.equal(rendered.length,20);
  assert.doesNotMatch(initial,/规模演示|sample=scale/);
  routeQuery=query("size=100&page=12");
  const html=controller.page();
  assert.equal(rendered.length,100); assert.equal(rendered[0].slug,"ree-scale-1101");
  assert.doesNotMatch(html,/规模演示|sample=scale/); assert.match(html,/1101–1200/);
  controller.onSubmit({id:"admin-ree-filter"},new Map([["q","React"],["status","public"],["size","50"]]));
  assert.equal(destination,"/admin/dots?q=React&status=public&size=50");
});
