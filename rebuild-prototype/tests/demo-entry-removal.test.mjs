import test from "node:test";
import assert from "node:assert/strict";
import { createKnowledge } from "../knowledge.js";
import { createConversations } from "../conversations.js";
import { createOwnedRees, ownedReeDemoRows } from "../owned-rees.js";

globalThis.document={addEventListener(){}};
function context() {
  let path="/dots/knowledge-demo/knowledge",saves=0;
  const dot={id:"knowledge-demo",slug:"knowledge-management-demo",name:"Saved library",owner:"me",public:false,answers:0,
    knowledge:Array.from({length:128},(_,i)=>({id:"source-"+i,title:"Saved source "+i,kind:"text",content:"Preserve this text",status:"ready",createdAt:"2026-10-30T08:24:00Z"}))};
  dot.knowledge[0].pages=Array.from({length:148},(_,i)=>({id:"page-"+i,title:"Page "+i,content:"Saved page"}));
  dot.knowledge[1].files=Array.from({length:117},(_,i)=>({id:"file-"+i,path:"file-"+i,content:"Saved file"}));
  const state={signed:true,lang:"zh",dots:[dot],chats:[],chatTrash:[],earnedCredits:42,
    chatListDemo:{chats:Array.from({length:320},(_,i)=>({id:"saved-chat-"+i,title:"Saved chat "+i,dots:[dot.id],messages:[{role:"user",text:"Keep message "+i}],createdAt:"2026-10-31T08:00:00Z"})),trash:[]}};
  const ui={};
  const ctx={getState:()=>state,getUi:()=>ui,t:zh=>zh,I:()=>"",esc:String,n:String,title:dot=>dot.name,desc:()=>"",avatar:()=>"",shell:html=>html,
    route:()=>{const url=new URL(path,"http://localhost");return {path:url.pathname,query:url.searchParams};},
    dotById:id=>state.dots.find(dot=>dot.id===id),save:()=>saves++,go(){},render(){},kinds:{text:["文本","Text","text"]},
    btn:(label,action)=>`<button data-action="${action}">${label}</button>`,iconBtn:()=>"",footer:()=>"",ownedDotCard:dot=>`<article>${dot.name}</article>`,
  };
  return {ctx,state,saves:()=>saves,setPath:value=>path=value};
}
test("removing the 128-source entry retains the saved library and nested pages/files",()=>{
  for(const id of ["knowledge-demo","mine"]) {
    const c=context();c.state.dots[0].id=id;c.setPath("/dots/"+id+"/knowledge");
    const before=structuredClone(c.state),api=createKnowledge(c.ctx);
    const result=api.resolve("/dots/"+id+"/knowledge");
    assert.match(result.html,/知识管理/);
    assert.match(result.html,/>128<\/span>/);
    assert.match(result.html,/添加知识/);
    assert.doesNotMatch(result.html,/体验 128|Try 128|data-action="knowledge-demo"/);
    assert.equal(c.saves(),0);
    assert.deepEqual(c.state,before);
  }
});
test("the 320 saved conversations still render through their existing route without an experience entry",()=>{
  const c=context();c.setPath("/chats?sample=scale");
  const before=structuredClone(c.state),api=createConversations(c.ctx),html=api.page();
  assert.match(html,/320/);
  assert.match(html,/Saved chat/);
  assert.doesNotMatch(html,/体验 320|Try 320|data-action="cl-demo"/);
  c.setPath("/chats");
  assert.doesNotMatch(api.page(),/体验 320|Try 320|data-action="cl-demo"/);
  assert.equal(c.saves(),0);
  assert.deepEqual(c.state,before);
});
test("removing the 600-Ree entry keeps its independent directory and legacy URL available",()=>{
  const c=context();c.setPath("/dots?sample=scale");
  const before=structuredClone(c.state),samples=structuredClone(ownedReeDemoRows()),api=createOwnedRees(c.ctx),html=api.page();
  assert.match(html,/600/);
  assert.doesNotMatch(html,/体验 600|Try 600|退出规模演示|Leave scale demo/);
  c.setPath("/dots");
  assert.doesNotMatch(api.page(),/体验 600|Try 600/);
  assert.equal(ownedReeDemoRows().length,600);
  assert.deepEqual(ownedReeDemoRows(),samples);
  assert.equal(c.saves(),0);
  assert.deepEqual(c.state,before);
});
