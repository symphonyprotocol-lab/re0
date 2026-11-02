import test from "node:test";
import assert from "node:assert/strict";
import { discoveryDemoDots, discoveryDemoDot, selectDiscoveryDots, discoveryPath, discoveryView, discoveryPageNumbers, createDiscovery, discoveryTestCatalog, DISCOVERY_TEST_COUNT } from "../discovery.js";
import { discoveryReturnPath } from "../public-dot.js";
const query = value => new URLSearchParams(value);

test("1,200 demo Rees stay separate from account data, with stable unique detail identities", () => {
  const real = [{ id:"real", name:"My Ree", public:true, owner:"me", knowledge:[] }];
  const before = structuredClone(real);
  const catalog = discoveryDemoDots();
  assert.equal(catalog.length, 1200);
  assert.equal(new Set(catalog.map(dot => dot.id)).size, 1200);
  assert.ok(catalog.every(dot => dot.discoveryDemo && dot.owner !== "me"));
  assert.equal(discoveryDemoDot("discovery-scale-1200"), catalog.at(-1));
  assert.equal(discoveryDemoDot("discovery-scale-0000"), undefined);
  assert.equal(discoveryDemoDot("discovery-scale-1201"), undefined);
  const result = selectDiscoveryDots(real, query("sample=scale"));
  assert.equal(result.total, 1200);
  assert.equal(result.items.length, 24);
  assert.deepEqual(real, before);
});
test("paging the full catalog has no omissions or duplicates, and never renders more than the selected page size", () => {
  const visited = new Set();
  for (let page=1; page<=50; page++) {
    const result = selectDiscoveryDots([], query(`sample=scale&page=${page}`));
    assert.equal(result.pages, 50);
    assert.equal(result.items.length, 24);
    assert.equal(result.start, (page-1)*24+1);
    for (const dot of result.items) { assert.equal(visited.has(dot.id), false); visited.add(dot.id); }
  }
  assert.equal(visited.size, 1200);
  const last = selectDiscoveryDots([], query("sample=scale&size=96&page=99999"));
  assert.equal(last.view.page, 13);
  assert.equal(last.items.length, 48);
  assert.equal(last.end, 1200);
});
test("search, classification and sorting apply to the full catalog before pagination without mutating its order", () => {
  const originalIds = discoveryDemoDots().map(dot=>dot.id);
  const result = selectDiscoveryDots([], query("sample=scale&q=React&category=technology&sort=answers"));
  assert.ok(result.total > 24);
  assert.ok(result.items.every(dot => dot.category === "technology" && dot.name.includes("React")));
  assert.ok(result.items.every((dot,index) => !index || result.items[index-1].answers >= dot.answers));
  const fees = selectDiscoveryDots([], query("sample=scale&sort=free&size=96"));
  assert.ok(fees.items.every((dot,index) => !index || fees.items[index-1].fee <= dot.fee));
  assert.deepEqual(discoveryDemoDots().map(dot=>dot.id), originalIds);
  const empty = selectDiscoveryDots([], query("sample=scale&q=unmatched-zzzz&page=50"));
  assert.equal(empty.view.page, 1);
  assert.equal(empty.total, 0);
  assert.equal(empty.start, 0);
  assert.deepEqual(empty.items, []);
});
test("public owned Rees enter discovery while private and moderated Rees stay hidden", () => {
  const rows = [{id:"private",public:false},{id:"owned",public:true,owner:"me"},{id:"hidden",public:true,moderated:true},{id:"visible",public:true,owner:"someone"}];
  const result = selectDiscoveryDots(rows, query(""));
  assert.deepEqual(result.items.map(dot=>dot.id), ["owned", "visible"]);
});
test("filter changes reset page and keep demo context, while detail returns preserve page and page size", () => {
  const current = query("sample=scale&q=React&category=technology&sort=answers&size=48&page=15");
  const next = discoveryPath(current, {category:"design"});
  assert.equal(next, "/explore?sample=scale&q=React&category=design&sort=answers&size=48");
  const origin = discoveryPath(current, {page:16});
  assert.equal(discoveryReturnPath(origin), "/explore?sample=scale&q=React&category=technology&sort=answers&size=48&page=16");
  assert.equal(discoveryView(query("page=Infinity&size=9999&sort=bad&category=bad")).page, 1);
  assert.equal(discoveryView(query("size=9999")).size, 24);
  assert.equal(discoveryPath(query("next=https://example.org&page=-3")), "/explore");
});
test("pagination stays compact near the start, middle and end", () => {
  assert.deepEqual(discoveryPageNumbers(1,50), [1,2,null,50]);
  assert.deepEqual(discoveryPageNumbers(25,50), [1,null,24,25,26,null,50]);
  assert.deepEqual(discoveryPageNumbers(50,50), [1,null,49,50]);
});
test("the 1,200-item page invokes the card renderer only for the current 24 results", () => {
  globalThis.document = { addEventListener(){} };
  globalThis.window = { addEventListener(){} };
  let rendered = 0;
  const page = createDiscovery({
    t:zh=>zh,I:()=>"",esc:String,n:String,
    route:()=>({path:"/explore",query:query("sample=scale")}),go(){},
    footer:()=>"",publicDots:()=>[],
    dotCard:dot=>{rendered++;return `<article>${dot.name}</article>`;},
  }).page();
  assert.equal(rendered, 24);
  assert.match(page, /共 <strong>1200<\/strong>/);
  assert.match(page, /id="discovery-page-jump"/);
  assert.match(page, /class="discovery-toolbar"/);
  assert.doesNotMatch(page, /discovery-scale-1200/);
});


