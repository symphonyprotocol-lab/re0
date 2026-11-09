import test from "node:test";
import assert from "node:assert/strict";
import {
  newDotDraft,
  validateDotDraft,
  prepareSetupSource,
  dotFromDraft,
  createDotSetup,
} from "../dot-setup.js";
import { createDotClassification } from "../dot-classification.js";

const complete = () => ({
  ...newDotDraft(),
  name: "研究助手",
  description: "整理我的研究资料",
  category: "learning",
  tags: ["科学研究", "自定义标签"],
  prompt: "分步骤作答，并注明来源",
  samples: "总结关键观点\n有哪些依据？",
  visibility: "public",
  fee: 25,
  color: "sage",
  reached: 4,
  step: 4,
});
test("setup validates identity, classification, questions and price before completion", () => {
  const draft = newDotDraft();
  assert.deepEqual(validateDotDraft(draft, 1), { step: 1, error: "name" });
  draft.name = "Ree";
  assert.equal(validateDotDraft(draft, 1), null);
  assert.deepEqual(validateDotDraft(draft, 2), { step: 2, error: "category" });
  assert.equal(validateDotDraft(complete(), 4), null);
  assert.equal(
    validateDotDraft({ ...complete(), samples: "1\n2\n3\n4" }, 4).error,
    "samples",
  );
  assert.equal(validateDotDraft({ ...complete(), fee: 10001 }, 4).error, "fee");
});
test("final Ree keeps all setup details without creating knowledge or old statistics", () => {
  const dot = dotFromDraft(complete(), "new-id-123");
  assert.equal(dot.name, "研究助手");
  assert.equal(dot.category, "learning");
  assert.deepEqual(dot.tags, ["科学研究", "自定义标签"]);
  assert.equal(dot.prompt, "分步骤作答，并注明来源");
  assert.deepEqual(dot.samples, ["总结关键观点", "有哪些依据？"]);
  assert.equal(dot.public, true);
  assert.equal(dot.fee, 25);
  assert.equal(dot.answers, 0);
  assert.deepEqual(dot.knowledge, []);
});
test("source preparation calculates cost and enforces repository/domain authorization", async () => {
  const text = await prepareSetupSource(
    { kind: "text", title: "笔记", text: "a".repeat(1001) },
    {},
  );
  assert.equal(text.cost, 2);
  assert.equal(text.source.kind, "text");
  assert.equal((await prepareSetupSource({ kind: "later" }, {})).cost, 0);
  await assert.rejects(
    prepareSetupSource(
      { kind: "github", url: "https://github.com/org/repo", private: true },
      {},
    ),
    /github-auth/,
  );
  await assert.rejects(
    prepareSetupSource(
      { kind: "site", url: "https://example.com" },
      { domains: [] },
    ),
    /domain/,
  );
  assert.equal(
    (
      await prepareSetupSource(
        { kind: "site", url: "https://example.com" },
        { domains: [{ domain: "example.com", status: "verified" }] },
      )
    ).cost,
    500,
  );
  await assert.rejects(
    prepareSetupSource({ kind: "page", url: "javascript:alert(1)" }, {}),
    /url/,
  );
});
test("source documents require a selected file after reload and readable text has the right cost", async () => {
  await assert.rejects(
    prepareSetupSource({ kind: "document", fileName: "notes.md" }, {}, null),
    /file/,
  );
  const result = await prepareSetupSource(
    { kind: "document" },
    {},
    { name: "notes.md", size: 2500, text: async () => "x".repeat(2500) },
  );
  assert.equal(result.cost, 3);
  await assert.rejects(
    prepareSetupSource(
      { kind: "document" },
      {},
      { name: "notes.exe", size: 10 },
    ),
    /file-format/,
  );
});
test("new setup classification preserves draft tags when no category has been chosen yet", () => {
  globalThis.document = { addEventListener() {} };
  const api = createDotClassification({
    t: (zh) => zh,
    I: () => "",
    esc: String,
  });
  const html = api.editor(
    { category: "", tags: ["自定义"] },
    { creating: true },
  );
  assert.match(html, /value="" selected disabled/);
  assert.match(html, /value="自定义"/);
});
test("bare studio routes default to Settings and steps never create a Ree", () => {
  globalThis.document = { addEventListener() {} };
  const state = { signed: true, dots: [{ id: "mine", owner: "me" }] };
  const ctx = {
    getState: () => state,
    getUi: () => ({}),
    t: (zh) => zh,
    dotById: (id) => state.dots.find((dot) => dot.id === id),
    I: () => "",
    esc: String,
  };
  const api = createDotSetup(ctx);
  assert.deepEqual(api.resolve("/dots/mine", new URLSearchParams()), {
    redirect: "/dots/mine/settings",
  });
  assert.equal(state.dots.length, 1);
  assert.equal(state.dotSetupDraft, undefined);
});
test("settings save changes metadata only and preserves knowledge, history, video and accumulated statistics", async () => {
  globalThis.document = { addEventListener() {} };
  const dot = {
    id: "mine",
    slug: "keep-slug",
    owner: "me",
    knowledge: [{ id: "source" }],
    answers: 173,
    video: { generated: true },
    prompt: "old",
    samples: [],
  };
  const state = { signed: true, dots: [dot], chats: [{ id: "keep" }] };
  let saved = 0;
  const api = createDotSetup({
    getState: () => state,
    getUi: () => ({}),
    t: (zh) => zh,
    dotById: () => dot,
    save: () => saved++,
    render() {},
    toast() {},
  });
  const fields = new Map(
    Object.entries({
      name: "新名字",
      description: "新简介",
      category: "technology",
      prompt: "新风格",
      samples: "一个问题",
      fee: "0",
      color: "lilac",
      visibility: "private",
      avatar: "",
    }),
  );
  fields.getAll = (key) => (key === "tags" ? ["React"] : []);
  await api.onSubmit(
    { id: "dot-settings-form", dataset: { id: "mine" } },
    fields,
  );
  assert.equal(saved, 1);
  assert.equal(dot.name, "新名字");
  assert.equal(dot.category, "technology");
  assert.equal(dot.slug, "keep-slug");
  assert.equal(dot.answers, 173);
  assert.equal(dot.knowledge[0].id, "source");
  assert.equal(dot.video.generated, true);
  assert.equal(state.chats[0].id, "keep");
});

