import test from "node:test";
import assert from "node:assert/strict";
import { createExperience } from "../experience.js";
import { createConversations } from "../conversations.js";
import { createWorkspace } from "../workspace.js";

globalThis.document = { addEventListener() {}, querySelector() { return null; } };
function setup(initial = {}, initialPath = "/dashboard") {
  const state = {
    signed: true,
    chats: [{ id: "existing", messages: [{ text: "keep" }] }],
    dots: [{ id: "mine", knowledge: [{ id: "source" }] }],
    ...initial,
  };
  const ui = {},
    navigations = [],
    messages = [];
  let path = initialPath;
  const ctx = {
    getState: () => state,
    getUi: () => ui,
    t: (zh) => zh,
    I: () => "",
    esc: (s) => String(s),
    wordmark: () => "",
    route: () => {
      const url = new URL(path, "http://localhost");
      return { path: url.pathname, query: url.searchParams };
    },
    go: (next) => {
      path = next;
      navigations.push(next);
    },
    save() {},
    render() {},
    toast: (s) => messages.push(s),
    mine: () => [],
    publicDots: () => [],
    title: (b) => b.name,
    avatar: () => "",
    shell: (s) => s,
    uid: () => "new-chat",
    dotById: () => null,
    chatRoom: { draftChat: () => ({ dots: [] }), composer: () => '<form id="compose" data-context="draft:conversation"></form>' },
  };
  return { api: createExperience(ctx), state, ui, navigations, messages, ctx };
}
test("first sign-in opens the dashboard without requiring a mode choice", () => {
  const { api, navigations, state } = setup();
  const before = structuredClone(state);
  api.signIn("/dashboard");
  assert.deepEqual(navigations, ["/dashboard"]);
  assert.deepEqual(state, before);
});
test("old preferences do not split the dashboard or change stored account data", () => {
  for (const preference of ["chat", "creator", undefined]) {
    const { api, state, navigations } = setup({ preferredMode: preference, experienceMode: preference });
    const before = structuredClone(state);
    api.signIn();
    assert.equal(navigations[0], "/dashboard");
    for (const path of ["/dashboard", "/dots/mine/knowledge", "/chats", "/workspace/answers"])
      assert.equal(api.resolve(path, new URLSearchParams()), null);
    assert.deepEqual(state, before);
  }
});
test("legacy workspace and welcome entries open the dashboard while talk has a dedicated creation page", () => {
  const { api } = setup();
  for (const path of ["/workspace", "/welcome"])
    assert.deepEqual(api.resolve(path, new URLSearchParams("edit=1")), { redirect: "/dashboard" });
  const talk = api.resolve("/talk", new URLSearchParams());
  assert.equal(talk.title,"新建对话");
  assert.match(talk.html,/class="new-conversation-page"/);
  assert.match(talk.html,/id="compose"/);
  assert.doesNotMatch(talk.html,/creator-metrics|我的空间概览|收入与提现|dashboard-recent/);
  assert.deepEqual(api.resolve("/welcome", new URLSearchParams("next=/dots/mine/knowledge?folder=product")), {
    redirect: "/dots/mine/knowledge?folder=product",
  });
});
test("sign-in preserves explicit internal destinations and rejects external URLs or auth loops", () => {
  for (const target of ["/talk", "/dots/mine/knowledge?folder=product", "/workspace/answers?view=records&period=week", "/checkout?kind=pack"] ) {
    const { api, navigations } = setup();
    api.signIn(target);
    assert.equal(navigations[0], target);
  }
  for (const target of ["https://evil.test", "//evil.test", "/\\evil.test", "/login", "/welcome", "/admin/overview", "/dots\n/test"]) {
    const { api, navigations } = setup();
    api.signIn(target);
    assert.equal(navigations[0], "/dashboard", target);
  }
});
test("guest deep links keep query parameters through sign-in", () => {
  const { api } = setup({ signed: false });
  for (const path of ["/talk", "/dashboard", "/workspace/answers", "/dots/mine/knowledge"]) {
    const result = api.resolve(path, new URLSearchParams("folder=design&view=records"));
    assert.equal(new URL(result.redirect, "http://localhost").searchParams.get("next"), path + "?folder=design&view=records");
  }
});
test("new conversation clears only the draft and opens its dedicated page", async () => {
  const { api, ctx, ui, navigations, state } = setup({ experienceMode: "creator" }, "/dots/mine/knowledge");
  const before = structuredClone(state);
  ui.chatDrafts = { "draft:conversation": "discard this draft", "chat:existing": "keep existing draft" };
  ctx.chatRoom = { clearDraft() { delete ui.chatDrafts["draft:conversation"]; } };
  assert.equal(await api.onAction("new-chat", {}), true);
  assert.deepEqual(navigations, ["/talk"]);
  assert.equal(ui.chatDrafts["draft:conversation"], undefined);
  assert.equal(ui.chatDrafts["chat:existing"], "keep existing draft");
  assert.equal(ui.focusConversationComposer, true);
  assert.deepEqual(state, before);
});
test("new conversation is blocked while an answer is being generated", async () => {
  const { api, ui, navigations, messages } = setup();
  ui.busy = true;
  await api.onAction("new-chat", {});
  assert.equal(navigations.length, 0);
  assert.equal(messages.length, 1);
});
test("the dashboard renders management metrics without a draft composer or conversation creation content", () => {
  const {state,ctx,api}=setup();
  state.dots[0].owner="me";
  const before=structuredClone(state);
  const html=createWorkspace({...ctx,n:String,footer:()=>"",btn:()=>"",experience:api}).page();
  assert.match(html,/creator-metrics/);
  assert.match(html,/>工作台<\/h1>/);
  assert.doesNotMatch(html,/id="compose"|new-conversation-page|talk-prompt|dashboard-recent/);
  assert.deepEqual(state,before);
});
test("sidebar puts conversation actions after product navigation and before history, without an all-chats menu", async () => {
  const {state,ctx,navigations}=setup({chats:[{id:"existing",title:"Existing discussion",dots:[],messages:[]}],
    chatListDemo:{chats:[{id:"sample",title:"Test discussion",dots:[],messages:[]}],trash:[]}},"/talk");
  const before=structuredClone(state);
  let search;
  const api=createConversations({...ctx,n:String,sidebarAccountFooter:()=>"ACCOUNT",
    btn:(label,action,kind,extra)=>`<button class="${kind}" data-action="${action}" ${extra}>${label}</button>`,iconBtn:()=>"",
    modal:(...args)=>search=args});
  const html=api.sidebar(),nav=html.match(/<nav class="nav chat-product-nav"[\s\S]*?<\/nav>/)[0];
  assert.ok(html.indexOf('chat-product-nav')<html.indexOf('class="chat-sidebar-tools"'));
  assert.ok(html.indexOf('class="chat-sidebar-tools"')<html.indexOf('class="chat-history-scroll"'));
  assert.doesNotMatch(nav,/全部对话|href="#\/chats/);
  assert.match(html,/chat-sidebar-tool active[^>]*data-action="new-chat"[^>]*aria-current="page"/);
  assert.match(html,/Existing discussion/);
  assert.match(html,/Test discussion/);
  assert.doesNotMatch(html,/chat-history-all|查看全部对话/);
  await api.onAction("cl-open-search",{});
  assert.equal(search,undefined);
  assert.equal(navigations.at(-1),"/chats");
  assert.deepEqual(state,before);
});
test("new conversation content contains only creation controls and leaves all existing chats intact", () => {
  const { api, ctx, state } = setup();
  state.chats = [
    { id: "older", title: "Older", dots: [], createdAt: "2026-10-01" },
    { id: "archived", title: "Archived", dots: [], updatedAt: "2026-11-01", archivedAt: "2026-11-01" },
    { id: "latest", title: "Latest", dots: ["mine"], updatedAt: "2026-10-31" },
    { id: "middle", title: "Middle", dots: [], updatedAt: "2026-10-30" },
    { id: "undated", title: "Undated", dots: [] },
  ];
  ctx.chatRoom = { draftChat: () => ({}), composer: () => '<form id="compose"></form>' };
  const before = structuredClone(state), html = api.newConversationPage();
  assert.match(html, /id="compose"/);
  assert.match(html, /data-action="talk-prompt"/);
  assert.doesNotMatch(html, /Latest|Middle|Older|Archived|Undated|继续对话|我的空间概览/);
  assert.deepEqual(state, before);
  state.chats = [];
  assert.match(api.newConversationPage(), /id="compose"/);
});
test("dedicated creation submits one conversation and schedules the existing answer flow", async () => {
  const { api, ctx, state, ui, navigations } = setup({},"/talk");
  let cleared = 0, transferred;
  ctx.chatRoom = {
    draftContext: "draft:conversation",
    draftChat: () => ({ dots: ["mine"] }),
    targets: () => [{ id: "mine" }],
    clearDraft() { cleared++; },
    transferDraftScope(id) { transferred = id; },
  };
  const sent = [];
  ctx.sendMessage = (key, text) => sent.push([key, text]);
  await api.onSubmit({ id: "compose", dataset: { context: "draft:conversation" } }, new Map([["question", "  Knowledge question  "]]));
  assert.equal(state.chats.length, 2);
  assert.equal(state.chats[0].title, "Knowledge question");
  assert.deepEqual(state.chats[0].dots, ["mine"]);
  assert.ok(Date.parse(state.chats[0].createdAt));
  assert.equal(transferred, "new-chat");
  assert.equal(cleared, 1);
  assert.equal(navigations[0], "/chats/new-chat");
  api.afterRender();
  api.afterRender();
  await Promise.resolve();
  assert.deepEqual(sent, [["chat:new-chat", "Knowledge question"]]);
  assert.equal(ui.talkSubmission, null);
});
test("empty, busy or untargeted new-conversation submissions create no conversations", async () => {
  for (const scenario of ["empty", "busy", "no-target"]) {
    const { api, ctx, state, ui, navigations } = setup();
    ui.busy = scenario === "busy";
    ctx.chatRoom = { draftContext: "draft:conversation", draftChat: () => ({ dots: [] }), targets: () => [] };
    await api.onSubmit({ id: "compose", dataset: { context: "draft:conversation" } }, new Map([["question", scenario === "empty" ? "  " : "Question"]]));
    assert.equal(state.chats.length, 1);
    assert.equal(navigations.length, 0);
  }
});
test("disabled accounts, public pages and admin pages retain their existing routing", () => {
  const disabled = setup({ disabled: true }).api;
  for (const path of ["/dashboard", "/talk", "/workspace"])
    assert.equal(disabled.resolve(path, new URLSearchParams()), null);
  const { api } = setup();
  for (const path of ["/admin/login", "/admin/overview", "/", "/d/design-partner", "/pricing"])
    assert.equal(api.resolve(path, new URLSearchParams()), null);
});
test("legacy billing links keep their sign-in gate and settings destination", () => {
  assert.deepEqual(setup().api.resolve("/billing", new URLSearchParams()), { redirect: "/settings?tab=billing" });
  assert.deepEqual(setup({ signed: false }).api.resolve("/billing", new URLSearchParams()), { redirect: "/login?next=%2Fbilling" });
});
