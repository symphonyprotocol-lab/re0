import test from "node:test";
import assert from "node:assert/strict";
import { createConversations, conversationSearchReturnPath, conversationTestData } from "../conversations.js";

const escape = value => String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
function fixture() {
  const chats = Array.from({length:320},(_,index)=>({
    id:"chat-"+String(index+1).padStart(4,"0"),
    title:index===12 ? "唯一标题 NeedleTitle" : (index%2 ? "设计研究" : "工程回顾")+" "+String(index+1).padStart(4,"0"),
    dots:[index%2 ? "design" : "code"],
    messages:[{role:"user",text:"问题 "+index},{role:"dot",text:index===319 ? "独特正文 needle-body <script>unsafe()</script>" : "回答内容 "+index}],
    updatedAt:index ? new Date(Date.now()-index*86400000).toISOString() : undefined,
    archivedAt:index%5===0 ? "2026-01-01T00:00:00Z" : undefined,
    pinned:index%11===0,
  }));
  return {signed:true,lang:"zh",earnedCredits:528000,chats:[],chatTrash:[],
    dots:[{id:"code",owner:"me",name:"前端技术搭子"},{id:"design",owner:"other",name:"产品设计顾问"}],
    chatListDemo:{chats,trash:[{id:"trashed",title:"回收站中的讨论",dots:["code"],messages:[{text:"回收站专用关键词"}],deletedAt:new Date().toISOString()}]}};
}
function setup(initial="/chats",state=fixture()) {
  let location=initial,api,saves=0,modals=0,focus=0,confirmation;
  const ui={},events={},navigations=[];
  const nodes=Object.fromEntries(["cl-results","cl-tabs","cl-filter-summary","cl-search","cl-dot","cl-period","cl-sort"].map(id=>["#"+id,{innerHTML:"",value:"",focus(){focus++;}}]));
  globalThis.document={
    addEventListener:(name,fn)=>(events[name]||=[]).push(fn),
    querySelector:selector=>selector==="[data-conversations]" && location.split("?")[0]==="/chats" ? {} : nodes[selector]||null,
    querySelectorAll:()=>[],
  };
  globalThis.history={replaceState(_a,_b,path){location=path.slice(1);}};
  globalThis.window={scrollTo(){}};
  api=createConversations({getState:()=>state,getUi:()=>ui,t:zh=>zh,I:()=>"",esc:escape,n:String,avatar:()=>"",title:dot=>dot.name,
    dotById:id=>state.dots.find(dot=>dot.id===id),route:()=>{const u=new URL(location,"http://localhost");return {path:u.pathname,query:u.searchParams};},
    go:path=>{location=path;navigations.push(path);},save:()=>saves++,render(){api.page();},modal(){modals++;},closeModal(){},
    confirmModal:(_heading,_body,_label,run)=>confirmation=run,toast(){},
    wordmark:()=>"",sidebarAccountFooter:()=>"",iconBtn:()=>"",btn:(label,action)=>`<button data-action="${action}">${label}</button>`,
  });
  return {api,state,ui,nodes,events,navigations,focus:()=>focus,modals:()=>modals,saves:()=>saves,location:()=>location,navigate:path=>location=path,confirm:()=>confirmation()};
}
const resultPaths = html => [...html.matchAll(/class="cl-main" href="#([^"]+)"/g)].map(match=>match[1].replaceAll("&amp;","&"));
const resultIds = html => resultPaths(html).map(path=>new URL(path,"http://localhost").pathname.split("/")[2]);

