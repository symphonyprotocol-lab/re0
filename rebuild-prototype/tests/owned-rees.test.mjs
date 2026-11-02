import test from "node:test";
import assert from "node:assert/strict";
import { createOwnedRees, ownedReeView, ownedReePath, ownedReeDemoRows, ownedReeTestCatalog, selectOwnedRees, ownedReeVisibilityPlan, OWNED_REE_PAGE_SIZES } from "../owned-rees.js";
import { createWorkspace } from "../workspace.js";
import { createWorkspaceDetails } from "../workspace-details.js";
import { discoveryTestCatalog, selectDiscoveryDots, createDiscovery } from "../discovery.js";
const query = value => new URLSearchParams(value);
globalThis.document = { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } };

test("600 samples stay outside real Rees, conversations and account balances", () => {
  const state = { dots: [{id:"real",owner:"me",name:"Real",knowledge:[]}], chats:[{id:"keep"}], earnedCredits:42 };
  const before = structuredClone(state), result = selectOwnedRees(state.dots, query("sample=scale"));
  assert.equal(result.total, 600);
  assert.equal(new Set(ownedReeDemoRows().map(dot => dot.id)).size, 600);
  assert.ok(result.items.every(dot => dot.ownedDemo));
  assert.deepEqual(state, before);
  assert.equal(selectOwnedRees(state.dots, query("")).total, 1);
});
test("the default test catalog retains original Rees, adds all 600 fixtures, and avoids real ID or slug collisions", () => {
  const dots = [{id:"mine",owner:"me",name:"Mine"},{id:"other",owner:"someone",name:"Other"}];
  const before = structuredClone(dots), samplesBefore = structuredClone(ownedReeDemoRows());
  const catalog = ownedReeTestCatalog(dots);
  assert.equal(catalog.length, 601);
  assert.equal(catalog[0], dots[0]);
  assert.equal(catalog.filter(dot => dot.ownedDemo).length, 600);
  const collisions = [...dots, {id:"owned-ree-scale-0001",owner:"me",name:"Real record"}, {id:"external",slug:"owned-ree-scale-0002",owner:"someone"}];
  const deduplicated = ownedReeTestCatalog(collisions);
  assert.equal(deduplicated.filter(dot => dot.id === "owned-ree-scale-0001").length, 1);
  assert.equal(deduplicated.find(dot => dot.id === "owned-ree-scale-0001").ownedDemo, undefined);
  assert.equal(deduplicated.some(dot => dot.id === "owned-ree-scale-0002"), false);
  assert.deepEqual(dots, before);
  assert.deepEqual(ownedReeDemoRows(), samplesBefore);
});
test("the ordinary combined catalog supports all page sizes and six sorts without omissions or demo URL parameters", () => {
  const real = [{id:"mine",owner:"me",name:"Mine",public:true,answers:200000,knowledge:Array(20).fill({status:"ready"})}];
  const catalog = ownedReeTestCatalog(real), before = structuredClone(catalog);
  for (const size of OWNED_REE_PAGE_SIZES) for (const sort of ["name", "sources", "answers"]) for (const order of ["asc", "desc"]) {
    const ids = [];
    for (let page = 1; page <= Math.ceil(catalog.length / size); page++) {
      const params = query(`view=list&size=${size}&sort=${sort}&order=${order}&page=${page}`);
      const result = selectOwnedRees(catalog, params);
      assert.ok(result.items.length <= size);
      assert.equal(ownedReePath(params).includes("sample="), false);
      ids.push(...result.items.map(dot => dot.id));
    }
    assert.equal(ids.length, 601);
    assert.equal(new Set(ids).size, 601);
    assert.ok(ids.includes("mine"));
    assert.ok(ids.includes("owned-ree-scale-0600"));
  }
  assert.deepEqual(catalog, before);
});
test("paging both real and demo catalogs visits every Ree exactly once for every page size", () => {
  const real = structuredClone(ownedReeDemoRows()).map(dot => ({...dot,ownedDemo:false}));
  for (const sample of ["", "sample=scale&"]) {
    for (const size of OWNED_REE_PAGE_SIZES) {
      const ids = [];
      for (let page = 1; page <= Math.ceil(600 / size); page++) {
        const result = selectOwnedRees(real, query(`${sample}size=${size}&page=${page}`));
        assert.ok(result.items.length <= size);
        assert.equal(result.start, (page - 1) * size + 1);
        ids.push(...result.items.map(dot => dot.id));
      }
      assert.equal(ids.length, 600);
      assert.equal(new Set(ids).size, 600);
      assert.equal(ids.at(-1), "owned-ree-scale-0600");
    }
  }
});
test("search covers the entire collection before pagination and supports other-language names, descriptions and tags", () => {
  assert.equal(selectOwnedRees([], query("sample=scale&q=0600")).items[0].id, "owned-ree-scale-0600");
  const rows = [{ id:"mine", owner:"me", name:"中文名称", enName:"English topic", description:"Description target", tags:["unique-tag"] }, {id:"other",owner:"someone",name:"English topic"}];
  for (const q of ["english", "target", "unique-tag"])
    assert.deepEqual(selectOwnedRees(rows, query("q="+q)).items.map(dot => dot.id), ["mine"]);
  const result = selectOwnedRees([], query("sample=scale&q=前端&visibility=public&size=24&page=2"));
  assert.ok(result.total > 24);
  assert.equal(result.items.length, 24);
  assert.ok(result.items.every(dot => dot.name.includes("前端") && dot.public && !dot.moderated));
});
test("visibility excludes moderated Rees from public, and filters never change overall account order", () => {
  const before = structuredClone(ownedReeDemoRows());
  assert.equal(selectOwnedRees([], query("sample=scale&visibility=public")).total, 380);
  assert.equal(selectOwnedRees([], query("sample=scale&visibility=private")).total, 220);
  assert.deepEqual(ownedReeDemoRows(), before);
});
test("empty results, invalid parameters and partial final pages stay in bounds", () => {
  assert.deepEqual(ownedReeView(query("page=Infinity&size=999&visibility=bad")), {sample:false,layout:"cards",sort:"default",order:"desc",q:"",visibility:"all",size:12,page:1});
  assert.equal(ownedReeView(query("page=-1")).page, 1);
  const last = selectOwnedRees([], query("sample=scale&size=48&page=999999"));
  assert.equal(last.view.page, 13);
  assert.equal(last.items.length, 24);
  assert.equal(last.start, 577);
  assert.equal(last.end, 600);
  const empty = selectOwnedRees([], query("sample=scale&q=not-found-xyz&page=90"));
  assert.equal(empty.view.page, 1);
  assert.equal(empty.total, 0);
  assert.equal(empty.start, 0);
  assert.equal(empty.end, 0);
});
test("filter and size changes reset pagination, while page links preserve search and visibility", () => {
  const current = query("sample=scale&q=前端&visibility=public&size=48&page=5&ignored=x");
  assert.equal(ownedReePath(current,{page:6}), "/dots?sample=scale&q=%E5%89%8D%E7%AB%AF&visibility=public&size=48&page=6");
  assert.equal(new URL(ownedReePath(current,{q:"design"}),"http://localhost").searchParams.has("page"), false);
  assert.equal(new URL(ownedReePath(current,{size:24}),"http://localhost").searchParams.get("sample"), "scale");
  assert.equal(ownedReePath(query("visibility=all&page=1&ignored=yes")), "/dots");
  assert.equal(current.get("page"), "5");
});
function controller(search, dots = []) {
  let rendered = [], destination, preview;
  const state = {dots,earnedCredits:528000,chats:[]};
  const api = createOwnedRees({
    t:zh=>zh,I:()=>"",esc:String,n:String,title:dot=>dot.name,desc:dot=>dot.description,avatar:()=>'<span class="test-avatar"></span>',
    getState:()=>state,route:()=>({path:"/dots",query:query(search)}),go:path=>destination=path,
    btn:()=>"BUTTON",footer:()=>"",ownedDotCard:dot=>{rendered.push(dot.id);return `<article>${dot.name}</article>`;},
    modal:(...args)=>preview=args,
  });
  return { api,state,rendered,destination:()=>destination,preview:()=>preview };
}
test("600-item renderer invokes card rendering only for current results, with a reachable top and bottom pager", () => {
  const setup = controller("sample=scale&size=24&page=25");
  const before = structuredClone(setup.state), html = setup.api.page();
  assert.equal(setup.rendered.length, 24);
  assert.equal(setup.rendered[0], "owned-ree-scale-0577");
  assert.equal(setup.rendered.at(-1), "owned-ree-scale-0600");
  assert.match(html, /我的 Ree 顶部分页/);
  assert.match(html, /id="owned-ree-jump"/);
  assert.match(html, /577–600/);
  assert.deepEqual(setup.state, before);
});
test("search, visibility and jump controls keep the correct list context", () => {
  const setup = controller("sample=scale&size=48&page=13&visibility=public");
  setup.api.onSubmit({id:"owned-ree-search"}, new Map([["q","  Frontend  "]]));
  let params = new URL(setup.destination(),"http://localhost").searchParams;
  assert.equal(params.get("sample"), "scale");
  assert.equal(params.get("visibility"), "public");
  assert.equal(params.get("q"), "Frontend");
  assert.equal(params.has("page"), false);
  setup.api.onAction("owned-ree-filter", {value:"private"});
  params = new URL(setup.destination(),"http://localhost").searchParams;
  assert.equal(params.get("visibility"), "private");
  assert.equal(params.has("page"), false);
  setup.api.onSubmit({id:"owned-ree-jump"}, new Map([["page","99999"]]));
  assert.equal(new URL(setup.destination(),"http://localhost").searchParams.get("page"), "8");
});
test("sample preview is read-only and available on both ordinary and legacy routes without creating real Rees", () => {
  const setup = controller("sample=scale"), before = structuredClone(setup.state);
  setup.api.onAction("owned-ree-preview", {id:"owned-ree-scale-0600"});
  assert.match(setup.preview()[1], /只读预览/);
  assert.deepEqual(setup.state, before);
  const real = controller("");
  real.api.onAction("owned-ree-preview", {id:"owned-ree-scale-0600"});
  assert.match(real.preview()[1], /只读预览/);
  real.api.onAction("owned-ree-preview", {id:"missing"});
  assert.equal(real.state.dots.length, 0);
});
test("ordinary routes show 600 tests even without existing Rees, and empty filters provide recovery", () => {
  const empty = controller("");
  assert.match(empty.api.page(), /600 个测试 Ree/);
  assert.equal(empty.rendered.length, 12);
  assert.deepEqual(empty.state.dots, []);
  const html = controller("q=not-found", [{id:"mine",owner:"me",name:"Mine",knowledge:[]}]).api.page();
  assert.match(html, /没有匹配的 Ree/);
  assert.match(html, /清除筛选/);
});

