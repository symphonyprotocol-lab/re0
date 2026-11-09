import test from "node:test";
import assert from "node:assert/strict";
import {
  dotStatistics,
  statisticsFilters,
  createDotStatistics,
} from "../dot-statistics.js";

const state = {
  signed: true,
  lang: "zh",
  dots: [
    {
      id: "mine",
      owner: "me",
      name: "产品助手",
      answers: 130,
      knowledge: [{ id: "s", title: "产品说明", status: "ready" }],
    },
    { id: "second", owner: "me", name: "阅读库", answers: 43, knowledge: [] },
    {
      id: "external",
      owner: "other",
      name: "其他人的 Ree",
      answers: 1000,
      knowledge: [],
    },
  ],
  dotMessages: {
    "dot:mine": [
      { role: "user", text: "如何使用？" },
      { role: "dot", id: "a", dot: "mine", text: "产品回答正文", source: "s" },
      { role: "dot", id: "b", dot: "mine", text: "未找到答案", noAnswer: true },
      { role: "dot", id: "c", dot: "second", text: "其他 Ree 回答" },
    ],
  },
  earnedCredits: 528000,
  entries: [
    { type: "income", title: "产品助手 · 查询收入", amount: 999 },
    {
      type: "income",
      dotId: "mine",
      title: "当前 Ree 查询收入",
      amount: 30,
      time: "刚刚",
    },
    { type: "income", dotId: "second", title: "其他 Ree 收入", amount: 60 },
    { type: "query", dotId: "mine", title: "自己提问", amount: -20 },
  ],
};
function setup(source = state) {
  let destination;
  const api = createDotStatistics({
    getState: () => source,
    t: (zh) => zh,
    I: () => "",
    esc: (value) => String(value ?? ""),
    n: String,
    title: (dot) => dot.name,
    shell: (html) => html,
    footer: () => "",
    go: (path) => {
      destination = path;
    },
  });
  return { api, target: () => destination };
}
test("Ree totals exclude other Rees, failed answers and unattributed account income", () => {
  const data = dotStatistics(state, "mine");
  assert.equal(data.answers, 130);
  assert.equal(data.records.length, 1);
  assert.equal(data.sources.ready, 1);
  assert.equal(data.earned, 30);
  assert.equal(data.income.length, 1);
  assert.equal(dotStatistics(state, "external"), null);
  assert.equal(dotStatistics(state, "missing"), null);
});
test("statistics render actual saved text and citations, with separate income view", () => {
  const { api } = setup();
  const result = api.resolve("/dots/mine/statistics", new URLSearchParams());
  assert.match(result.html, /产品回答正文/);
  assert.match(result.html, /产品说明/);
  assert.doesNotMatch(result.html, /其他 Ree 回答|未找到答案/);
  const income = api.resolve(
    "/dots/mine/statistics",
    new URLSearchParams("view=income"),
  );
  assert.match(income.html, /当前 Ree 查询收入/);
  assert.doesNotMatch(income.html, /其他 Ree 收入|产品助手 · 查询收入/);
  assert.deepEqual(
    api.resolve("/dots/external/statistics", new URLSearchParams()),
    { redirect: "/dots" },
  );
});
test("search filters saved answers without altering cumulative counts", () => {
  const { api } = setup();
  const result = api.resolve(
    "/dots/mine/statistics",
    new URLSearchParams("q=不存在"),
  );
  assert.match(result.html, /没有符合筛选条件的记录/);
  assert.match(result.html, /130/);
  assert.doesNotMatch(result.html, /产品回答正文/);
});
test("Ree statistics filter URLs retain scope, normalize invalid values and reset page", async () => {
  assert.deepEqual(
    statisticsFilters(
      new URLSearchParams(
        "view=unknown&size=999&page=-2&period=bad&date=2026-02-30",
      ),
      new Date("2026-10-31T00:00:00Z"),
    ),
    {
      view: "answers",
      q: "",
      size: 20,
      page: 1,
      period: "all",
      date: "2026-10-31",
    },
  );
  const { api, target } = setup();
  await api.onSubmit(
    { id: "dot-statistics-filter", dataset: { dot: "mine" } },
    new Map([
      ["view", "income"],
      ["q", "查询"],
      ["size", "50"],
      ["page", "3"],
      ["period", "week"],
      ["date", "2026-10-31"],
    ]),
  );
  const url = new URL(target(), "http://localhost");
  assert.equal(url.pathname, "/dots/mine/statistics");
  assert.equal(url.searchParams.get("view"), "income");
  assert.equal(url.searchParams.get("q"), "查询");
  assert.equal(url.searchParams.get("size"), "50");
  assert.equal(url.searchParams.has("page"), false);
  assert.equal(url.searchParams.get("period"), "week");
  assert.equal(url.searchParams.get("date"), "2026-10-31");
});