test("finishing setup creates once, reserves only source cost and queues the source without disturbing existing Rees", async () => {
  globalThis.document = { addEventListener() {} };
  const NativeFormData = globalThis.FormData;
  globalThis.FormData = class {
    constructor(form) { this.fields = form.fields; }
    has(key) { return this.fields.has(key); }
    get(key) { return this.fields.get(key); }
    getAll() { return []; }
  };
  try {
    const state = { signed: true, dots: [{ id: "existing" }], dotSetupDraft: { ...complete(), source: { kind: "text", title: "研究笔记", text: "x".repeat(1001) } } };
    const ui = {}, charges = [], queues = [], destinations = [];
    let counter = 0;
    const api = createDotSetup({ getState: () => state, getUi: () => ui, t: zh => zh, uid: () => "new-" + ++counter, debit: amount => { charges.push(amount); ui.lastDeduction = { planCredits: amount }; return true; }, knowledge: { ingested: (dot, source) => { source.enabled = true; } }, creditEntry() {}, save() {}, go: path => destinations.push(path), toast() {}, scheduleProcessing: (...args) => queues.push(args) });
    const form = { id: "dot-setup-form", dataset: { step: "4" }, fields: new Map([["visibility", "public"], ["fee", "25"]]) };
    await Promise.all([api.onSubmit(form), api.onSubmit(form)]);
    assert.equal(state.dots.length, 2);
    assert.equal(state.dots[0].id, "existing");
    assert.deepEqual(charges, [2]);
    assert.equal(queues.length, 1);
    assert.equal(state.dots[1].knowledge[0].status, "processing");
    assert.deepEqual(state.dots[1].knowledge[0].hold, { planCredits: 2 });
    assert.equal(state.dotSetupDraft, undefined);
    assert.equal(destinations[0], "/dots/new-1/knowledge");
  } finally { globalThis.FormData = NativeFormData; }
});
