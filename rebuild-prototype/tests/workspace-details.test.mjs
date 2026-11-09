import test from "node:test";
import assert from "node:assert/strict";
import {
  ownedSourceRows,
  ownedAnswerRows,
  detailFilters,
  filterSources,
  filterAnswers,
  createWorkspaceDetails,
  ownedAnswerEvents,
} from "../workspace-details.js";
const state = () => ({
  signed: true,
  dots: [
    {
      id: "mine",
      owner: "me",
      name: "产品助手",
      answers: 130,
      knowledge: [
        { id: "one", title: "产品说明", kind: "document", status: "ready" },
        { id: "two", title: "更新记录", kind: "page", status: "failed" },
      ],
      knowledgeTrash: [{ id: "deleted", status: "ready" }],
    },
    {
      id: "private",
      owner: "me",
      name: "阅读库",
      answers: 43,
      knowledge: [
        {
          id: "three",
          title: "读书笔记",
          kind: "text",
          status: "ready",
          enabled: false,
        },
      ],
    },
    {
      id: "external",
      owner: "other",
      name: "Other",
      answers: 1000,
      knowledge: [
        { id: "secret", title: "Not mine", kind: "text", status: "ready" },
      ],
    },
  ],
  dotMessages: {
    "dot:mine": [
      { id: "q1", role: "user", text: "支持什么功能？" },
      {
        id: "a1",
        role: "dot",
        dot: "mine",
        text: "支持带引用的回答。",
        source: "one",
      },
      {
        id: "a2",
        role: "dot",
        dot: "mine",
        noAnswer: true,
        text: "没有相关知识",
      },
    ],
  },
  chats: [
    {
      id: "chat",
      messages: [
        { id: "q2", role: "user", text: "如何整理笔记？" },
        { id: "a3", role: "dot", dot: "private", text: "按主题整理。" },
        { id: "a4", role: "dot", dot: "external", text: "Unowned answer" },
        { id: "a1", role: "dot", dot: "mine", text: "支持带引用的回答。" },
      ],
    },
  ],
});
test("workspace period totals share dated usage with Ree statistics, including cleared tests", () => {
  const data = state();
  data.dotMessages["dot:mine"][1].createdAt = "2026-10-31T02:00:00Z";
  data.chats[0].messages[1].createdAt = "2026-09-01T02:00:00Z";
  data.entries = [
    {
      type: "query",
      dotId: "mine",
      answerId: "a1",
      amount: -20,
      createdAt: "2026-10-31T02:00:00Z",
    },
    {
      type: "query",
      dotId: "private",
      answerId: "cleared",
      amount: -20,
      createdAt: "2026-10-31T04:00:00Z",
    },
    {
      type: "query",
      dotId: "external",
      answerId: "not-mine",
      amount: -20,
      createdAt: "2026-10-31T04:00:00Z",
    },
  ];
  assert.equal(ownedAnswerEvents(data).length, 3);
  const api = createWorkspaceDetails({
    getState: () => data,
    t: (zh) => zh,
    I: () => "",
    esc: (value) => String(value ?? ""),
    n: String,
    title: (dot) => dot.name,
    shell: (html) => html,
    footer: () => "",
  });
  const summary = api.resolve(
    "/workspace/answers",
    new URLSearchParams("period=month&date=2026-10-31&view=summary"),
  );
  assert.match(summary.html, /时段成功回答<strong>2<\/strong>/);
  assert.match(summary.html, /已留存可查看记录<strong>1<\/strong>/);
  assert.match(summary.html, /type="hidden" name="selection"/);
  assert.doesNotMatch(
    summary.html,
    /statistics-period-range|statistics-period-arrow/,
  );
  assert.match(summary.html, /period=month&date=2026-10-31/);
  const records = api.resolve(
    "/workspace/answers",
    new URLSearchParams("period=month&date=2026-10-31&view=records"),
  );
  assert.match(records.html, /支持带引用的回答/);
  assert.doesNotMatch(records.html, /按主题整理|Unowned answer/);
  const week = api.resolve(
    "/workspace/answers",
    new URLSearchParams("period=week&date=2026-10-31&view=summary&dot=mine"),
  );
  assert.match(week.html, /时段成功回答<strong>1<\/strong>/);
  assert.match(week.html, /type="hidden" name="selection"/);
  const sources = api.resolve(
    "/workspace/sources",
    new URLSearchParams("period=month&date=2026-10-31"),
  );
  assert.doesNotMatch(sources.html, /statistics-period-tabs/);
  assert.match(sources.html, /产品说明/);
});