test("search navigation and keyboard shortcuts open the full page without a modal or bottom history link",async()=>{
  const c=setup("/talk"),before=structuredClone(c.state),sidebar=c.api.sidebar();
  assert.doesNotMatch(sidebar,/查看全部对话|chat-history-all/);
  await c.api.onAction("cl-open-search",{});
  assert.equal(c.location(),"/chats");
  c.api.page();c.api.afterRender();
  assert.equal(c.focus(),1);
  assert.equal(c.modals(),0);
  c.navigate("/dashboard");
  for(const handler of c.events.keydown) handler({metaKey:true,ctrlKey:false,key:"k",preventDefault(){},stopImmediatePropagation(){}});
  assert.equal(c.location(),"/chats");
  assert.equal(c.modals(),0);
  assert.deepEqual(c.state,before);
});
test("the default page includes archives, excludes trash and renders only the current 20 results",()=>{
  const c=setup(),before=structuredClone(c.state),html=c.api.page();
  assert.match(html,/>搜索对话<\/h1>/);
  assert.match(html,/共 320 场对话 · 包含已归档对话/);
  assert.equal(resultIds(html).length,20);
  assert.match(html,/已归档/);
  assert.doesNotMatch(html,/回收站专用关键词|cl-global-search|role="dialog"/);
  assert.deepEqual(c.state,before);
  assert.equal(c.saves(),0);
});
test("full-history search matches titles, message text and Ree names with escaped snippets",()=>{
  for(const [query,count,id] of [["needletitle",1,"chat-0013"],["needle-body",1,"chat-0320"],["前端技术搭子",160,null]]) {
    const c=setup("/chats?q="+encodeURIComponent(query)),html=c.api.page();
    assert.match(html,new RegExp("找到 "+count+" 场匹配对话"));
    if(id) assert.deepEqual(resultIds(html),[id]);
    if(query==="needle-body") {
      assert.match(html,/正文匹配/);
      assert.match(html,/<mark>needle-body<\/mark>/);
      assert.match(html,/&lt;script&gt;/);
      assert.doesNotMatch(html,/<script>/);
    }
  }
});
test("Ree and update-time filters combine before sorting and pagination",()=>{
  const c=setup("/chats?dot=code&days=7&sort=title"),html=c.api.page();
  assert.deepEqual(resultIds(html),["chat-0003","chat-0005","chat-0007"]);
  assert.match(html,/部分旧对话未记录时间/);
  assert.match(html,/找到 3 场匹配对话/);
});
test("all 320 conversations paginate without omissions or duplicates at 20, 50 and 100 per page",()=>{
  const c=setup(),before=structuredClone(c.state);
  for(const size of [20,50,100]) {
    const ids=[];
    for(let page=1;page<=Math.ceil(320/size);page++) {
      c.navigate(`/chats?size=${size}&page=${page}`);
      const current=resultIds(c.api.page());
      assert.ok(current.length<=size);
      ids.push(...current);
    }
    assert.equal(ids.length,320);
    assert.equal(new Set(ids).size,320);
  }
  c.navigate("/chats?size=50&page=99999");
  assert.match(c.api.page(),/第 301–320 项，共 320 项/);
  c.api.afterRender();
  assert.equal(new URL(c.location(),"http://localhost").searchParams.get("page"),"7");
  assert.deepEqual(c.state,before);
});
test("result links preserve the complete search and the same controller follows back/forward query changes",async()=>{
  const c=setup("/chats?q=needle-body&sort=old&size=50");
  const path=resultPaths(c.api.page())[0],back=new URL(path,"http://localhost").searchParams.get("from");
  assert.equal(back,"/chats?q=needle-body&sort=old&size=50");
  c.navigate(path);await c.api.onAction("cl-open-search",{});
  assert.equal(c.location(),back);
  assert.deepEqual(resultIds(c.api.page()),["chat-0320"]);
  c.navigate("/chats?q=NeedleTitle");
  assert.deepEqual(resultIds(c.api.page()),["chat-0013"]);
  c.navigate(back);
  assert.deepEqual(resultIds(c.api.page()),["chat-0320"]);
  assert.deepEqual(resultIds(setup(back,c.state).api.page()),["chat-0320"]);
});
test("live search, clearing and scope tabs keep URL, counts and controls synchronized",async()=>{
  const c=setup();c.api.page();
  c.nodes["#cl-search"].value="needle-body";
  for(const handler of c.events.input) handler({target:{id:"cl-search",value:"needle-body"}});
  assert.match(c.nodes["#cl-filter-summary"].innerHTML,/找到 1 场匹配对话/);
  assert.match(c.location(),/q=needle-body/);
  assert.deepEqual(resultIds(c.nodes["#cl-results"].innerHTML),["chat-0320"]);
  assert.match(c.nodes["#cl-tabs"].innerHTML,/data-value="archived"[^>]*>已归档<span>0<\/span>/);
  await c.api.onAction("cl-search-clear",{});
  assert.equal(c.nodes["#cl-search"].value,"");
  assert.equal(c.location(),"/chats");
  assert.match(c.nodes["#cl-filter-summary"].innerHTML,/共 320 场对话/);
  await c.api.onAction("cl-tab",{value:"trash"});
  assert.match(c.api.page(),/回收站中的讨论/);
  assert.doesNotMatch(c.api.page(),/唯一标题/);
});
test("empty results recover without changing data, and return URLs reject external or unrelated destinations",async()=>{
  const c=setup("/chats?q=not-found-xyz"),before=structuredClone(c.state);
  assert.match(c.api.page(),/没有匹配的对话/);
  assert.equal(resultIds(c.api.page()).length,0);
  await c.api.onAction("cl-reset",{});
  assert.equal(c.location(),"/chats");
  assert.equal(resultIds(c.api.page()).length,20);
  assert.deepEqual(c.state,before);
  for(const value of ["https://example.org/chats","//example.org","/chats/other","/chats-evil","/settings"])
    assert.equal(conversationSearchReturnPath(value),"/chats");
  assert.equal(conversationSearchReturnPath("/chats?q=design&dot=code&days=7&sort=old&page=2&size=50&ignored=yes"),"/chats?q=design&dot=code&days=7&sort=old&page=2&size=50");
});
test("selecting a conversation from its existing menu still enters the search page with that item selected",async()=>{
  const c=setup("/chats?q=needle-body");c.api.page();
  c.navigate("/chats/chat-0001");
  await c.api.onAction("cl-select-one",{id:"chat-0001"});
  const html=c.api.page();
  assert.match(html,/cl-search-page[^>]*is-selecting/);
  assert.match(html,/data-conversation-check="chat-0001"[^>]*checked/);
  assert.match(html,/已选择 1 场对话/);
});
test("a normal search visit initializes 320 test chats once without changing original chats, messages or balance",()=>{
  const state=fixture();delete state.chatListDemo;
  state.chats=[{id:"sample-chat-001",title:"Original chat",dots:["code"],messages:[{role:"user",text:"Keep this message"}]}];
  const original=structuredClone(state),c=setup("/chats",state);
  assert.match(c.api.page(),/共 321 场对话/);
  assert.match(c.api.page(),/320 场测试对话 · 保留 1 场原有对话/);
  assert.equal(state.chatListDemo.chats.length,320);
  assert.equal(new Set([...state.chats,...state.chatListDemo.chats].map(chat=>chat.id)).size,321);
  assert.equal(c.saves(),1);
  assert.deepEqual({...state,chatListDemo:undefined},{...original,chatListDemo:undefined});
  assert.equal(c.api.findChat("sample-chat-001"),state.chats[0]);
  assert.equal(c.api.findChat("sample-chat-001-test"),state.chatListDemo.chats[0]);
  assert.ok(state.chatListDemo.chats.every(chat=>new Set(chat.dots).size===chat.dots.length));
});
test("existing 320 saved tests merge with three originals and paginate in the normal route without legacy parameters",()=>{
  const state=fixture();state.chats=Array.from({length:3},(_,i)=>({id:"original-"+i,title:"Original "+i,dots:[],messages:[]}));
  const c=setup("/chats",state),before=structuredClone(state);
  assert.match(c.api.page(),/共 323 场对话/);
  for(const size of [20,50,100]) {
    const ids=[];
    for(let page=1;page<=Math.ceil(323/size);page++) {
      c.navigate(`/chats?size=${size}&page=${page}`);
      const html=c.api.page();
      ids.push(...resultIds(html));
      assert.ok(resultPaths(html).every(path=>!new URL(path,"http://localhost").searchParams.get("from").includes("sample=")));
    }
    assert.equal(ids.length,323);
    assert.equal(new Set(ids).size,323);
  }
  assert.deepEqual(state,before);
  assert.equal(c.saves(),0);
  c.navigate("/chats?sample=scale");
  assert.match(c.api.page(),/共 320 场对话/);
});
test("mixed trash and restore operations keep test and original records in their own storage",async()=>{
  const state=fixture(),real={id:"original",title:"Original",dots:[],messages:[{role:"user",text:"Keep original content"}]};
  state.chats=[real];
  const c=setup("/chats",state),before=structuredClone(state);
  c.api.page();
  await c.api.onAction("cl-select-one",{id:"original"});
  await c.api.onAction("cl-select-one",{id:"chat-0002"});
  await c.api.onAction("cl-trash-selected",{});c.confirm();
  assert.equal(state.chats.length,0);
  assert.deepEqual(state.chatTrash.map(chat=>chat.id),["original"]);
  assert.equal(state.chatListDemo.chats.length,319);
  assert.ok(state.chatListDemo.trash.some(chat=>chat.id==="chat-0002"));
  assert.equal(c.api.findChat("chat-0002"),undefined);
  await c.api.onAction("cl-tab",{value:"trash"});
  await c.api.onAction("cl-select-one",{id:"original"});
  await c.api.onAction("cl-select-one",{id:"chat-0002"});
  await c.api.onAction("cl-restore-selected",{});
  assert.deepEqual(state.chats,before.chats);
  assert.deepEqual(state.chatTrash,[]);
  assert.equal(state.chatListDemo.chats.length,320);
  assert.deepEqual(state.chatListDemo.chats.find(chat=>chat.id==="chat-0002"),before.chatListDemo.chats[1]);
  assert.deepEqual(state.chatListDemo.trash,before.chatListDemo.trash);
  assert.equal(state.earnedCredits,528000);
  assert.equal(c.saves(),2);
});
test("saved tests in Trash are retained and sample generation also works for an account without Rees",()=>{
  const state=fixture(),saved=state.chatListDemo.chats;
  state.chatListDemo={chats:[],trash:saved.map(chat=>({...chat,deletedAt:new Date().toISOString()}))};
  const c=setup("/chats",state),before=structuredClone(state);
  assert.equal(resultIds(c.api.page()).length,0);
  assert.equal(state.chatListDemo.chats.length,0);
  c.navigate("/chats?view=trash");
  assert.match(c.api.page(),/共 320 项/);
  assert.deepEqual(state,before);
  const empty=conversationTestData([]);
  assert.equal(empty.chats.length,320);
  assert.ok(empty.chats.every(chat=>chat.dots.length===0&&chat.messages.every(message=>message.role==="user")));
});
const sidebarIds = html => [...html.matchAll(/class="chat-history-row [^"]*"><a href="#\/chats\/([^"]+)"/g)].map(match=>match[1]);
test("sidebar uses all active original and test chats for pinned and recent groups without search filters or truncation",()=>{
  const state=fixture();
  state.chats=[
    {id:"real-pin",title:"Original pinned",pinned:true,updatedAt:new Date(Date.now()+10000).toISOString(),dots:[],messages:[]},
    {id:"real-recent",title:"Original recent",updatedAt:new Date(Date.now()+5000).toISOString(),dots:[],messages:[]},
    {id:"real-archived",title:"Original archived",archivedAt:"2026-01-01",dots:[],messages:[]},
  ];
  const c=setup("/chats?q=not-found&view=trash",state),before=structuredClone(state),html=c.api.sidebar();
  const ids=sidebarIds(html);
  assert.equal(ids.length,258);
  assert.equal(new Set(ids).size,258);
  assert.equal(ids[0],"real-pin");
  assert.ok(ids.includes("real-recent"));
  assert.ok(ids.includes("chat-0320"));
  assert.ok(!ids.includes("real-archived")&&!ids.includes("chat-0001")&&!ids.includes("trashed"));
  assert.match(html,/置顶<span class="chat-history-count">25<\/span>/);
  assert.match(html,/最近对话<span class="chat-history-count">233<\/span>/);
  assert.equal((html.match(/class="chat-history-test"/g)||[]).length,256);
  assert.deepEqual(state,before);
  c.navigate("/chats/chat-0001");
  const current=c.api.sidebar();
  assert.match(current,/当前对话/);
  assert.match(current,/chat-history-row active[^>]*><a href="#\/chats\/chat-0001"/);
  assert.equal(sidebarIds(current).filter(id=>id==="chat-0001").length,1);
});
test("pin, unpin and archive operations immediately update sidebar membership and counts from the same test records",async()=>{
  const c=setup(),messages=structuredClone(c.state.chatListDemo.chats[1].messages);
  assert.match(c.api.sidebar(),/置顶<span class="chat-history-count">24<\/span>/);
  await c.api.onAction("cl-pin",{id:"chat-0002"});
  assert.match(c.api.sidebar(),/置顶<span class="chat-history-count">25<\/span>/);
  assert.equal(c.state.chatListDemo.chats[1].pinned,true);
  await c.api.onAction("cl-pin",{id:"chat-0002"});
  assert.match(c.api.sidebar(),/置顶<span class="chat-history-count">24<\/span>/);
  await c.api.onAction("cl-archive",{id:"chat-0002"});c.confirm();
  assert.ok(!sidebarIds(c.api.sidebar()).includes("chat-0002"));
  assert.match(c.api.sidebar(),/最近对话<span class="chat-history-count">231<\/span>/);
  assert.deepEqual(c.state.chatListDemo.chats[1].messages,messages);
  assert.equal(c.state.earnedCredits,528000);
  assert.deepEqual(c.state.chats,[]);
});