test("the default directory keeps 1,000 external Rees plus public owned Rees without overwriting identities", () => {
  const state={dots:[
    {id:"real",slug:"real",name:"Real",owner:"Creator",public:true,knowledge:[{id:"keep"}]},
    {id:"discovery-scale-0001",slug:"blocked-sample",owner:"me",public:true},
    {id:"hidden",slug:"discovery-scale-0002",owner:"Creator",public:false},
    {id:"taken-down",slug:"down",owner:"Creator",public:true,moderated:true},
  ],chats:[{id:"keep-chat"}],earnedCredits:528000};
  const before=structuredClone(state),catalog=discoveryTestCatalog(state.dots);
  assert.equal(DISCOVERY_TEST_COUNT,1000);
  assert.equal(catalog.length,1001);
  assert.equal(catalog[0],state.dots[1]);
  assert.equal(catalog[1],state.dots[0]);
  assert.equal(new Set(catalog.map(dot=>dot.id)).size,1001);
  assert.equal(new Set(catalog.map(dot=>dot.slug)).size,1001);
  assert.ok(catalog.every(dot=>dot.public&&!dot.moderated));
  assert.equal(catalog.find(dot=>dot.id==="discovery-scale-0001"),state.dots[1]);
  assert.ok(!catalog.some(dot=>dot.slug==="discovery-scale-0002"));
  assert.deepEqual(state,before);
  const many=Array.from({length:1005},(_,i)=>({id:"actual-"+i,slug:"actual-"+i,owner:"Creator",public:true}));
  assert.deepEqual(discoveryTestCatalog(many),many);
});
test("all 1,000 default records paginate exactly once at 24, 48 and 96 per page", () => {
  const catalog=discoveryTestCatalog([]),before=structuredClone(catalog);
  for(const size of [24,48,96]) {
    const pages=Math.ceil(1000/size),visited=[];
    for(let page=1;page<=pages;page++) {
      const result=selectDiscoveryDots(catalog,query(`size=${size}&page=${page}`));
      assert.equal(result.total,1000);
      assert.equal(result.pages,pages);
      assert.ok(result.items.length<=size);
      assert.equal(result.start,(page-1)*size+1);
      visited.push(...result.items.map(dot=>dot.id));
    }
    assert.equal(visited.length,1000);
    assert.equal(new Set(visited).size,1000);
    const last=selectDiscoveryDots(catalog,query(`size=${size}&page=99999`));
    assert.equal(last.view.page,pages);
    assert.equal(last.end,1000);
    assert.equal(last.items.length,size===24?16:40);
  }
  assert.deepEqual(catalog,before);
  assert.equal(discoveryDemoDots().length,1200);
  assert.equal(discoveryDemoDot("discovery-scale-1200").id,"discovery-scale-1200");
});
test("the default 1,000-record directory supports full-catalog search, categories and sorting", () => {
  const catalog=discoveryTestCatalog([]),original=catalog.map(dot=>dot.id);
  assert.equal(selectDiscoveryDots(catalog,query("q=1000")).items[0].id,"discovery-scale-1000");
  assert.equal(selectDiscoveryDots(catalog,query("q=1200")).total,0);
  assert.equal(selectDiscoveryDots(catalog,query("sample=scale&q=1200")).items[0].id,"discovery-scale-1200");
  const filtered=selectDiscoveryDots(catalog,query("q=React&category=technology&sort=answers&size=24&page=2"));
  assert.ok(filtered.total>24);
  assert.ok(filtered.items.every(dot=>dot.name.includes("React")&&dot.category==="technology"));
  for(const sort of ["answers","free"]) {
    const results=[];
    for(let page=1;page<=11;page++) results.push(...selectDiscoveryDots(catalog,query(`sort=${sort}&size=96&page=${page}`)).items);
    assert.equal(results.length,1000);
    assert.ok(results.every((dot,index)=>!index||(sort==="answers"?results[index-1].answers>=dot.answers:results[index-1].fee<=dot.fee)));
  }
  const empty=selectDiscoveryDots(catalog,query("q=unmatched-zzzz&page=40"));
  assert.equal(empty.total,0);assert.equal(empty.view.page,1);
  assert.deepEqual(catalog.map(dot=>dot.id),original);
});
test("the normal discovery page renders 24 of 1,000 and jump uses the same directory", () => {
  globalThis.document={addEventListener(){}};globalThis.window={addEventListener(){}};
  const state={dots:[{id:"real",slug:"real",name:"Real",owner:"Creator",public:true}],chats:[{id:"keep"}],earnedCredits:7};
  let rendered=0,destination;
  const before=structuredClone(state),api=createDiscovery({
    t:zh=>zh,I:()=>"",esc:String,n:String,getState:()=>state,
    route:()=>({path:"/explore",query:query("")}),go:path=>destination=path,
    footer:()=>"",publicDots:()=>state.dots,dotCard:dot=>{rendered++;return `<article>${dot.name}</article>`;},
  });
  const html=api.page();
  assert.equal(rendered,24);
  assert.match(html,/共 <strong>1000<\/strong>/);
  assert.doesNotMatch(html,/discovery-scale-toggle|退出规模演示|data-action="[^"]*demo"/);
  api.onSubmit({id:"discovery-page-jump"},new Map([["page","99999"]]));
  assert.equal(destination,"/explore?page=42");
  assert.deepEqual(state,before);
});