test("workspace week picker preserves Ree, search and view, normalizes dates and resets pagination", async () => {
  let target;
  const api = createWorkspaceDetails({
    getState: () => state(),
    go: (path) => {
      target = path;
    },
  });
  await api.onSubmit(
    { id: "workspace-answer-period", dataset: { list: "answers" } },
    new Map([
      ["period", "week"],
      ["selection", "2026-W53"],
      ["dot", "mine"],
      ["view", "records"],
      ["q", "支持"],
      ["size", "50"],
      ["page", "4"],
    ]),
  );
  const url = new URL(target, "http://localhost");
  assert.equal(url.pathname, "/workspace/answers");
  assert.equal(url.searchParams.get("date"), "2026-12-28");
  assert.equal(url.searchParams.get("period"), "week");
  assert.equal(url.searchParams.get("dot"), "mine");
  assert.equal(url.searchParams.get("q"), "支持");
  assert.equal(url.searchParams.get("view"), "records");
  assert.equal(url.searchParams.get("size"), "50");
  assert.equal(url.searchParams.has("page"), false);
});
test("workspace custom ranges filter both summary and records and survive view changes", async () => {
  const data = state();
  data.dotMessages["dot:mine"][1].createdAt = "2026-10-31T15:59:59Z";
  data.chats[0].messages[1].createdAt = "2026-10-31T16:00:00Z";
  let target, warning;
  const api = createWorkspaceDetails({
    getState: () => data,
    t: (zh) => zh,
    I: () => "",
    esc: String,
    n: String,
    title: (dot) => dot.name,
    shell: (html) => html,
    footer: () => "",
    go: (url) => (target = url),
    toast: (text) => (warning = text),
  });
  const query = "period=custom&start=2026-10-31&end=2026-10-31";
  const summary = api.resolve("/workspace/answers", new URLSearchParams(query));
  assert.match(summary.html, /时段成功回答<strong>1<\/strong>/);
  assert.match(summary.html, /已留存可查看记录<strong>1<\/strong>/);
  const records = api.resolve(
    "/workspace/answers",
    new URLSearchParams(query + "&view=records"),
  );
  assert.match(records.html, /支持带引用的回答/);
  assert.doesNotMatch(records.html, /按主题整理/);
  await api.onSubmit(
    { id: "workspace-answer-period", dataset: { list: "answers" } },
    new Map([
      ["period", "custom"],
      ["start", "2026-10-01"],
      ["end", "2026-10-31"],
      ["dot", "mine"],
      ["view", "records"],
      ["q", "支持"],
      ["size", "50"],
    ]),
  );
  const url = new URL(target, "http://localhost");
  for (const [key, value] of Object.entries({
    period: "custom",
    start: "2026-10-01",
    end: "2026-10-31",
    dot: "mine",
    view: "records",
    q: "支持",
    size: "50",
  }))
    assert.equal(url.searchParams.get(key), value);
  const previous = target;
  await api.onSubmit(
    { id: "workspace-answer-period", dataset: { list: "answers" } },
    new Map([
      ["period", "custom"],
      ["start", "2026-10-31"],
      ["end", "2026-10-01"],
    ]),
  );
  assert.equal(target, previous);
  assert.match(warning, /结束日期不能早于开始日期/);
});
test("answer summary rendering keeps its counts aligned with the selected Ree search", () => {
  const api = createWorkspaceDetails({
    getState: () => state(),
    t: (zh) => zh,
    I: () => "",
    esc: (value) => String(value ?? ""),
    n: (value) => String(value),
    title: (dot) => dot.name,
    shell: (html) => html,
    footer: () => "",
  });
  const all = api.resolve(
    "/workspace/answers",
    new URLSearchParams("view=summary&status=answered"),
  );
  assert.match(all.html, /累计成功回答<strong>173<\/strong>/);
  assert.match(all.html, /已留存可查看记录<strong>2<\/strong>/);
  const filtered = api.resolve(
    "/workspace/answers",
    new URLSearchParams("view=summary&q=支持什么功能"),
  );
  assert.match(filtered.html, /累计成功回答<strong>0<\/strong>/);
  assert.match(filtered.html, /已留存可查看记录<strong>0<\/strong>/);
});
test("cross-Dot source details share the owned-source scope and exclude trash", () => {
  const rows = ownedSourceRows(state());
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.source.id),
    ["one", "two", "three"],
  );
  const f = detailFilters(
    new URLSearchParams("scope=other&dot=mine&status=failed&kind=page"),
    state(),
  );
  assert.equal(f.scope, "mine");
  assert.deepEqual(
    filterSources(rows, f).map((r) => r.source.id),
    ["two"],
  );
});
test("source queries apply Ree, state, type and search together", () => {
  const f = detailFilters(
    new URLSearchParams("dot=private&status=paused&kind=text&q=笔记"),
    state(),
  );
  assert.deepEqual(
    filterSources(ownedSourceRows(state()), f).map((r) => r.source.id),
    ["three"],
  );
  assert.equal(
    filterSources(ownedSourceRows(state()), { ...f, status: "ready" }).length,
    0,
  );
});
test("answer details contain saved successful owned answers without duplicating messages or fabricating baseline history", () => {
  const s = state(),
    rows = ownedAnswerRows(s);
  assert.equal(rows.length, 2);
  assert.equal(s.dots[0].answers, 130);
  assert.deepEqual(
    new Set(rows.map((r) => r.message.id)),
    new Set(["a1", "a3"]),
  );
  const f = detailFilters(
    new URLSearchParams("dot=private&view=records&q=整理"),
    s,
    true,
  );
  assert.equal(filterAnswers(rows, f).length, 1);
  assert.equal(filterAnswers(rows, f)[0].question, "如何整理笔记？");
});
test("invalid filters remain within owned data and pagination values are bounded", () => {
  const f = detailFilters(
    new URLSearchParams(
      "dot=external&status=invalid&kind=invalid&page=-2&size=999",
    ),
    state(),
  );
  assert.equal(f.dot, "all");
  assert.equal(f.status, "all");
  assert.equal(f.kind, "all");
  assert.equal(f.page, 1);
  assert.equal(f.size, 20);
  assert.equal(
    filterSources(ownedSourceRows(state()), f).some(
      (r) => r.dot.owner !== "me",
    ),
    false,
  );
});
test("filter submission creates a refreshable URL and resets pagination", async () => {
  let target = "";
  const api = createWorkspaceDetails({
    getState: () => state(),
    go: (path) => (target = path),
  });
  await api.onSubmit(
    { id: "workspace-detail-filter", dataset: { list: "sources" } },
    new Map([
      ["dot", "private"],
      ["status", "paused"],
      ["kind", "text"],
      ["q", "读书"],
      ["size", "50"],
      ["page", "4"],
    ]),
  );
  const url = new URL(target, "http://localhost");
  assert.equal(url.pathname, "/workspace/sources");
  assert.equal(url.searchParams.get("scope"), "mine");
  assert.equal(url.searchParams.get("dot"), "private");
  assert.equal(url.searchParams.get("q"), "读书");
  assert.equal(url.searchParams.get("size"), "50");
  assert.equal(url.searchParams.has("page"), false);
});