test("dashboard keeps full 600-Ree totals while bounding summary rows and charts", () => {
  const state = {dots:structuredClone(ownedReeDemoRows()),payouts:[],earnedCredits:528000};
  const before = structuredClone(state);
  const html = createWorkspace({
    t:zh=>zh,I:()=>"",esc:String,n:String,title:dot=>dot.name,avatar:()=>"",btn:()=>"",shell:html=>html,
    footer:()=>"",getState:()=>state,
  }).page();
  assert.equal((html.match(/class="creator-dot-row"/g) || []).length, 5);
  assert.equal((html.match(/class="creator-answer-row"/g) || []).length, 5);
  assert.equal((html.match(/class="creator-attention-row"/g) || []).length, 5);
  assert.match(html, /查看全部 600 个 Ree/);
  assert.match(html, /还有 .* 个 Ree 需要关注/);
  assert.match(html, /回答最多的 5 个 Ree/);
  assert.deepEqual(state, before);
});

test("switching card and list views preserves the exact search, visibility and page", () => {
  const current = "sample=scale&q=前端&visibility=public&size=48&page=2";
  const setup = controller(current), before = structuredClone(setup.state);
  setup.api.onAction("owned-ree-view", {value:"list"});
  const listPath = setup.destination(), next = new URL(listPath, "http://localhost").searchParams;
  assert.equal(next.get("view"), "list");
  assert.equal(next.get("page"), "2");
  assert.equal(next.get("q"), "前端");
  assert.equal(next.get("size"), "48");
  assert.equal(next.get("visibility"), "public");
  assert.deepEqual(stateIds(current), stateIds(next));
  const restored = controller(next);
  restored.api.onAction("owned-ree-view", {value:"cards"});
  assert.equal(restored.destination(), ownedReePath(query(current)));
  assert.deepEqual(setup.state, before);
  function stateIds(search) { return selectOwnedRees([], query(search)).items.map(dot => dot.id); }
});
test("list mode persists through paging, filters, search, size changes and sample exit", () => {
  const current = query("sample=scale&view=list&size=24&page=8");
  for (const change of [{page:9}, {q:"React"}, {visibility:"private"}, {size:48}, {sample:null}]) {
    const next = new URL(ownedReePath(current, change), "http://localhost").searchParams;
    assert.equal(ownedReeView(next).layout, "list");
  }
  assert.equal(ownedReeView(query("view=anything")).layout, "cards");
  assert.equal(ownedReePath(query("view=anything")), "/dots");
});
test("600-Ree list renders only current rows and sample detail links remain read-only", () => {
  const setup = controller("sample=scale&view=list&size=48&page=13"), before = structuredClone(setup.state);
  const html = setup.api.page();
  assert.equal((html.match(/class="owned-ree-list-row"/g) || []).length, 24);
  assert.equal(setup.rendered.length, 0);
  assert.match(html, /产品设计知识库 · 0577/);
  assert.match(html, /生活与旅行收藏 · 0600/);
  assert.doesNotMatch(html, /owned-ree-scale-0001/);
  assert.match(html, /scope="col"/);
  assert.match(html, /aria-label="列表视图"[^>]*aria-pressed="true"/);
  assert.match(html, /data-action="owned-ree-preview"/);
  assert.doesNotMatch(html, /href="#\/dots\/owned-ree-scale-/);
  assert.deepEqual(setup.state, before);
});
test("real list rows expose the correct knowledge, statistics, video and settings links", () => {
  const dots = [{id:"mine",owner:"me",name:"My Ree",description:"Description",public:true,answers:123456,knowledge:[{status:"ready"},{status:"processing"}]}, {id:"moderated",owner:"me",name:"Taken down",moderated:true,public:true,knowledge:[]}];
  const setup = controller("view=list",dots), before = structuredClone(setup.state), html = setup.api.page();
  for (const path of ["/dots/mine", "/dots/mine/knowledge", "/dots/mine/statistics", "/dots/mine/video", "/dots/mine/settings"])
    assert.ok(html.includes('href="#' + path + '"'), path);
  assert.match(html, /1 个已就绪/);
  assert.match(html, /123456/);
  assert.match(html, /已下架/);
  assert.equal((html.match(/class="owned-ree-list-row"/g) || []).length, 12);
  assert.match(html, /600 个测试 Ree · 保留 2 个原有 Ree/);
  assert.deepEqual(setup.state, before);
});

test("each sort uses the correct full-record value, natural names and stable equal-value order", () => {
  const dots = [
    {id:"ten",owner:"me",name:"Ree 10",answers:10,knowledge:[{status:"failed"},{status:"ready",enabled:false}],knowledgeTrash:Array(30).fill({})},
    {id:"two",owner:"me",name:"ree 2",answers:"2",knowledge:Array(10).fill({status:"ready"})},
    {id:"one",owner:"me",name:"Ree 1",answers:100,knowledge:[]},
    {id:"tie",owner:"me",name:"REE 2",answers:2,knowledge:Array(10).fill({status:"ready"})},
  ];
  const before = structuredClone(dots);
  const expected = {
    "name:asc":["one","two","tie","ten"], "name:desc":["ten","two","tie","one"],
    "sources:asc":["one","ten","two","tie"], "sources:desc":["two","tie","ten","one"],
    "answers:asc":["two","tie","ten","one"], "answers:desc":["one","ten","two","tie"],
  };
  for (const [selection, ids] of Object.entries(expected)) {
    const [sort, order] = selection.split(":");
    assert.deepEqual(selectOwnedRees(dots, query(`sort=${sort}&order=${order}`)).items.map(dot=>dot.id), ids, selection);
  }
  assert.deepEqual(selectOwnedRees(dots,query("")).items.map(dot=>dot.id), ["ten","two","one","tie"]);
  assert.deepEqual(dots, before);
});
test("name sorting follows the displayed language and supports Chinese names", () => {
  const dots = [
    {id:"g",owner:"me",name:"广州",enName:"Zulu"},
    {id:"a",owner:"me",name:"阿里",enName:"Beta"},
    {id:"b",owner:"me",name:"北京",enName:"Alpha"},
  ];
  assert.deepEqual(selectOwnedRees(dots,query("sort=name")).items.map(dot=>dot.id), ["a","b","g"]);
  assert.deepEqual(selectOwnedRees(dots,query("sort=name"),dot=>dot.enName,"en").items.map(dot=>dot.id), ["b","a","g"]);
  assert.equal(selectOwnedRees(dots,query("sort=name")).view.order,"asc");
  assert.equal(selectOwnedRees(dots,query("sort=answers")).view.order,"desc");
});
test("all six sorted 600-Ree catalogs paginate without duplicates, omissions or source mutation", () => {
  const real = structuredClone(ownedReeDemoRows()).map(dot=>({...dot,ownedDemo:false}));
  const original = structuredClone(real), samples = structuredClone(ownedReeDemoRows());
  const collator = new Intl.Collator("zh-Hans-CN",{numeric:true,sensitivity:"base"});
  for (const sample of ["", "sample=scale&"]) {
    for (const sort of ["name","sources","answers"]) {
      for (const order of ["asc","desc"]) {
        const rows = [];
        for (let page=1;page<=13;page++) {
          const result = selectOwnedRees(real, query(`${sample}sort=${sort}&order=${order}&size=48&page=${page}`));
          assert.ok(result.items.length<=48);
          rows.push(...result.items);
        }
        assert.equal(rows.length,600);
        assert.equal(new Set(rows.map(dot=>dot.id)).size,600);
        for (let index=1;index<rows.length;index++) {
          const previous=rows[index-1],current=rows[index];
          const comparison=sort==="name" ? collator.compare(previous.name,current.name)
            : sort==="sources" ? previous.knowledge.length-current.knowledge.length : previous.answers-current.answers;
          assert.ok(order==="asc" ? comparison<=0 : comparison>=0, `${sample}${sort}:${order} at ${index}`);
        }
      }
    }
  }
  assert.equal(selectOwnedRees(real,query("sort=answers&order=desc")).items[0].id,"owned-ree-scale-0600");
  assert.deepEqual(real,original);
  assert.deepEqual(ownedReeDemoRows(),samples);
});
test("sorting combines with full-catalog search and visibility before selecting a page", () => {
  const result=selectOwnedRees([],query("sample=scale&view=list&q=前端&visibility=public&sort=answers&order=desc&size=24&page=2"));
  assert.equal(result.total,100);
  assert.equal(result.start,25);
  assert.equal(result.items.length,24);
  assert.ok(result.items.every(dot=>dot.public && !dot.moderated && dot.name.includes("前端")));
  assert.equal(result.items[0].id,"owned-ree-scale-0452");
  const empty=selectOwnedRees([],query("sample=scale&q=not-found-xyz&sort=sources&order=asc&page=20"));
  assert.equal(empty.total,0);
  assert.equal(empty.view.page,1);
});
test("sort changes reset pagination and keep search, visibility, layout and demo context", () => {
  const current=query("sample=scale&q=前端&visibility=public&view=list&sort=name&order=desc&size=48&page=2");
  for (const change of [{sort:"answers",order:"desc"},{order:"asc"}]) {
    const next=new URL(ownedReePath(current,change),"http://localhost").searchParams;
    assert.equal(next.has("page"),false);
    assert.equal(next.get("q"),"前端");
    assert.equal(next.get("visibility"),"public");
    assert.equal(next.get("sample"),"scale");
    assert.equal(next.get("view"),"list");
    assert.equal(next.get("size"),"48");
  }
  for (const change of [{page:3},{view:null},{q:"design"},{visibility:"private"},{size:24},{sample:null}]) {
    const next=new URL(ownedReePath(current,change),"http://localhost").searchParams;
    assert.equal(next.get("sort"),"name");
    assert.equal(next.get("order"),"desc");
  }
  const reset=new URL(ownedReePath(current,{sort:null,order:null}),"http://localhost").searchParams;
  assert.equal(reset.has("sort"),false);
  assert.equal(reset.has("order"),false);
  assert.equal(reset.has("page"),false);
  assert.equal(ownedReePath(query("sort=invalid&order=invalid")),"/dots");
  assert.equal(ownedReeView(query("sort=answers&order=invalid")).order,"desc");
});
test("sortable headers and shared dropdown reflect active order and toggle direction", () => {
  const current="sample=scale&q=前端&visibility=public&view=list&sort=answers&order=desc&size=24&page=2";
  const setup=controller(current),before=structuredClone(setup.state),html=setup.api.page();
  assert.equal((html.match(/aria-sort="descending"/g)||[]).length,1);
  assert.match(html,/aria-label="按成功回答数升序排序"/);
  assert.match(html,/value="answers:desc" selected/);
  setup.api.onAction("owned-ree-sort",{value:"answers"});
  let next=new URL(setup.destination(),"http://localhost").searchParams;
  assert.equal(next.get("sort"),"answers");
  assert.equal(next.get("order"),"asc");
  assert.equal(next.has("page"),false);
  assert.equal(next.get("q"),"前端");
  assert.equal(next.get("visibility"),"public");
  assert.equal(next.get("view"),"list");
  setup.api.onAction("owned-ree-sort",{value:"name"});
  next=new URL(setup.destination(),"http://localhost").searchParams;
  assert.equal(next.get("order"),"asc");
  setup.api.onAction("owned-ree-sort",{value:"sources"});
  next=new URL(setup.destination(),"http://localhost").searchParams;
  assert.equal(next.get("order"),"desc");
  const ascending=controller("view=list&sort=name&order=asc");
  ascending.api.onAction("owned-ree-sort",{value:"name"});
  assert.equal(new URL(ascending.destination(),"http://localhost").searchParams.get("order"),"desc");
  assert.deepEqual(setup.state,before);
});


function bulkController(dots = [], search = "view=list", extra = {}) {
  let location = "/dots?" + search, pending, saved = 0, renders = 0, api;
  const messages = [], stored = [];
  const state = {signed:true,dots,chats:[{id:"keep-chat"}],earnedCredits:528000,entries:[{id:"keep-entry"}],...extra};
  api = createOwnedRees({
    t:zh=>zh,I:()=>"",esc:value=>String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;"),n:String,
    title:dot=>dot.name,desc:dot=>dot.description,avatar:()=>"",btn:()=>"",footer:()=>"",ownedDotCard:()=>"CARD",modal(){},
    getState:()=>state,route:()=>{const url=new URL(location,"http://localhost");return {path:url.pathname,query:url.searchParams};},
    go:next=>location=next,save(){saved++;if(extra.saveFails)return false;stored.push(structuredClone(state));return true;},
    render(){renders++;api.page();},toast:message=>messages.push(message),
    confirmModal:(heading,body,label,run)=>pending={heading,body,label,run},
  });
  api.page();
  return {api,state,messages,stored,pending:()=>pending,saves:()=>saved,renders:()=>renders,location:()=>location,navigate:next=>location=next,
    check:(id,checked=true)=>api.onChange({target:{dataset:{ownedReeCheck:id},checked}}),
    checkPage:(checked=true)=>api.onChange({target:{dataset:{ownedReePageCheck:""},checked}})};
}
const bulkRows = () => [
  {id:"private",owner:"me",name:"Private <Ree>",public:false,answers:4,fee:20,knowledge:[{id:"source",status:"ready"}]},
  {id:"public",owner:"me",name:"Public",public:true,answers:7,knowledge:[]},
  {id:"down",owner:"me",name:"Taken down",public:true,moderated:true,moderationReason:"Keep this reason",knowledge:[]},
  {id:"untouched",owner:"me",name:"Unselected",public:false,knowledge:[]},
  {id:"other",owner:"other",name:"Another owner",public:true,knowledge:[]},
];

test("bulk visibility plans deduplicate IDs, enforce ownership and preserve moderation", () => {
  const dots=bulkRows(),before=structuredClone(dots),ids=["private","private","public","down","other","missing"];
  const publish=ownedReeVisibilityPlan(dots,ids,"public");
  assert.deepEqual(publish.changes.map(item=>item.id),["private"]);
  assert.deepEqual(publish.blocked,["down"]);
  assert.deepEqual(publish.unchanged,["public"]);
  assert.deepEqual(publish.unavailable,["other","missing"]);
  const hide=ownedReeVisibilityPlan(dots,ids,"private");
  assert.deepEqual(hide.changes.map(item=>item.id),["public","down"]);
  assert.equal(ownedReeVisibilityPlan(dots,ids,"invalid").changes.length,0);
  assert.equal(ownedReeVisibilityPlan(ownedReeDemoRows(),["owned-ree-scale-0003"],"public").changes.length,0);
  assert.deepEqual(dots,before);
});
test("selection spans pages, sorting and page sizes, with explicit select-all-results and clear actions", () => {
  const setup=bulkController([],"sample=scale&view=list");
  setup.checkPage();
  assert.match(setup.api.page(),/已选 12 个/);
  setup.navigate("/dots?sample=scale&view=list&page=2");
  setup.api.page();setup.checkPage();
  assert.match(setup.api.page(),/已选 24 个/);
  assert.match(setup.api.page(),/含其他页 12 个/);
  setup.navigate("/dots?sample=scale&view=list&size=48&sort=answers&order=desc");
  assert.match(setup.api.page(),/已选 24 个/);
  setup.api.onAction("owned-ree-select-filtered",{});
  assert.match(setup.api.page(),/已选 600 个/);
  setup.api.onAction("owned-ree-selection-clear",{});
  assert.match(setup.api.page(),/已选 0 个/);
  setup.check("owned-ree-scale-0600");
  assert.match(setup.api.page(),/已选 1 个/);
  setup.checkPage(false);
  assert.match(setup.api.page(),/已选 0 个/);
});
test("search, visibility, demo or card-view changes clear selection, and stale IDs cannot be selected", () => {
  for (const destination of ["/dots?view=list&q=Private","/dots?view=list&visibility=private","/dots?view=list&sample=scale","/dots"]) {
    const setup=bulkController(bulkRows());setup.check("private");
    setup.navigate(destination);
    const html=setup.api.page();
    if(destination==="/dots") assert.doesNotMatch(html,/id="owned-ree-bulk-host"/);
    else assert.match(html,/已选 0 个/);
  }
  const setup=bulkController(bulkRows());
  setup.check("other");setup.check("missing");
  assert.match(setup.api.page(),/已选 0 个/);
  setup.check("private");setup.state.dots=setup.state.dots.filter(dot=>dot.id!=="private");
  assert.match(setup.api.page(),/已选 0 个/);
});
test("real bulk publish waits for confirmation, updates only eligible selected Rees and saves once", () => {
  const setup=bulkController(bulkRows()),before=structuredClone(setup.state);
  for(const id of ["private","public","down"])setup.check(id);
  setup.api.onAction("owned-ree-bulk-visibility",{value:"public"});
  assert.deepEqual(setup.state,before);
  assert.equal(setup.saves(),0);
  assert.match(setup.pending().heading,/1 个 Ree/);
  assert.match(setup.pending().body,/Private &lt;Ree>/);
  assert.match(setup.pending().body,/1 个已下架 Ree 将跳过/);
  // Cancelling the product dialog leaves both the selection and data unchanged.
  assert.match(setup.api.page(),/已选 3 个/);
  const callback=setup.pending().run;callback();callback();
  before.dots[0].public=true;
  assert.deepEqual(setup.state,before);
  assert.equal(setup.saves(),1);
  assert.equal(setup.stored[0].dots[0].public,true);
  assert.equal(setup.state.dots.find(dot=>dot.id==="down").moderated,true);
  assert.match(setup.api.page(),/已选 0 个/);
  assert.match(setup.messages.at(-1),/跳过 1 个已下架/);
});
test("bulk private retains knowledge, conversations, fees and moderation while updating only visibility", () => {
  const setup=bulkController(bulkRows()),before=structuredClone(setup.state);
  setup.check("public");setup.check("down");
  setup.api.onAction("owned-ree-bulk-visibility",{value:"private"});setup.pending().run();
  before.dots[1].public=false;before.dots[2].public=false;
  assert.deepEqual(setup.state,before);
  assert.equal(setup.saves(),1);
  assert.equal(setup.stored[0].dots[2].moderationReason,"Keep this reason");
});
test("confirmation revalidates ownership, record availability and newly moderated Rees", () => {
  const dots=[...bulkRows(),{id:"removed",owner:"me",name:"Removed",public:false,knowledge:[]}];
  const setup=bulkController(dots);
  for(const id of ["private","untouched","removed"])setup.check(id);
  setup.api.onAction("owned-ree-bulk-visibility",{value:"public"});
  setup.state.dots[0].moderated=true;
  setup.state.dots.find(dot=>dot.id==="untouched").owner="other";
  setup.state.dots=setup.state.dots.filter(dot=>dot.id!=="removed");
  const before=structuredClone(setup.state);setup.pending().run();
  assert.deepEqual(setup.state,before);
  assert.equal(setup.saves(),0);
});
test("stale confirmation cannot apply after a filter change, sign-out or account disable", () => {
  for(const change of [setup=>setup.navigate("/dots?view=list&q=Private"),setup=>setup.state.signed=false,setup=>setup.state.disabled=true]) {
    const setup=bulkController(bulkRows());setup.check("private");
    setup.api.onAction("owned-ree-bulk-visibility",{value:"public"});change(setup);
    const before=structuredClone(setup.state);setup.pending().run();
    assert.deepEqual(setup.state,before);
    assert.equal(setup.saves(),0);
  }
});
test("failed persistence rolls visibility back and retains selection for retry", () => {
  const setup=bulkController(bulkRows(),"view=list",{saveFails:true}),before=structuredClone(setup.state);
  setup.check("private");setup.api.onAction("owned-ree-bulk-visibility",{value:"public"});setup.pending().run();
  assert.deepEqual(setup.state,before);
  assert.equal(setup.saves(),1);
  assert.match(setup.api.page(),/已选 1 个/);
  assert.match(setup.messages.at(-1),/保存失败/);
});
test("600-Ree demo bulk operations use an isolated session without saving or changing the stock catalog", () => {
  const setup=bulkController(bulkRows(),"sample=scale&view=list"),realBefore=structuredClone(setup.state),samplesBefore=structuredClone(ownedReeDemoRows());
  setup.api.onAction("owned-ree-select-filtered",{});
  setup.api.onAction("owned-ree-bulk-visibility",{value:"public"});
  assert.match(setup.pending().heading,/200 个 Ree/);
  assert.match(setup.pending().body,/20 个已下架 Ree 将跳过/);
  setup.pending().run();
  assert.match(setup.api.page(),/class="value">580<small>/);
  assert.equal(setup.saves(),0);
  assert.deepEqual(setup.state,realBefore);
  assert.deepEqual(ownedReeDemoRows(),samplesBefore);
  const fresh=bulkController([],"sample=scale&view=list");
  assert.match(fresh.api.page(),/class="value">380<small>/);
  setup.api.onAction("owned-ree-select-filtered",{});
  setup.api.onAction("owned-ree-bulk-visibility",{value:"private"});setup.pending().run();
  assert.match(setup.api.page(),/class="value">0<small>/);
  assert.match(setup.api.page(),/已下架/);
  assert.deepEqual(ownedReeDemoRows(),samplesBefore);
});
test("ordinary routes allow bulk testing all 600 samples without saving and retain changes across view switches", () => {
  const setup=bulkController(),before=structuredClone(setup.state),samplesBefore=structuredClone(ownedReeDemoRows());
  setup.api.onAction("owned-ree-select-filtered",{});
  setup.api.onAction("owned-ree-bulk-visibility",{value:"public"});
  assert.match(setup.pending().heading,/200 个 Ree/);
  assert.match(setup.pending().body,/真实 Ree 0 个 · 测试 Ree 200 个/);
  setup.pending().run();
  assert.equal(setup.saves(),0);
  setup.navigate("/dots?visibility=public");
  assert.match(setup.api.page(),/共 <strong>580<\/strong>/);
  setup.navigate("/dots?view=list&visibility=public&sort=answers&order=desc");
  assert.match(setup.api.page(),/共 <strong>580<\/strong>/);
  assert.match(bulkController().api.page(),/class="value">380<small>/);
  assert.deepEqual(setup.state,before);
  assert.deepEqual(ownedReeDemoRows(),samplesBefore);
});
test("dashboard and its detail pages share the complete live 604-Ree catalog without fabricating income or records", () => {
  const dots = [
    {id:"mine",owner:"me",name:"Product",public:true,answers:130,knowledge:Array.from({length:4},(_,i)=>({id:"p"+i,title:"Product source",status:"ready",kind:"document"}))},
    {id:"notes",owner:"me",name:"Notes",public:false,answers:43,knowledge:Array.from({length:2},(_,i)=>({id:"n"+i,title:"Note source",status:"ready",kind:"document"}))},
    {id:"library",owner:"me",name:"Library",public:false,answers:0,knowledge:Array.from({length:128},(_,i)=>({id:"l"+i,title:"Library source",status:"ready",kind:"document"}))},
    {id:"empty",owner:"me",name:"Empty",public:false,answers:0,knowledge:[]},
    {id:"external",owner:"someone",name:"External",public:true,answers:999999,knowledge:[{status:"ready"}]},
  ];
  const setup=bulkController(dots,"view=list&sort=answers&order=desc"),before=structuredClone(setup.state);
  const ctx={getState:()=>setup.state,getOwnedRees:setup.api.catalog,t:zh=>zh,I:()=>"",esc:String,n:String,title:dot=>dot.name,
    avatar:()=>"",btn:()=>"",shell:html=>html,footer:()=>""};
  const dashboard=createWorkspace(ctx),details=createWorkspaceDetails(ctx);
  const data=dashboard.summary(),html=dashboard.page();
  assert.equal(data.dots.length,604);
  assert.equal(data.sources.total,4602);
  assert.equal(data.sources.ready,4602);
  assert.equal(data.answers,31088273);
  assert.equal(data.publicDots,381);
  assert.equal(data.privateDots,223);
  assert.equal(data.earned,528000);
  assert.match(html,/查看全部 604 个 Ree/);
  assert.match(html,/381 个公开 · 223 个仅自己或已下架/);
  assert.match(html,/共 604 个 Ree（含 600 个测试 Ree）/);
  assert.match(html,/查看测试 Ree/);
  assert.doesNotMatch(html,/href="#\/dots\/owned-ree-scale-/);
  for(const cls of ["creator-dot-row","creator-attention-row","creator-answer-row"])
    assert.equal((html.match(new RegExp('class="'+cls+'"','g'))||[]).length,5);
  const sources=details.resolve("/workspace/sources",query("")).html;
  assert.match(sources,/全部知识来源<strong>4602<\/strong>/);
  const answers=details.resolve("/workspace/answers",query("view=summary&period=all")).html;
  assert.match(answers,/累计成功回答<strong>31088273<\/strong>/);
  assert.match(answers,/已留存可查看记录<strong>0<\/strong>/);
  assert.match(answers,/共 604 项/);
  assert.doesNotMatch(answers,/href="#\/dots\/owned-ree-scale-/);
  const sampleSources=details.resolve("/workspace/sources",query("dot=owned-ree-scale-0600")).html;
  assert.match(sampleSources,/当前筛选结果<strong>7<\/strong>/);
  assert.match(sampleSources,/测试来源/);
  assert.doesNotMatch(sampleSources,/href="#\/dots\/owned-ree-scale-/);
  setup.check("owned-ree-scale-0600");
  setup.api.onAction("owned-ree-bulk-visibility",{value:"public"});setup.pending().run();
  setup.navigate("/dashboard");setup.api.afterRender();
  assert.equal(dashboard.summary().publicDots,382);
  assert.equal(dashboard.summary().privateDots,222);
  assert.equal(setup.saves(),0);
  assert.deepEqual(setup.state,before);
  const fresh=bulkController(dots);
  assert.equal(createWorkspace({...ctx,getOwnedRees:fresh.api.catalog}).summary().publicDots,381);
  setup.state.dots.push({id:"new",owner:"me",name:"New",public:false,answers:2,knowledge:[{status:"ready"}]});
  assert.equal(dashboard.summary().dots.length,605);
  assert.equal(dashboard.summary().sources.total,4603);
  assert.equal(dashboard.summary().answers,31088275);
  setup.state.dots=setup.state.dots.filter(dot=>dot.id!=="new");
  assert.equal(dashboard.summary().dots.length,604);
});
test("batch publishing and hiding owned test Rees updates discovery results, totals, search and pagination", () => {
  globalThis.window ||= {addEventListener(){}};
  const setup=bulkController(bulkRows(),"view=list&q=围绕"),before=structuredClone(setup.state);
  const catalog=()=>discoveryTestCatalog(setup.state.dots,setup.api.catalog());
  const externalIds=catalog().filter(dot=>dot.owner!=="me").map(dot=>dot.id);
  assert.equal(catalog().length,1381);
  assert.equal(selectDiscoveryDots(catalog(),query("q=生活与旅行收藏 · 0600")).total,0);
  setup.api.onAction("owned-ree-select-filtered",{});
  setup.api.onAction("owned-ree-bulk-visibility",{value:"public"});setup.pending().run();
  setup.navigate("/explore");setup.api.afterRender();
  assert.equal(catalog().length,1581);
  assert.equal(catalog().filter(dot=>dot.ownedDemo).length,580);
  assert.ok(catalog().every(dot=>dot.public&&!dot.moderated));
  assert.equal(selectDiscoveryDots(catalog(),query("q=生活与旅行收藏 · 0600")).total,1);
  for(const size of [24,48,96]) {
    const visited=[];
    for(let page=1;page<=Math.ceil(1581/size);page++) {
      const result=selectDiscoveryDots(catalog(),query(`sort=answers&size=${size}&page=${page}`));
      assert.equal(result.total,1581);
      assert.ok(result.items.length<=size);
      visited.push(...result.items.map(dot=>dot.id));
    }
    assert.equal(new Set(visited).size,1581);
  }
  const discovery=createDiscovery({t:zh=>zh,I:()=>"",esc:String,n:String,getState:()=>setup.state,getOwnedRees:setup.api.catalog,
    publicDots:()=>setup.state.dots,route:()=>({path:"/explore",query:query("")}),go:next=>setup.navigate(next),footer:()=>"",dotCard:dot=>`<article>${dot.name}</article>`});
  assert.match(discovery.page(),/共 <strong>1581<\/strong>/);
  discovery.onSubmit({id:"discovery-page-jump"},new Map([["page","99999"]]));
  assert.equal(setup.location(),"/explore?page=66");
  setup.navigate("/dots?view=list&q=围绕");setup.api.page();
  setup.api.onAction("owned-ree-select-filtered",{});
  setup.api.onAction("owned-ree-bulk-visibility",{value:"private"});setup.pending().run();
  assert.equal(catalog().length,1001);
  assert.equal(selectDiscoveryDots(catalog(),query("q=生活与旅行收藏 · 0600")).total,0);
  assert.match(discovery.page(),/共 <strong>1001<\/strong>/);
  assert.deepEqual(catalog().filter(dot=>dot.owner!=="me").map(dot=>dot.id),externalIds);
  assert.equal(setup.saves(),0);
  assert.deepEqual(setup.state,before);
  assert.equal(discoveryTestCatalog(setup.state.dots,bulkController(bulkRows()).api.catalog()).length,1381);
});
test("mixed real and test batches disclose both counts and persist only real records", () => {
  const setup=bulkController(bulkRows()),before=structuredClone(setup.state),samplesBefore=structuredClone(ownedReeDemoRows());
  setup.check("private");setup.check("owned-ree-scale-0003");
  setup.api.onAction("owned-ree-bulk-visibility",{value:"public"});
  assert.match(setup.pending().heading,/2 个 Ree/);
  assert.match(setup.pending().body,/真实 Ree 1 个 · 测试 Ree 1 个/);
  setup.pending().run();
  before.dots[0].public=true;
  assert.deepEqual(setup.state,before);
  assert.equal(setup.saves(),1);
  assert.deepEqual(setup.stored[0],before);
  setup.navigate("/dots?view=list&q=0003&visibility=public");
  assert.match(setup.api.page(),/共 <strong>1<\/strong>/);
  assert.deepEqual(ownedReeDemoRows(),samplesBefore);
});
test("failed mixed-batch persistence rolls back both real and test changes", () => {
  const setup=bulkController(bulkRows(),"view=list",{saveFails:true}),before=structuredClone(setup.state);
  setup.check("private");setup.check("owned-ree-scale-0003");
  setup.api.onAction("owned-ree-bulk-visibility",{value:"public"});setup.pending().run();
  assert.deepEqual(setup.state,before);
  assert.match(setup.api.page(),/已选 2 个/);
  setup.navigate("/dots?view=list&q=0003&visibility=private");
  assert.match(setup.api.page(),/共 <strong>1<\/strong>/);
});
test("a sample confirmation cannot change a real record that later takes its ID", () => {
  const setup=bulkController();setup.check("owned-ree-scale-0003");
  setup.api.onAction("owned-ree-bulk-visibility",{value:"public"});
  setup.state.dots.push({id:"owned-ree-scale-0003",owner:"me",name:"New real Ree",public:false,knowledge:[]});
  setup.pending().run();
  assert.equal(setup.state.dots[0].public,false);
  assert.equal(setup.saves(),0);
});
test("batch changes preserve active filters and clamp a now-out-of-range last page", () => {
  const dots=structuredClone(ownedReeDemoRows()).map(dot=>({...dot,ownedDemo:false}));
  const setup=bulkController(dots,"view=list&visibility=public&page=32");
  setup.checkPage();setup.api.onAction("owned-ree-bulk-visibility",{value:"private"});setup.pending().run();
  assert.match(setup.api.page(),/361–372/);
  const previousHistory=globalThis.history,previousRaf=globalThis.requestAnimationFrame;
  try {
    globalThis.history={replaceState(_a,_b,path){setup.navigate(path.slice(1));}};
    globalThis.requestAnimationFrame=callback=>callback();
    setup.api.afterRender();
    const parameters=new URL(setup.location(),"http://localhost").searchParams;
    assert.equal(parameters.get("page"),"31");
    assert.equal(parameters.get("visibility"),"public");
    assert.equal(parameters.get("view"),"list");
  } finally {globalThis.history=previousHistory;globalThis.requestAnimationFrame=previousRaf;}
});
test("empty selection, already-matching visibility and inactive accounts cause no writes or dialogs", () => {
  const setup=bulkController(bulkRows());
  setup.api.onAction("owned-ree-bulk-visibility",{value:"public"});
  assert.equal(setup.pending(),undefined);
  setup.check("public");setup.api.onAction("owned-ree-bulk-visibility",{value:"public"});
  assert.equal(setup.pending(),undefined);
  for(const flags of [{signed:false},{disabled:true}]) {
    const blocked=bulkController(bulkRows(),"view=list",flags);blocked.check("private");
    blocked.api.onAction("owned-ree-bulk-visibility",{value:"public"});
    assert.equal(blocked.pending(),undefined);assert.equal(blocked.saves(),0);
  }
});
