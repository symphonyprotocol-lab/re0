import test from "node:test";
import assert from "node:assert/strict";
import { createChatRoom } from "../chat-room.js";
globalThis.document = { addEventListener() {} };
function setup() {
  const dots = Array.from({ length: 7 }, (_, i) => ({
    id: "dot-" + i,
    name: "伙伴" + i,
    enName: "Companion" + i,
    public: i !== 6,
    owner: i === 0 ? "me" : "other",
    fee: i * 10,
  }));
  const chat = {
    id: "chat",
    dots: ["dot-0", "dot-1"],
    messages: [
      { role: "dot", dot: "dot-1", text: "历史回答", source: "citation" },
    ],
  };
  const ui = {};
  const ctx = {
    getUi: () => ui,
    t: (zh) => zh,
    title: (b) => b.name,
    dotById: (id) => dots.find((b) => b.id === id),
    mine: () => dots.filter((b) => b.owner === "me"),
    publicDots: () => dots.filter((b) => b.public && b.owner !== "me"),
    save() {},
  };
  return { api: createChatRoom(ctx), chat, ui, dots };
}
test("default scope answers with all current participants", () => {
  const { api, chat } = setup();
  assert.deepEqual(
    api.targets(chat, "问题").map((b) => b.id),
    chat.dots,
  );
});
test("single-Dot scope changes answerers without removing members", () => {
  const { api, chat, ui } = setup();
  ui.roomScopes = { chat: "dot-1" };
  assert.deepEqual(
    api.targets(chat).map((b) => b.id),
    ["dot-1"],
  );
  assert.equal(chat.dots.length, 2);
});
test("explicit mentions take precedence and unknown mentions do not fan out", () => {
  const { api, chat, ui } = setup();
  ui.roomScopes = { chat: "dot-1" };
  assert.deepEqual(
    api.targets(chat, "@伙伴0 你好").map((b) => b.id),
    ["dot-0"],
  );
  assert.deepEqual(
    api.targets(chat, "@Companion0 @伙伴1").map((b) => b.id),
    ["dot-0", "dot-1"],
  );
  assert.deepEqual(
    api.targets(chat, "@陌生人").map((b) => b.id),
    [],
  );
});
test("changing participants preserves messages and citation references", () => {
  const { api, chat, ui } = setup();
  const history = JSON.stringify(chat.messages);
  ui.roomScopes = { chat: "dot-1" };
  assert.equal(api.applyParticipants(chat, ["dot-0", "dot-2"]), true);
  assert.equal(JSON.stringify(chat.messages), history);
  assert.equal(ui.roomScopes.chat, null);
  assert.deepEqual(
    api.targets(chat).map((b) => b.id),
    ["dot-0", "dot-2"],
  );
});
test("cannot add over five Rees or mutate membership during a response", () => {
  const { api, chat, ui } = setup();
  assert.equal(
    api.applyParticipants(
      chat,
      Array.from({ length: 6 }, (_, i) => "dot-" + i),
    ),
    false,
  );
  assert.deepEqual(chat.dots, ["dot-0", "dot-1"]);
  ui.busy = true;
  assert.equal(api.applyParticipants(chat, ["dot-2"]), false);
  assert.deepEqual(chat.dots, ["dot-0", "dot-1"]);
});
test("only owned or public Rees can be added; duplicate membership is deduplicated", () => {
  const { api, chat } = setup();
  api.applyParticipants(chat, ["dot-0", "dot-0", "dot-6", "unknown"]);
  assert.deepEqual(chat.dots, ["dot-0"]);
});
test("removing all participants leaves history intact and no answerer", () => {
  const { api, chat } = setup();
  api.applyParticipants(chat, []);
  assert.equal(chat.messages.length, 1);
  assert.deepEqual(api.targets(chat), []);
});
test("unsent participants are managed separately from existing conversations", () => {
  const { api, chat, ui } = setup();
  const before = JSON.stringify(chat);
  ui.talkDots = ["dot-0"];
  const draft = api.draftChat();
  assert.equal(api.applyParticipants(draft, ["dot-1", "dot-2"]), true);
  assert.deepEqual(ui.talkDots, ["dot-1", "dot-2"]);
  assert.deepEqual(api.draftChat().dots, ["dot-1", "dot-2"]);
  assert.equal(JSON.stringify(chat), before);
});
test("the draft answerer scope transfers to the created chat without removing other participants", () => {
  const { api, ui } = setup();
  ui.talkDots = ["dot-0", "dot-1"];
  const draft = api.draftChat();
  ui.roomScopes = { [draft.id]: "dot-1" };
  api.transferDraftScope("created");
  const created = { id: "created", dots: [...draft.dots] };
  assert.deepEqual(
    api.targets(created).map((b) => b.id),
    ["dot-1"],
  );
  assert.deepEqual(created.dots, ["dot-0", "dot-1"]);
});
test("empty draft membership stays empty instead of silently selecting a default Ree", () => {
  const { api, ui } = setup();
  ui.talkDots = [];
  assert.deepEqual(api.draftChat().dots, []);
  assert.deepEqual(api.targets(api.draftChat()), []);
});
