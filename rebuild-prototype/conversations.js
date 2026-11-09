import { ownedReeTestCatalog } from "./owned-rees.js";

export function conversationSearchReturnPath(value = "") {
  if (typeof value !== "string" || (value !== "/chats" && !value.startsWith("/chats?"))) return "/chats";
  const query = new URLSearchParams(value.slice(7).split("#")[0]), next = new URLSearchParams();
  if (query.get("sample") === "scale") next.set("sample", "scale");
  if (query.get("q")) next.set("q", query.get("q").slice(0, 4000));
  if (["recent", "pinned", "archived", "trash"].includes(query.get("view"))) next.set("view", query.get("view"));
  if (query.get("dot") && query.get("dot") !== "all") next.set("dot", query.get("dot").slice(0, 200));
  if (["7", "30", "90"].includes(query.get("days"))) next.set("days", query.get("days"));
  if (["old", "title"].includes(query.get("sort"))) next.set("sort", query.get("sort"));
  const page = Number(query.get("page"));
  if (Number.isFinite(page) && page > 1) next.set("page", Math.min(100000, Math.floor(page)));
  if (["50", "100"].includes(query.get("size"))) next.set("size", query.get("size"));
  return "/chats" + (next.size ? "?" + next : "");
}

export const CONVERSATION_TEST_COUNT = 320;
export function conversationTestData(allDots = [], { t = zh => zh, now = Date.now(), reservedIds = [] } = {}) {
  const dots = allDots.filter(dot => !dot.disabled).slice(0, 6);
  const reserved = new Set(reservedIds);
  const topics = [
    ["设计系统的协作与交付", "Design system handoff"],
    ["用户访谈与研究总结", "User research synthesis"],
    ["新产品的定位与验证", "Product positioning"],
    ["知识库的来源与引用", "Sources and citations"],
    ["组件设计与实现规范", "Component design"],
    ["定价方案与成本规划", "Pricing and costs"],
    ["季度复盘与下一步计划", "Quarterly review"],
    ["内容策略与表达方式", "Content strategy"],
  ];
  return {
    chats: Array.from({ length: CONVERSATION_TEST_COUNT }, (_, i) => {
      const ds = Array.from({ length: Math.min(dots.length, 1 + i % 3) }, (_, j) => dots[(i + j) % dots.length].id);
      const subject = t(...topics[i % topics.length]);
      const at = new Date(now - i * 11 * 3600000).toISOString();
      let id = "sample-chat-" + String(i + 1).padStart(3, "0");
      while (reserved.has(id)) id += "-test";
      reserved.add(id);
      const messages = [];
      for (let j = 0; j < 1 + i % 4; j++) {
        messages.push({
          id: id + "-question-" + j, role: "user",
          text: t("关于「" + subject + "」，第 " + (j + 1) + " 个问题：我们应该如何梳理目标、约束与下一步？",
            "For " + subject + ", question " + (j + 1) + ": how should we define goals, constraints, and next steps?"),
        });
        if (ds.length) messages.push({
          id: id + "-answer-" + j, role: "dot", dot: ds[j % ds.length], cost: 0,
          text: t("这是一段规模演示消息。先梳理当前目标和已知事实，再收集可验证的来源，记录方案、负责人和后续行动。讨论关键词：" + subject + "。",
            "Scale-demo message. Define goals and facts, collect verifiable sources, and record decisions, owners, and next steps. Topic: " + subject + "."),
        });
      }
      return { id, title: subject + " · " + String(i + 1).padStart(3, "0"), dots: ds, messages,
        createdAt: at, updatedAt: at, pinned: i < 9, archivedAt: i % 9 === 8 ? at : undefined, listDemo: true };
    }),
    trash: [],
  };
}