test("dated usage survives clearing test messages and deduplicates retained answers", () => {
  const data = structuredClone(state);
  data.dotMessages["dot:mine"][1].createdAt = "2026-10-31T02:00:00Z";
  data.entries.push({
    type: "query",
    dotId: "mine",
    answerId: "a",
    amount: -20,
    createdAt: "2026-10-31T02:00:00Z",
  });
  assert.equal(dotStatistics(data, "mine").events.length, 1);
  data.dotMessages["dot:mine"] = [];
  const after = dotStatistics(data, "mine");
  assert.equal(after.events.length, 1);
  assert.equal(after.records.length, 0);
  assert.equal(after.answers, 130);
});
test("custom Ree range filters saved answers and income and persists across filter links", async () => {
  const data = structuredClone(state);
  data.dotMessages["dot:mine"][1].createdAt = "2026-10-31T15:59:59Z";
  data.dotMessages["dot:mine"].push({
    role: "dot",
    id: "outside",
    dot: "mine",
    text: "范围以外的回答",
    createdAt: "2026-10-31T16:00:00Z",
  });
  data.entries.push({
    type: "income",
    dotId: "mine",
    amount: 12,
    title: "范围内收入",
    createdAt: "2026-10-31T15:59:59Z",
  });
  const { api, target } = setup(data);
  const query = "period=custom&start=2026-10-31&end=2026-10-31";
  const page = api.resolve("/dots/mine/statistics", new URLSearchParams(query));
  assert.match(page.html, /产品回答正文/);
  assert.doesNotMatch(page.html, /范围以外的回答/);
  assert.match(page.html, /name="start" value="2026-10-31"/);
  assert.match(page.html, /name="end" value="2026-10-31"/);
  const income = api.resolve(
    "/dots/mine/statistics",
    new URLSearchParams(query + "&view=income"),
  );
  assert.match(income.html, /范围内收入/);
  assert.doesNotMatch(income.html, /当前 Ree 查询收入/);
  await api.onSubmit(
    { id: "dot-statistics-filter", dataset: { dot: "mine" } },
    new Map([
      ["period", "custom"],
      ["start", "2026-10-01"],
      ["end", "2026-10-31"],
      ["view", "income"],
      ["size", "50"],
      ["q", "收入"],
      ["page", "3"],
    ]),
  );
  const url = new URL(target(), "http://localhost");
  assert.equal(url.searchParams.get("start"), "2026-10-01");
  assert.equal(url.searchParams.get("end"), "2026-10-31");
  assert.equal(url.searchParams.get("view"), "income");
  assert.equal(url.searchParams.get("q"), "收入");
  assert.equal(url.searchParams.get("size"), "50");
  assert.equal(url.searchParams.has("page"), false);
});

test("day selection filters records and income, while time controls and metric links retain scope", async () => {
  const data = structuredClone(state);
  data.dotMessages["dot:mine"][1].createdAt = "2026-10-31T02:00:00Z";
  data.entries.push({
    type: "income",
    dotId: "mine",
    title: "有日期的收入",
    amount: 12,
    createdAt: "2026-10-31T03:00:00Z",
  });
  const { api, target } = setup(data);
  const result = api.resolve(
    "/dots/mine/statistics",
    new URLSearchParams("period=day&date=2026-10-31"),
  );
  assert.match(result.html, /时段成功回答/);
  assert.match(result.html, /产品回答正文/);
  assert.match(result.html, /使用趋势/);
  assert.match(result.html, /按小时汇总/);
  assert.match(result.html, /没有准确时间，仅计入全部时间/);
  assert.match(
    result.html,
    /period=day&amp;date=2026-10-31|period=day&date=2026-10-31/,
  );
  const other = api.resolve(
    "/dots/mine/statistics",
    new URLSearchParams("period=day&date=2026-10-30"),
  );
  assert.doesNotMatch(other.html, /产品回答正文/);
  const income = api.resolve(
    "/dots/mine/statistics",
    new URLSearchParams("view=income&period=day&date=2026-10-31"),
  );
  assert.match(income.html, /有日期的收入/);
  assert.doesNotMatch(income.html, /当前 Ree 查询收入/);
  await api.onSubmit(
    { id: "dot-statistics-period", dataset: { dot: "mine" } },
    new Map([
      ["view", "income"],
      ["period", "month"],
      ["date", "2026-09-15"],
      ["q", "收入"],
      ["size", "50"],
    ]),
  );
  const url = new URL(target(), "http://localhost");
  assert.equal(url.searchParams.get("period"), "month");
  assert.equal(url.searchParams.get("date"), "2026-09-15");
  assert.equal(url.searchParams.get("view"), "income");
  assert.equal(url.searchParams.get("q"), "收入");
  assert.equal(url.searchParams.get("size"), "50");
  await api.onSubmit(
    { id: "dot-statistics-period", dataset: { dot: "mine" } },
    new Map([
      ["view", "income"],
      ["period", "month"],
      ["selection", "2026-09"],
      ["size", "50"],
    ]),
  );
  assert.equal(
    new URL(target(), "http://localhost").searchParams.get("date"),
    "2026-09-01",
  );
  assert.match(other.html, /type="hidden" name="selection"/);
  assert.doesNotMatch(
    other.html,
    /statistics-period-range|statistics-period-arrow/,
  );
});
