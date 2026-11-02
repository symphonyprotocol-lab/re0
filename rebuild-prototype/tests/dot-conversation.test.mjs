import test from "node:test";
import assert from "node:assert/strict";
import {
  conversationReadiness,
  createDotConversation,
} from "../dot-conversation.js";
function setup(overrides = {}) {
  globalThis.document = {
    addEventListener() {},
    querySelector() {
      return null;
    },
  };
  return createDotConversation({
    t: (zh) => zh,
    I: () => "",
    esc: (value) => String(value ?? ""),
    title: (dot) => dot.name,
    avatar: () => '<span class="test-avatar"></span>',
    fee: () => 20,
    getUi: () => ({}),
    messageHTML: (message) => `<p>${message.text}</p>`,
    ...overrides,
  });
}
const dot = {
  id: "mine",
  name: "我的知识",
  knowledge: [],
  samples: ["我该了解什么？"],
};
test("conversation readiness excludes disabled sources and distinguishes pending knowledge", () => {
  assert.deepEqual(
    conversationReadiness({
      knowledge: [
        { status: "ready" },
        { status: "ready", enabled: false },
        { status: "pending" },
        { status: "processing", enabled: false },
        { status: "failed" },
      ],
    }),
    { ready: 1, processing: 1 },
  );
});

test("clearing waits for confirmation and only removes the current Ree's test history", async () => {
  const state = {
    signed: true,
    dots: [{ ...dot, owner: "me", answers: 7 }],
    dotMessages: {
      "dot:mine": [{ text: "旧测试" }],
      "dot:other": [{ text: "另一个 Ree" }],
      "public:mine": [{ text: "公开页对话" }],
    },
    chats: [{ messages: [{ text: "多 Ree 对话" }] }],
    entries: [{ amount: -20 }],
    planCredits: 100,
  };
  const before = structuredClone(state);
  let confirmation,
    saves = 0,
    renders = 0;
  const api = setup({
    getState: () => state,
    dotById: (id) => state.dots.find((dot) => dot.id === id),
    route: () => ({ path: "/dots/mine/chat" }),
    confirmModal: (...args) => {
      confirmation = args;
    },
    save: () => saves++,
    render: () => renders++,
    toast() {},
  });
  await api.onAction("studio-clear", { id: "mine" });
  assert.deepEqual(
    state,
    before,
    "opening or cancelling confirmation does not change messages",
  );
  assert.equal(saves, 0);
  assert.equal(confirmation[4], true);
  confirmation[3]();
  const expected = structuredClone(before);
  expected.dotMessages["dot:mine"] = [];
  assert.deepEqual(
    state,
    expected,
    "other histories, sources, counters and credits remain unchanged",
  );
  assert.equal(saves, 1);
  assert.equal(renders, 1);
  await api.onAction("studio-clear", { id: "mine" });
  assert.equal(saves, 1, "clearing an empty conversation is a no-op");
});

test("clear is disabled for empty or generating chats and rechecks generation before confirmation", async () => {
  const ui = { busy: false };
  const state = {
    signed: true,
    dotMessages: { "dot:mine": [{ text: "keep" }] },
  };
  let confirm,
    confirmations = 0;
  const api = setup({
    getUi: () => ui,
    getState: () => state,
    dotById: () => ({ ...dot, owner: "me" }),
    route: () => ({ path: "/dots/mine/chat" }),
    confirmModal: (...args) => {
      confirm = args[3];
      confirmations++;
    },
  });
  assert.match(api.page(dot, []), /data-action="studio-clear"[^>]*disabled/);
  assert.doesNotMatch(
    api.page(dot, state.dotMessages["dot:mine"]),
    /data-action="studio-clear"[^>]*disabled/,
  );
  await api.onAction("studio-clear", { id: "mine" });
  ui.busy = true;
  confirm();
  assert.equal(state.dotMessages["dot:mine"].length, 1);
  assert.match(
    api.page(dot, state.dotMessages["dot:mine"]),
    /data-action="studio-clear"[^>]*disabled/,
  );
  await api.onAction("studio-clear", { id: "mine" });
  assert.equal(confirmations, 1);
});
test("empty conversation explains readiness without an old source sidebar or add-knowledge control", () => {
  const api = setup();
  const html = api.page(dot, []);
  assert.match(html, /这个 Ree，还在等待知识/);
  assert.match(html, /知识未就绪/);
  assert.doesNotMatch(html, /knowledge-panel|data-action="add-knowledge"/);
  assert.match(html, /data-context="dot:mine"/);
  const ready = api.page({ ...dot, knowledge: [{ status: "ready" }] }, []);
  assert.match(ready, /可以开始对话/);
  assert.match(ready, /data-action="studio-prompt"/);
});
test("no-answer replies give a clear reason and say that no credits were charged", () => {
  const api = setup();
  const noSources = api.unanswered(
    { id: "one", noAnswer: true, reason: "no-sources" },
    dot,
  );
  assert.match(noSources, /目前还没有可用的知识依据/);
  assert.match(noSources, /未作答 · 本次未收费/);
  const outside = api.unanswered(
    { id: "two", noAnswer: true, reason: "out-of-scope" },
    { ...dot, knowledge: [{ status: "ready" }] },
  );
  assert.match(outside, /超出了我的知识范围/);
});
test("new conversation rendering keeps the existing messages and uses the existing send form contract", () => {
  const api = setup();
  const html = api.page(dot, [
    { role: "user", text: "既有问题" },
    { role: "dot", text: "既有回答" },
  ]);
  assert.match(html, /既有问题/);
  assert.match(html, /既有回答/);
  assert.match(html, /id="compose"/);
  assert.match(html, /id="message-input"/);
  assert.match(html, /id="cost-label"/);
  assert.match(html, /未作答不收费/);
});