// Paginated conversation management; real and scale-demo records are isolated.
export function createConversations(ctx) {
  const {
    t,
    I,
    esc,
    n,
    avatar,
    title,
    dotById,
    route,
    go,
    save,
    render,
    modal,
    closeModal,
    confirmModal,
    btn,
    iconBtn,
    cancelButton,
    submitButton,
    toast,
    wordmark,
    sidebarAccountFooter,
  } = ctx;
  const S = () => ctx.getState(),
    U = () => ctx.getUi();
  const views = new Map();
  const stamp = () => new Date().toISOString();
  const demo = () => route().path === "/chats"
    ? route().query.get("sample") === "scale"
    : route().path.startsWith("/chats/") && new URLSearchParams((route().query.get("from") || "").split("?")[1]).get("sample") === "scale";
  let samples;
  function realStore() {
    return {
      get chats() { return S().chats; },
      set chats(value) { S().chats = value; },
      get trash() { return S().chatTrash || []; },
      set trash(value) { S().chatTrash = value; },
    };
  }
  function sampleStore() {
    if (!samples || samples !== S().chatListDemo) {
      const existing = S().chatListDemo;
      if (existing?.chats?.length || existing?.trash?.length) samples = existing;
      else {
        const real = realStore();
        samples = conversationTestData(S().dots, { t, reservedIds: [...real.chats, ...real.trash].map(c => c.id) });
        S().chatListDemo = samples;
        save?.();
      }
    }
    return samples;
  }
  function store(sample = demo()) {
    const tests = sampleStore();
    if (sample) return tests;
    const real = realStore();
    const realIds = new Set([...real.chats, ...real.trash].map(c => c.id));
    const testIds = new Set([...tests.chats, ...tests.trash].map(c => c.id));
    const testRecord = c => testIds.has(c.id) && !realIds.has(c.id);
    const merge = key => {
      const seen = new Set(real[key].map(c => c.id));
      return [...real[key], ...tests[key].filter(c => {
        if (realIds.has(c.id) || seen.has(c.id)) return false;
        seen.add(c.id); return true;
      })];
    };
    const write = (key, value) => {
      const hidden = tests[key].filter(c => realIds.has(c.id));
      real[key] = value.filter(c => !testRecord(c));
      tests[key] = [...hidden, ...value.filter(testRecord)];
    };
    return {
      get chats() { return merge("chats"); }, set chats(value) { write("chats", value); },
      get trash() { return merge("trash"); }, set trash(value) { write("trash", value); },
    };
  }
  function findChat(id) {
    if (!id) return undefined;
    const real = realStore(), current = real.chats.find(c => c.id === id);
    if (current || real.trash.some(c => c.id === id)) return current;
    return sampleStore().chats.find(c => c.id === id);
  }
  const isTestChat = c => !!lookup(c.id)?.sample;
  function view(sample = demo()) {
    const key = route().query.toString();
    if (!views.has(sample) || (route().path === "/chats" && views.get(sample).queryKey !== key)) {
      const q = route().query;
      views.set(sample, {
        queryKey: key,
        q: (q.get("q") || "").slice(0, 4000),
        tab: ["recent", "pinned", "archived", "trash", "all"].includes(
          q.get("view"),
        )
          ? q.get("view")
          : "all",
        dot: q.get("dot") || "all",
        period: ["7", "30", "90"].includes(q.get("days"))
          ? q.get("days")
          : "all",
        sort: ["old", "title"].includes(q.get("sort")) ? q.get("sort") : "new",
        page: Math.max(1, Number(q.get("page")) || 1),
        size: [20, 50, 100].includes(Number(q.get("size")))
          ? Number(q.get("size"))
          : 20,
        selected: new Set(),
        selecting: false,
        filtersShown: !!q.get("dot") || !!q.get("days") || !!q.get("sort"),
      });
    }
    return views.get(sample);
  }
  const base = (sample = demo()) => (sample ? "/chats?sample=scale" : "/chats");
  function searchQuery(v = view()) {
    const q = new URLSearchParams();
    if (demo()) q.set("sample", "scale");
    if (v.q) q.set("q", v.q);
    if (v.tab !== "all") q.set("view", v.tab);
    if (v.dot !== "all") q.set("dot", v.dot);
    if (v.period !== "all") q.set("days", v.period);
    if (v.sort !== "new") q.set("sort", v.sort);
    if (v.page > 1) q.set("page", v.page);
    if (v.size !== 20) q.set("size", v.size);
    return q;
  }
  function syncURL() {
    if (route().path !== "/chats") return;
    const v = view(), q = searchQuery(v);
    history.replaceState(null, "", "#/chats" + (q.size ? "?" + q : ""));
    v.queryKey = q.toString();
  }
  function resultChatPath(c) {
    const query = searchQuery(), back = "/chats" + (query.size ? "?" + query : "");
    return "/chats/" + encodeURIComponent(c.id) + "?from=" + encodeURIComponent(back);
  }
  function time(c, trash = false) {
    const value = Date.parse(trash ? c.deletedAt : c.updatedAt || c.createdAt);
    return Number.isNaN(value) ? 0 : value;
  }
  function participants(c) {
    return c.dots.map(dotById).filter(Boolean);
  }
  function searchText(c) {
    return [
      c.title,
      ...participants(c).map(title),
      ...c.messages.map((m) => m.text || ""),
    ].join("\n");
  }
  function matchesSearch(c, trash = false) {
    const v = view(), q = v.q.trim().toLocaleLowerCase();
    return (v.dot === "all" || c.dots.includes(v.dot)) &&
      (v.period === "all" || time(c, trash) >= Date.now() - Number(v.period) * 86400000) &&
      (!q || searchText(c).toLocaleLowerCase().includes(q));
  }
  function rows() {
    const v = view(),
      s = store();
    let result = (v.tab === "trash" ? s.trash : s.chats).filter(
      (c) =>
        (v.tab === "trash" ||
          v.tab === "all" ||
          (v.tab === "archived" ? !!c.archivedAt : !c.archivedAt)) &&
        (v.tab !== "pinned" || c.pinned) &&
        matchesSearch(c, v.tab === "trash"),
    );
    result.sort(
      (a, b) =>
        (v.sort === "new" && ["recent", "pinned"].includes(v.tab)
          ? Number(!!b.pinned) - Number(!!a.pinned)
          : 0) ||
        (v.sort === "title"
          ? a.title.localeCompare(b.title, S().lang === "zh" ? "zh" : "en")
          : (v.sort === "old" ? 1 : -1) *
            (time(a, v.tab === "trash") - time(b, v.tab === "trash"))),
    );
    return result;
  }
  function pageRows() {
    const data = rows(),
      v = view();
    v.page = Math.min(v.page, Math.max(1, Math.ceil(data.length / v.size)));
    return data.slice((v.page - 1) * v.size, v.page * v.size);
  }
  function mark(value, query = view().q.trim()) {
    value = String(value || "");
    if (!query) return esc(value);
    let out = "",
      at = 0,
      index,
      lower = value.toLocaleLowerCase(),
      needle = query.toLocaleLowerCase();
    while ((index = lower.indexOf(needle, at)) !== -1) {
      out +=
        esc(value.slice(at, index)) +
        "<mark>" +
        esc(value.slice(index, index + query.length)) +
        "</mark>";
      at = index + query.length;
    }
    return out + esc(value.slice(at));
  }
  function snippet(c, query = view().q) {
    const q = query.trim().toLocaleLowerCase();
    const matched =
      q && c.messages.find((m) => m.text?.toLocaleLowerCase().includes(q));
    const message = matched || [...c.messages].reverse().find((m) => m.text);
    if (!message)
      return `<span class="cl-no-message">${t("还没有消息，开始第一个问题。", "No messages yet. Ask the first question.")}</span>`;
    const text = message.text.replace(/\s+/g, " "),
      index = q ? text.toLocaleLowerCase().indexOf(q) : 0;
    const start = Math.max(0, index - 40),
      excerpt =
        (start ? "…" : "") +
        text.slice(start, start + 155) +
        (text.length > start + 155 ? "…" : "");
    return `${matched ? '<span class="cl-match-label">' + t("正文匹配", "Content match") + "</span>" : ""}${mark(excerpt, query.trim())}`;
  }
  function dateLabel(c, trashed = view().tab === "trash") {
    const at = time(c, trashed);
    if (!at) return esc(c.updated || t("时间未记录", "Date not recorded"));
    return new Intl.DateTimeFormat(S().lang === "zh" ? "zh-CN" : "en-GB", {
      timeZone: "Asia/Kuching",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(at));
  }
  const action = (label, a, c = null, cls = "btn secondary sm", extra = "") =>
    `<button type="button" class="${cls}" data-action="cl-${a}" data-sample="${demo()}" ${c ? `data-id="${c.id}"` : ""} ${extra}>${label}</button>`;
  function tabs() {
    const s = store(),
      v = view();
    const matching = s.chats.filter(c => matchesSearch(c));
    const counts = {
      all: matching.length,
      recent: matching.filter((c) => !c.archivedAt).length,
      pinned: matching.filter((c) => c.pinned && !c.archivedAt).length,
      archived: matching.filter((c) => c.archivedAt).length,
      trash: s.trash.filter(c => matchesSearch(c, true)).length,
    };
    return `<nav class="cl-tabs" aria-label="${t("对话视图", "Conversation views")}">${[
      ["all", "search", t("全部", "All")],
      ["recent", "chat", t("最近对话", "Recent")],
      ["pinned", "pin", t("已置顶", "Pinned")],
      ["archived", "archive", t("已归档", "Archived")],
      ["trash", "trash", t("回收站", "Trash")],
    ]
      .map(([key, icon, label]) =>
        action(
          I(icon) + label + `<span>${counts[key]}</span>`,
          "tab",
          null,
          "cl-tab " + (v.tab === key ? "active" : ""),
          `data-value="${key}" aria-pressed="${v.tab === key}"`,
        ),
      )
      .join("")}</nav>`;
  }
  function chosen() {
    const v = view();
    return (v.tab === "trash" ? store().trash : store().chats).filter((c) =>
      v.selected.has(c.id),
    );
  }
  function toolbar() {
    const v = view(),
      selected = chosen(),
      data = rows(),
      page = pageRows();
    return `<div class="cl-selection ${selected.length ? "active" : ""}" id="cl-selection"><div class="flex">${I(selected.length ? "check" : "info")}<span>${selected.length ? t("已选择 " + selected.length + " 场对话", selected.length + " selected") : t("点击标题继续对话，勾选后可批量整理。", "Open a title to continue. Select conversations to organize in bulk.")}</span>${selected.length ? action(t("清空", "Clear"), "clear", null, "text-link") : ""}</div><div class="cl-bulk-actions">${selected.length ? (v.tab === "trash" ? action(I("refresh") + t("恢复所选", "Restore selected"), "restore-selected") : (v.tab === "archived" ? "" : action(I("pin") + (selected.every((c) => c.pinned) ? t("取消置顶", "Unpin") : t("置顶", "Pin")), "pin-selected")) + action(I("archive") + (v.tab === "archived" ? t("移回最近对话", "Move to Recent") : t("归档", "Archive")), "archive-selected") + action(I("trash") + t("移到回收站", "Move to trash"), "trash-selected")) : ""}</div></div>${selected.length && selected.length < data.length && page.length && page.every((c) => v.selected.has(c.id)) ? `<div class="cl-select-all">${t("已选中本页。", "Current page selected.")} ${action(t("选择全部 " + data.length + " 个筛选结果", "Select all " + data.length + " matching conversations"), "select-filtered", null, "text-link")}</div>` : ""}`;
  }
  function row(c) {
    const v = view(),
      dots = participants(c),
      questions = c.messages.filter((m) => m.role === "user").length,
      trash = v.tab === "trash";
    const main = `<div class="cl-row-title"><strong>${mark(c.title)}</strong>${isTestChat(c) ? `<span class="cl-test-label">${t("测试对话", "Test chat")}</span>` : ""}${c.archivedAt && !trash ? `<span class="cl-archive-label">${t("已归档", "Archived")}</span>` : ""}</div><div class="cl-conversation-meta"><span class="cl-mini-dots">${dots
      .slice(0, 3)
      .map((b) => avatar(b, true))
      .join(
        "",
      )}</span><span class="cl-dot-names">${dots.map((b) => esc(title(b))).join(" · ") || t("暂无参与者", "No participants")}</span><span>·</span><span>${questions} ${t("个问题", "questions")}</span><span class="cl-inline-date">· ${dateLabel(c)}</span></div>${v.q ? `<p class="cl-snippet">${snippet(c)}</p>` : ""}`;
    return `<article class="cl-row ${v.selected.has(c.id) ? "selected" : ""}"><label class="cl-check"><input type="checkbox" data-conversation-check="${c.id}" aria-label="${t("选择：", "Select: ") + esc(c.title)}" ${v.selected.has(c.id) ? "checked" : ""}></label>${trash ? action(main, "preview", c, "cl-main") : `<a class="cl-main" href="#${esc(resultChatPath(c))}">${main}</a>`}<time class="cl-time" title="${esc(c.updatedAt || c.createdAt || c.updated || "")}">${dateLabel(c)}</time><div class="cl-row-actions">${trash ? action(I("refresh"), "restore", c, "icon-btn", `aria-label="${t("恢复：", "Restore: ") + esc(c.title)}"`) : action(I("dots"), "menu", c, "icon-btn", `aria-label="${t("更多操作：", "More actions: ") + esc(c.title)}"`)}</div></article>`;
  }
  function dateGroup(c) {
    const v = view();
    if (c.pinned && v.tab === "recent" && v.sort === "new")
      return t("置顶", "Pinned");
    if (v.q || v.sort === "title") return t(v.q ? "搜索结果" : "对话", v.q ? "Search results" : "Conversations");
    if (v.tab === "pinned") return t("已置顶", "Pinned");
    const at = time(c, v.tab === "trash");
    if (!at) return t("最近", "Recent");
    const day = (ms) => Math.floor((ms + 8 * 3600000) / 86400000),
      days = day(Date.now()) - day(at);
    return days <= 0
      ? t("今天", "Today")
      : days === 1
        ? t("昨天", "Yesterday")
        : days < 7
          ? t("过去 7 天", "Previous 7 days")
          : days < 30
            ? t("过去 30 天", "Previous 30 days")
            : t("更早", "Earlier");
  }
  function groupedRows(page) {
    let previous = "";
    return page
      .map((c) => {
        const label = dateGroup(c),
          heading =
            previous !== label ? `<h2 class="cl-date-group">${label}</h2>` : "";
        previous = label;
        return heading + row(c);
      })
      .join("");
  }
  function empty() {
    const v = view(),
      filtered = v.q || v.dot !== "all" || v.period !== "all";
    return `<div class="cl-empty">${I(filtered ? "search" : v.tab === "archived" ? "archive" : v.tab === "trash" ? "trash" : "chat")}<h2>${filtered ? t("没有匹配的对话", "No matching conversations") : v.tab === "pinned" ? t("重要的对话，留在手边。", "Keep important conversations close.") : v.tab === "archived" ? t("还没有归档的对话", "No archived conversations") : v.tab === "trash" ? t("回收站是空的", "Trash is empty") : t("让一个问题，开启一场对话。", "One question starts a conversation.")}</h2><p>${filtered ? t("试试其他关键词，或清除 Ree 和时间筛选。", "Try another keyword or clear the Ree and date filters.") : v.tab === "pinned" ? t("点击对话旁的图钉，将它置顶。", "Use the pin beside a conversation to keep it on top.") : v.tab === "trash" ? t("移除的对话可在这里恢复。", "Removed conversations can be restored here.") : t("邀请最多 5 个 Ree，让知识在讨论中连接。", "Invite up to five Rees to think together.")}</p>${filtered ? action(t("清除筛选", "Clear filters"), "reset") : ["recent", "all"].includes(v.tab) ? btn(t("开始第一场对话", "Start a conversation"), "new-chat") : action(t("查看最近对话", "View Recent"), "tab", null, "btn secondary", 'data-value="recent"')}</div>`;
  }
  function results() {
    const v = view(),
      data = rows(),
      page = pageRows(),
      pages = Math.max(1, Math.ceil(data.length / v.size));
    return `${toolbar()}<div class="cl-selection-options"><label><input type="checkbox" id="cl-select-page" aria-label="${t("选择本页全部对话", "Select all conversations on this page")}" ${!page.length ? "disabled" : ""}>${t("选择本页", "Select page")}</label>${action(t("完成", "Done"), "select-mode", null, "text-link")}</div><div class="cl-scroll">${groupedRows(page) || empty()}</div><footer class="cl-pagination"><span>${data.length ? t("第 " + ((v.page - 1) * v.size + 1) + "–" + Math.min(v.page * v.size, data.length) + " 项，共 " + data.length + " 项", (v.page - 1) * v.size + 1 + "–" + Math.min(v.page * v.size, data.length) + " of " + data.length) : t("共 0 项", "0 conversations")}</span><div class="flex"><label>${t("每页", "Rows")} <select id="cl-size" aria-label="${t("每页对话数量", "Conversations per page")}">${[20, 50, 100].map((size) => `<option value="${size}" ${v.size === size ? "selected" : ""}>${size}</option>`).join("")}</select></label>${action(I("chevron"), "page", null, "icon-btn flip", `data-value="${v.page - 1}" aria-label="${t("上一页对话", "Previous conversation page")}" ${v.page === 1 ? "disabled" : ""}`)}<span class="mono">${v.page} / ${pages}</span>${action(I("chevron"), "page", null, "icon-btn", `data-value="${v.page + 1}" aria-label="${t("下一页对话", "Next conversation page")}" ${v.page === pages ? "disabled" : ""}`)}</div></footer>`;
  }
  function page() {
    const v = view(), s = store();
    const ids = [...new Set([...s.chats, ...s.trash].flatMap(c => c.dots))];
    const testCount = [...s.chats, ...s.trash].filter(isTestChat).length;
    const originalCount = s.chats.filter(c => !isTestChat(c)).length;
    const select = (id, name, label, options) => `<label><span>${label}</span><select id="${id}" name="${name}" aria-label="${label}">${options.map(([value, label]) => `<option value="${esc(value)}" ${v[name === "days" ? "period" : name] === value ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></label>`;
    return `<div class="cl-page cl-search-page filters-open ${v.selecting ? "is-selecting" : ""}" data-conversations="${demo()}">
      <header class="cl-search-page-head"><div><p class="eyebrow">PICK UP WHERE YOU LEFT OFF</p><h1>${t("搜索对话", "Search conversations")}</h1><p>${t("找到那个问题、那次回答，或一起讨论的知识伙伴。", "Find a question, an answer, or the companions you talked with.")}</p></div><span class="cl-search-page-icon" aria-hidden="true">${I("search")}</span></header>
      ${testCount ? `<p class="cl-search-data-note">${I("layers")}<span>${t(testCount + " 场测试对话" + (originalCount ? " · 保留 " + originalCount + " 场原有对话" : "") + "，可直接测试搜索、筛选和分页。", testCount + " test conversations" + (originalCount ? " · " + originalCount + " existing conversations retained" : "") + ". Search, filter, and paginate here.")}</span></p>` : ""}
      <section class="card cl-search-hero" aria-label="${t("对话搜索条件", "Conversation search filters")}"><form id="conversation-filter-form" class="cl-search-form"><div class="cl-search-input">${I("search")}<input id="cl-search" type="search" name="q" value="${esc(v.q)}" maxlength="4000" placeholder="${t("搜索标题、消息内容或 Ree 名称…", "Search titles, messages, or Ree names…")}" aria-label="${t("搜索历史对话", "Search chat history")}" autocomplete="off">${action(I("close"), "search-clear", null, "icon-btn cl-search-clear", `aria-label="${t("清除搜索", "Clear search")}"`)}<button type="submit" class="btn">${t("搜索", "Search")}</button></div><div class="cl-search-facets">${select("cl-dot", "dot", t("参与的 Ree", "Participating Ree"), [["all", t("全部 Ree", "All Rees")], ...ids.map(id => [id, dotById(id) ? title(dotById(id)) : t("已移除的 Ree", "Removed Ree")])])}${select("cl-period", "days", t("更新时间", "Updated"), [["all",t("全部时间","Any time")],["7",t("最近 7 天","Last 7 days")],["30",t("最近 30 天","Last 30 days")],["90",t("最近 90 天","Last 90 days")]])}${select("cl-sort", "sort", t("排序", "Sort"), [["new",t("最近更新","Recently updated")],["old",t("最早更新","Oldest updated")],["title",t("标题 A–Z","Title A–Z")]])}</div></form></section>
      <div class="cl-search-results-bar"><div id="cl-tabs">${tabs()}</div>${action(I("check") + t("选择", "Select"), "select-mode", null, "btn ghost cl-select-mode", `aria-pressed="${v.selecting}"`)}</div><div class="cl-filter-summary" id="cl-filter-summary" aria-live="polite">${filterSummary()}</div><section class="card cl-results" id="cl-results" aria-label="${t("对话搜索结果", "Conversation search results")}">${results()}</section><p class="cl-note">${I("shield")}${t("全部范围包含归档对话；回收站中的对话可单独搜索和恢复。", "All includes archived chats. Search and restore trashed chats in Trash.")}</p></div>`;
  }
  function filterSummary() {
    const v = view(),
      filtered = v.q || v.dot !== "all" || v.period !== "all";
    const unknown =
      v.period !== "all" &&
      (v.tab === "trash" ? store().trash : store().chats).some(
        (c) => !time(c, v.tab === "trash"),
      );
    return `<span role="status">${filtered ? t("找到 " + rows().length + " 场匹配对话", rows().length + " matching conversations") : t("共 " + rows().length + " 场对话" + (v.tab === "all" ? " · 包含已归档对话" : ""), rows().length + " conversations" + (v.tab === "all" ? " · Includes archived chats" : ""))}${unknown ? `<small class="cl-unknown-time">${t("部分旧对话未记录时间，选择全部时间可查看。", "Some older conversations have no timestamp. Choose Any time to include them.")}</small>` : ""}</span>${filtered ? action(t("清除筛选", "Clear filters"), "reset", null, "text-link") : ""}`;
  }
  function syncSelection() {
    const v = view(),
      page = pageRows(),
      checked = page.filter((c) => v.selected.has(c.id)).length,
      header = document.querySelector("#cl-select-page");
    if (header) {
      header.checked = !!page.length && checked === page.length;
      header.indeterminate = checked > 0 && checked < page.length;
    }
    document.querySelectorAll("[data-conversation-check]").forEach((el) => {
      el.checked = v.selected.has(el.dataset.conversationCheck);
      el.closest(".cl-row").classList.toggle("selected", el.checked);
    });
  }
  function paintSelection() {
    document
      .querySelector(".cl-select-mode")
      ?.setAttribute("aria-pressed", String(view().selecting));
    document
      .querySelector(".cl-page")
      ?.classList.toggle("is-selecting", view().selecting);
    const el = document.querySelector("#cl-selection");
    if (el) {
      if (el.nextElementSibling?.classList.contains("cl-select-all"))
        el.nextElementSibling.remove();
      el.outerHTML = toolbar();
    }
    syncSelection();
  }
  function paint() {
    const el = document.querySelector("#cl-results");
    if (!el) return;
    el.innerHTML = results();
    document.querySelector("#cl-tabs").innerHTML = tabs();
    document.querySelector("#cl-filter-summary").innerHTML = filterSummary();
    const v = view();
    for (const [id, value] of [["cl-search", v.q], ["cl-dot", v.dot], ["cl-period", v.period], ["cl-sort", v.sort]]) {
      const control = document.querySelector("#" + id);
      if (control && control.value !== value) control.value = value;
    }
    syncSelection();
    syncURL();
  }
  function lookup(id) {
    if (!id) return null;
    for (const sample of [false, true]) {
      const s = sample ? sampleStore() : realStore(),
        c =
          s.chats.find((c) => c.id === id) || s.trash.find((c) => c.id === id);
      if (c) return { c, s, sample };
    }
    return null;
  }
  function review(items) {
    return `<div class="cl-review">${items
      .slice(0, 5)
      .map((c) => `<p>${I("chat")}<span>${esc(c.title)}</span></p>`)
      .join(
        "",
      )}${items.length > 5 ? `<small>${t("共 " + items.length + " 场对话", items.length + " conversations in total")}</small>` : ""}</div>`;
  }
  function busy() {
    if (U().busy) {
      toast(
        t(
          "请等待当前回答完成后再整理对话。",
          "Wait for the current answer before organizing conversations.",
        ),
      );
      return true;
    }
    return false;
  }
  function pin(items) {
    if (!items.length || busy()) return;
    const value = !items.every((c) => c.pinned);
    for (const c of items) if (!c.archivedAt) c.pinned = value;
    view().selected.clear();
    save();
    render();
    toast(
      value
        ? t("所选对话已置顶。", "Selected conversations pinned.")
        : t("已取消置顶。", "Conversations unpinned."),
    );
  }
  function archive(items) {
    if (!items.length || busy()) return;
    const restore = items.every((c) => c.archivedAt);
    confirmModal(
      restore
        ? t("移回最近对话？", "Move back to Recent?")
        : t("归档所选对话？", "Archive selected conversations?"),
      review(items) +
        `<p class="form-hint">${t("完整消息会保留，可以随时打开或移回最近对话。", "All messages are retained. Open or move them back to Recent at any time.")}</p>`,
      restore
        ? t("移回最近对话", "Move to Recent")
        : t("归档对话", "Archive conversations"),
      () => {
        if (busy()) return;
        for (const c of items) {
          if (restore) delete c.archivedAt;
          else {
            c.archivedAt = stamp();
            c.pinned = false;
          }
        }
        view().selected.clear();
        save();
        render();
        toast(
          t(
            "已更新 " + items.length + " 场对话。",
            items.length + " conversations updated.",
          ),
        );
      },
    );
  }
  function trash(items, s = store()) {
    if (!items.length || busy()) return;
    confirmModal(
      t(
        "将 " + items.length + " 场对话移到回收站？",
        "Move " + items.length + " conversation(s) to Trash?",
      ),
      review(items) +
        `<p class="form-hint">${t("消息与参与者会保留，可在回收站恢复。", "Messages and participants are retained. Restore them from Trash.")}</p>`,
      t("移到回收站", "Move to Trash"),
      () => {
        if (busy()) return;
        const ids = new Set(items.map((c) => c.id));
        s.chats = s.chats.filter((c) => !ids.has(c.id));
        s.trash = [
          ...items.map((c) => ({ ...c, deletedAt: stamp() })),
          ...s.trash,
        ];
        view().selected.clear();
        save();
        closeModal();
        if (route().path.startsWith("/chats/")) go(base());
        else render();
        toast(
          t(
            "已移到回收站，可随时恢复。",
            "Moved to Trash. Restore at any time.",
          ),
        );
      },
    );
  }
  function restore(items, s = store()) {
    if (!items.length || busy()) return;
    const ids = new Set(items.map((c) => c.id));
    s.trash = s.trash.filter((c) => !ids.has(c.id));
    for (const c of items) {
      delete c.deletedAt;
      if (!s.chats.some((x) => x.id === c.id)) s.chats = [...s.chats, c];
    }
    view().selected.clear();
    save();
    closeModal();
    render();
    toast(
      t(
        "已恢复 " + items.length + " 场对话。",
        items.length + " conversation(s) restored.",
      ),
    );
  }
  function menu(c, anchor) {
    const rect = anchor?.getBoundingClientRect();
    modal(
      esc(c.title),
      t("整理这场对话", "Organize this conversation"),
      `<div class="cl-menu">${action(I("check") + t("选择此对话", "Select conversation"), "select-one", c)}${action(I("settings") + t("重命名", "Rename"), "rename", c)}${!c.archivedAt ? action(I("pin") + (c.pinned ? t("取消置顶", "Unpin") : t("置顶对话", "Pin conversation")), "pin", c) : ""}${action(I("archive") + (c.archivedAt ? t("移回最近对话", "Move to Recent") : t("归档对话", "Archive conversation")), "archive", c)}${action(I("trash") + t("移到回收站", "Move to Trash"), "trash", c)}</div>`,
      "",
    );
    const surface = document.querySelector(".modal");
    surface?.classList.add("cl-menu-dialog");
    if (surface && rect) {
      const width = surface.offsetWidth,
        height = surface.offsetHeight;
      surface.style.position = "fixed";
      surface.style.left =
        Math.max(
          12,
          Math.min(
            window.innerWidth - width - 12,
            anchor.closest("#sidebar") ? rect.right + 8 : rect.right - width,
          ),
        ) + "px";
      surface.style.top =
        Math.max(
          12,
          Math.min(window.innerHeight - height - 12, rect.bottom + 5),
        ) + "px";
    }
  }
  function buildDemo() {
    sampleStore();
    if (route().path === "/chats" && demo()) render();
    else go("/chats?sample=scale");
  }
  function sidebar() {
    const sidebarStore = store();
    const data = sidebarStore.chats.filter((c) => !c.archivedAt),
      currentId = route().path.startsWith("/chats/") ? route().path.split("/")[2] : null;
    const sorted = [...data].sort((a, b) => time(b) - time(a));
    const pinned = sorted.filter((c) => c.pinned),
      recent = sorted.filter((c) => !c.pinned);
    const current = currentId ? findChat(currentId) : null;
    const item = (c) =>
      `<div class="chat-history-row ${c.id === currentId ? "active" : ""}"><a href="#/chats/${c.id}" aria-label="${esc(c.title)}" title="${esc(c.title)}">${c.pinned ? I("pin") : ""}<span class="chat-history-title">${esc(c.title)}</span>${isTestChat(c) ? `<small class="chat-history-test">${t("测试", "Test")}</small>` : ""}</a>${action(I("dots"), "menu", c, "icon-btn", `aria-label="${t("更多操作：", "More actions: ") + esc(c.title)}"`)}</div>`;
    const bucket = (c) => {
      const at = time(c),
        days =
          Math.floor((Date.now() + 28800000) / 86400000) -
          Math.floor((at + 28800000) / 86400000);
      return !at
        ? t("最近", "Recent")
        : days <= 0
          ? t("今天", "Today")
          : days === 1
            ? t("昨天", "Yesterday")
            : days < 7
              ? t("过去 7 天", "Previous 7 days")
              : t("更早", "Earlier");
    };
    let last = "";
    const history = recent
      .map((c) => {
        const label = bucket(c),
          head = last !== label ? `<h4 class="chat-history-date">${label}</h4>` : "";
        last = label;
        return head + item(c);
      })
      .join("");
    const conversationTools = `<div class="chat-sidebar-tools" role="group" aria-label="${t("对话操作", "Conversation actions")}">${btn(I("plus") + `<span>${t("新建对话", "New conversation")}</span>`, "new-chat", `chat-sidebar-tool${route().path === "/talk" ? " active" : ""}`, `aria-label="${t("新建对话", "New conversation")}" title="${t("新建对话", "New conversation")}" ${route().path === "/talk" ? 'aria-current="page"' : ""}`)}${action(I("search") + `<span>${t("搜索对话", "Search conversations")}</span><kbd>⌘ K</kbd>`, "open-search", null, `chat-sidebar-tool${route().path === "/chats" ? " active" : ""}`, `aria-label="${t("搜索对话", "Search conversations")}" title="${t("搜索对话", "Search conversations")}" ${route().path === "/chats" ? 'aria-current="page"' : ""}`)}</div>`;
    return `<aside class="sidebar sidebar-chat" id="sidebar">${wordmark()}${iconBtn("close", t("关闭导航", "Close navigation"), "mobile-menu", 'class="sidebar-close"')}<nav class="nav chat-product-nav" aria-label="${t("空间导航", "Workspace navigation")}">${[
      ["/dashboard", "layers", t("工作台", "Dashboard"), route().path === "/dashboard" || route().path.startsWith("/workspace/")],
      ["/explore", "compass", t("发现 Ree", "Discover Rees"), route().path === "/explore" || route().path.startsWith("/d/")],
      ["/dots", "dot", t("我的 Ree", "My Rees"), route().path.startsWith("/dots") || route().path === "/videos"],
    ].map(([href, icon, label, active]) => `<a href="#${href}" class="${active ? "active" : ""}" ${active ? 'aria-current="page"' : ""} title="${label}">${I(icon)}<span>${label}</span>${href === "/dots" ? `<span class="nav-count">${ownedReeTestCatalog(S().dots).length}</span>` : ""}</a>`).join("")}</nav>${conversationTools}${demo() ? `<div class="chat-sidebar-demo">${t("规模演示 · 320 场对话", "Scale demo · 320 conversations")}</div>` : ""}<div class="chat-history-scroll" role="region" tabindex="0" aria-label="${t("快捷对话历史", "Quick conversation history")}">${current && ![...pinned, ...recent].some((c) => c.id === current.id) ? `<h3>${t("当前对话", "Current conversation")}</h3>${item(current)}` : ""}${pinned.length ? `<h3>${t("置顶", "Pinned")}<span class="chat-history-count">${n(pinned.length)}</span></h3>${pinned.map(item).join("")}` : ""}${recent.length ? `<h3>${t("最近对话", "Recent conversations")}<span class="chat-history-count">${n(recent.length)}</span></h3>` : ""}${history || (!pinned.length ? `<p class="chat-history-empty">${t("新的讨论，从一个问题开始。", "A new discussion starts with a question.")}</p>` : "")}</div>${sidebarAccountFooter(t("我的账户", "My account"))}</aside>`;
  }
  function openSearchPage() {
    closeModal?.();
    if (route().path === "/chats") {
      document.querySelector("#cl-search")?.focus();
      return;
    }
    U().focusConversationSearch = true;
    go(conversationSearchReturnPath(route().query.get("from") || base()));
  }
  async function onAction(a, d, el) {
    if (a !== "delete-chat" && !a.startsWith("cl-")) return false;
    if (!S().signed || S().disabled) return true;
    const v = view(),
      found = lookup(d.id),
      c = found?.c;
    if (a === "cl-open-search") {
      openSearchPage();
      return true;
    }
    if (a === "cl-search-all") { openSearchPage(); return true; }
    if (a === "cl-search-clear") {
      v.q = ""; v.page = 1; v.selected.clear();
      paint();
      document.querySelector("#cl-search")?.focus();
      return true;
    }
    if (a === "delete-chat") {
      if (c) trash([c], found.s);
      return true;
    }
    if (a === "cl-demo") {
      if (S().chatListDemo?.chats?.length || S().chatListDemo?.trash?.length)
        buildDemo();
      else
        confirmModal(
          t("体验 320 场对话的列表", "Explore a 320-conversation list"),
          t(
            "创建独立示例列表，可搜索、筛选、归档和批量整理。你的现有对话保持在原列表中，创建示例不消耗 Credits。",
            "Creates an isolated sample list for search, filters, archiving, and bulk organization. Existing conversations stay in their own list. Creating samples costs no credits.",
          ),
          t("打开规模演示", "Open scale demo"),
          buildDemo,
        );
      return true;
    }
    if (a === "cl-select-mode") {
      v.selecting = !v.selecting;
      if (!v.selecting) v.selected.clear();
      paintSelection();
      const button = document.querySelector(".cl-select-mode");
      button?.setAttribute("aria-pressed", String(v.selecting));
      return true;
    }
    if (a === "cl-filters") {
      v.filtersShown = !v.filtersShown;
      document
        .querySelector(".cl-page")
        ?.classList.toggle("filters-open", v.filtersShown);
      document
        .querySelector(".cl-filter-toggle")
        ?.setAttribute("aria-expanded", String(v.filtersShown));
      return true;
    }
    if (a === "cl-select-one" && c) {
      v.selecting = true;
      v.selected.add(c.id);
      closeModal();
      if (route().path === "/chats") paintSelection();
      else {
        Object.assign(v, { q: "", dot: "all", period: "all", tab: c.archivedAt ? "archived" : "all", page: 1 });
        v.page = Math.floor(Math.max(0, rows().findIndex(row => row.id === c.id)) / v.size) + 1;
        const query = searchQuery(v);
        v.queryKey = query.toString();
        go("/chats" + (query.size ? "?" + query : ""));
      }
      return true;
    }
    if (a === "cl-tab") {
      if (["recent", "pinned", "archived", "trash", "all"].includes(d.value)) {
        v.tab = d.value;
        v.page = 1;
        v.selected.clear();
        syncURL();
        render();
      }
      return true;
    }
    if (a === "cl-reset") {
      Object.assign(v, { q: "", dot: "all", period: "all", page: 1 });
      v.selected.clear();
      syncURL();
      render();
      return true;
    }
    if (a === "cl-page") {
      v.page = Math.max(1, Number(d.value) || 1);
      paint();
      window.scrollTo({ top: 0, behavior: "instant" });
      return true;
    }
    if (a === "cl-clear") {
      v.selected.clear();
      paintSelection();
      return true;
    }
    if (a === "cl-select-filtered") {
      rows().forEach((c) => v.selected.add(c.id));
      paintSelection();
      return true;
    }
    if (a === "cl-menu" && c) {
      menu(c, el);
      return true;
    }
    if (a === "cl-pin" || a === "cl-pin-selected") {
      closeModal();
      pin(a === "cl-pin" ? [c].filter(Boolean) : chosen());
      return true;
    }
    if (a === "cl-archive" || a === "cl-archive-selected") {
      archive(a === "cl-archive" ? [c].filter(Boolean) : chosen());
      return true;
    }
    if (a === "cl-trash" || a === "cl-trash-selected") {
      trash(
        a === "cl-trash" ? [c].filter(Boolean) : chosen(),
        found?.s || store(),
      );
      return true;
    }
    if (a === "cl-restore" || a === "cl-restore-selected") {
      restore(
        a === "cl-restore" ? [c].filter(Boolean) : chosen(),
        found?.s || store(),
      );
      return true;
    }
    if (a === "cl-rename" && c) {
      modal(
        t("重命名对话", "Rename conversation"),
        "",
        `<form id="conversation-rename-form" data-id="${c.id}"><div class="field"><label for="cl-rename">${t("对话标题", "Conversation title")}</label><input id="cl-rename" name="title" value="${esc(c.title)}" maxlength="120" required></div></form>`,
        cancelButton() +
          submitButton(t("保存标题", "Save title"), "conversation-rename-form"),
      );
      return true;
    }
    if (a === "cl-preview" && c) {
      modal(
        esc(c.title),
        t(
          "回收站中的对话 · 只读预览",
          "Trashed conversation · Read-only preview",
        ),
        `<div class="cl-trash-preview">${
          c.messages
            .slice(-8)
            .map(
              (m) =>
                `<article><strong>${m.role === "user" ? t("我", "You") : esc(dotById(m.dot) ? title(dotById(m.dot)) : t("已移除的 Ree", "Removed Ree"))}</strong><p>${esc(m.text || "")}</p></article>`,
            )
            .join("") ||
          `<p>${t("这场对话还没有消息。", "This conversation has no messages.")}</p>`
        }</div>`,
        cancelButton() +
          action(t("恢复对话", "Restore conversation"), "restore", c),
      );
      return true;
    }
    return true;
  }
  function onSubmit(form, f) {
    if (form.id === "conversation-filter-form") {
      const v = view();
      v.q = String(f.get("q") || "");
      v.dot = f.get("dot") || "all";
      v.period = f.get("days") || f.get("period") || "all";
      v.sort = f.get("sort") || "new";
      v.page = 1;
      v.selected.clear();
      paint();
      return true;
    }
    if (form.id === "conversation-rename-form") {
      const found = lookup(form.dataset.id),
        name = String(f.get("title") || "").trim();
      if (!found || busy()) return true;
      if (!name || name.length > 120) {
        toast(
          t(
            "请输入 1–120 个字符的标题。",
            "Enter a title of 1–120 characters.",
          ),
        );
        return true;
      }
      found.c.title = name;
      save();
      closeModal();
      render();
      toast(t("对话标题已保存。", "Conversation title saved."));
      return true;
    }
    return false;
  }
  document.addEventListener("input", (e) => {
    if (e.target.id !== "cl-search") return;
    const v = view();
    v.q = e.target.value;
    v.page = 1;
    v.selected.clear();
    paint();
  });
  document.addEventListener("change", (e) => {
    if (!e.target.closest("[data-conversations]")) return;
    const v = view();
    if (e.target.dataset.conversationCheck) {
      e.target.checked
        ? v.selected.add(e.target.dataset.conversationCheck)
        : v.selected.delete(e.target.dataset.conversationCheck);
      paintSelection();
    }
    if (e.target.id === "cl-select-page") {
      pageRows().forEach((c) =>
        e.target.checked ? v.selected.add(c.id) : v.selected.delete(c.id),
      );
      paintSelection();
    }
    if (["cl-dot", "cl-period", "cl-sort", "cl-size"].includes(e.target.id)) {
      const prop = {
        "cl-dot": "dot",
        "cl-period": "period",
        "cl-sort": "sort",
        "cl-size": "size",
      }[e.target.id];
      v[prop] = prop === "size" ? Number(e.target.value) : e.target.value;
      v.page = 1;
      v.selected.clear();
      paint();
      if (e.target.id === "cl-size")
        window.scrollTo({ top: 0, behavior: "instant" });
    }
  });
  document.addEventListener("scroll", event => {
    if (event.target.classList?.contains("chat-history-scroll"))
      U().conversationSidebarScroll = event.target.scrollTop;
  }, true);
  document.addEventListener(
    "keydown",
    (e) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "k" &&
        (route().path.startsWith("/chats") || (S().signed && !route().path.startsWith("/admin")))
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!document.querySelector('[role="dialog"]')) openSearchPage();
        return;
      }

    },
    true,
  );

  return {
    sidebar,
    page,
    findChat,
    onAction,
    onSubmit,
    afterRender() {
      const sidebarHistory = document.querySelector(".chat-history-scroll");
      if (sidebarHistory) {
        sidebarHistory.scrollTop = U().conversationSidebarScroll || 0;
        const active = sidebarHistory.querySelector(".chat-history-row.active");
        if (active) {
          const box = sidebarHistory.getBoundingClientRect(), row = active.getBoundingClientRect();
          if (row.top < box.top || row.bottom > box.bottom)
            sidebarHistory.scrollTop += row.top - box.top - (box.height - row.height) / 2;
        }
        U().conversationSidebarScroll = sidebarHistory.scrollTop;
      }
      if (document.querySelector("[data-conversations]")) {
        syncSelection();
        syncURL();
        if (U().focusConversationSearch) {
          U().focusConversationSearch = false;
          document.querySelector("#cl-search")?.focus();
        }
      }
    },
  };
}
