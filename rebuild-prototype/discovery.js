import { rolePriority } from "./user-role-domain.js";
import { DOT_CATEGORIES, dotCategory } from "./dot-classification.js";

export const DISCOVERY_DEMO_COUNT = 1200;
export const DISCOVERY_TEST_COUNT = 1000;
const PAGE_SIZES = [24, 48, 96];
const integer = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
export function discoveryView(query) {
  return {
    sample: query.get("sample") === "scale",
    q: (query.get("q") || "").trim().slice(0, 4000),
    category: DOT_CATEGORIES.some(c => c.id === query.get("category")) ? query.get("category") : "all",
    sort: ["answers", "free"].includes(query.get("sort")) ? query.get("sort") : "active",
    size: PAGE_SIZES.includes(Number(query.get("size"))) ? Number(query.get("size")) : 24,
    page: Math.min(100000, integer(query.get("page"), 1)),
  };
}
export function discoveryPath(query, changes = {}) {
  const next = new URLSearchParams(query);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === "" || value === "all") next.delete(key);
    else next.set(key, String(value));
  }
  if (["q", "category", "sort", "size", "sample"].some(key => key in changes)) next.delete("page");
  const view = discoveryView(next), result = new URLSearchParams();
  if (view.sample) result.set("sample", "scale");
  if (view.q) result.set("q", view.q);
  if (view.category !== "all") result.set("category", view.category);
  if (view.sort !== "active") result.set("sort", view.sort);
  if (view.size !== 24) result.set("size", view.size);
  if (view.page > 1) result.set("page", view.page);
  return "/explore" + (result.size ? "?" + result : "");
}

let demoCatalog;
export function discoveryDemoDots() {
  if (demoCatalog) return demoCatalog;
  const subjects = [
    [["React 组件实践", "React components"], ["Python 自动化笔记", "Python automation"], ["AI 工作流指南", "AI workflows"]],
    [["设计系统实践", "Design systems"], ["用户体验研究", "UX research"], ["品牌视觉手册", "Brand identity"]],
    [["独立开发手记", "Indie maker notes"], ["产品增长实验", "Product growth"], ["职场沟通指南", "Workplace communication"]],
    [["论文阅读伙伴", "Research reading"], ["学习方法笔记", "Learning methods"], ["数据研究手册", "Research data"]],
    [["专业知识笔记", "Professional notes"], ["行业研究档案", "Industry research"], ["方法与案例库", "Methods and cases"]],
    [["城市旅行手记", "City travel notes"], ["摄影入门指南", "Photography guide"], ["生活灵感收藏", "Everyday ideas"]],
    [["跨领域知识集", "Connected knowledge"], ["灵感与观察", "Ideas and observations"], ["知识整理手册", "Knowledge organization"]],
  ];
  demoCatalog = Array.from({ length: DISCOVERY_DEMO_COUNT }, (_, index) => {
    const categoryIndex = index % DOT_CATEGORIES.length, category = DOT_CATEGORIES[categoryIndex];
    const subject = subjects[categoryIndex][Math.floor(index / DOT_CATEGORIES.length) % 3];
    const number = String(index + 1).padStart(4, "0"), name = `${subject[0]} · ${number}`;
    return {
      id: "discovery-scale-" + number, slug: "discovery-scale-" + number,
      discoveryDemo: true, public: true, owner: "知识创作者 " + (index % 83 + 1),
      name, enName: `${subject[1]} · ${number}`,
      description: `围绕${subject[0]}，整理实践方法、关键概念与案例，帮你找到有依据的思考。`,
      enDescription: `Methods, key concepts and practical cases about ${subject[1].toLowerCase()}.`,
      category: category.id, tags: category.tags.slice(0, 2),
      color: ["", "lilac", "sage", "sand", "rose", "slate"][index % 6],
      fee: [0, 10, 20, 30, 50, 100][index % 6],
      answers: (index * 97 + 41) % 12000, rating: 90 + index % 10,
      samples: [`${subject[0]}应该从哪里开始？`, `有哪些值得借鉴的实践方法？`, `如何把这些知识用到实际项目中？`],
      knowledge: Array.from({ length: 3 + index % 12 }, (_, i) => ({ id: `scale-source-${i + 1}`, title: `演示资料 ${i + 1}`, kind: "document", status: "ready", enabled: true, content: "" })),
      video: { generated: index % 3 !== 0, template: ["editorial", "blueprint", "spotlight"][index % 3], accent: "#127ee3", aspect: "16:9", music: false, scenes: [{ name, position: "让知识，连接新的可能。" }, { sources: "演示资料 1\n演示资料 2\n演示资料 3" }, { question: "应该如何开始？", answer: "先明确问题，再从相关资料和实践案例出发。" }, { cta: "让下一个问题，遇见懂它的知识。" }] },
    };
  });
  return demoCatalog;
}
export function discoveryDemoDot(id) {
  const match = /^discovery-scale-(\d{4})$/.exec(id || "");
  if (!match || Number(match[1]) < 1 || Number(match[1]) > DISCOVERY_DEMO_COUNT) return undefined;
  return discoveryDemoDots()[Number(match[1]) - 1];
}
// Keep a 1,000-item external directory, then add the live public owned Rees.
// Filling the external directory must not replace a newly hidden owned Ree.
export function discoveryTestCatalog(realDots, ownedDots = realDots.filter(dot => dot.owner === "me")) {
  const result = realDots.filter(dot => dot.public && !dot.moderated && dot.owner !== "me");
  const records = [...realDots, ...ownedDots];
  const ids = new Set(records.map(dot => dot.id));
  const slugs = new Set(records.map(dot => dot.slug).filter(Boolean));
  for (const dot of discoveryDemoDots()) {
    if (result.length >= DISCOVERY_TEST_COUNT) break;
    if (ids.has(dot.id) || slugs.has(dot.slug)) continue;
    result.push(dot);
    ids.add(dot.id);
    slugs.add(dot.slug);
  }
  const visibleIds = new Set(result.map(dot => dot.id));
  const visibleSlugs = new Set(result.map(dot => dot.slug).filter(Boolean));
  const owned = ownedDots.filter(dot => {
    if (dot.owner !== "me" || !dot.public || dot.moderated || visibleIds.has(dot.id) || (dot.slug && visibleSlugs.has(dot.slug))) return false;
    visibleIds.add(dot.id);
    if (dot.slug) visibleSlugs.add(dot.slug);
    return true;
  });
  return [...owned, ...result];
}
export function selectDiscoveryDots(realDots, query, score = (dot, q) => [dot.name, dot.enName, dot.description, ...(dot.tags || [])].join(" ").toLowerCase().includes(q.toLowerCase()) ? 1 : 0, ownerRole = () => "normal") {
  const view = discoveryView(query);
  const catalog = view.sample ? discoveryDemoDots() : realDots;
  let result = catalog.filter(dot => dot.public && !dot.moderated && (view.category === "all" || dotCategory(dot) === view.category));
  const roleOrder=(a,b)=>rolePriority(ownerRole(b))-rolePriority(ownerRole(a));
  result.sort(roleOrder);
  if (view.q) result = result.map(dot => ({ dot, score: score(dot, view.q) })).filter(row => row.score > 0).sort((a, b) => b.score - a.score || roleOrder(a.dot,b.dot)).map(row => row.dot);
  if (view.sort === "answers") result.sort((a, b) => b.answers - a.answers || (!view.q?roleOrder(a,b):0));
  if (view.sort === "free") result.sort((a, b) => a.fee - b.fee || (!view.q?roleOrder(a,b):0));
  const total = result.length, pages = Math.max(1, Math.ceil(total / view.size));
  view.page = Math.min(view.page, pages);
  const start = (view.page - 1) * view.size;
  return { view, total, pages, start: total ? start + 1 : 0, end: Math.min(start + view.size, total), items: result.slice(start, start + view.size) };
}
export function discoveryPageNumbers(page, pages) {
  const values = [...new Set([1, page - 1, page, page + 1, pages])].filter(value => value > 0 && value <= pages).sort((a, b) => a - b);
  return values.flatMap((value, index) => index && value - values[index - 1] > 1 ? [null, value] : [value]);
}

export function createDiscovery(ctx) {
  const { t, I, esc, n, route, go, footer, dotCard, queryScore } = ctx;
  let observer;
  const link = (path, label, attrs = "") => `<a href="#${esc(path)}" ${attrs}>${label}</a>`;
  const catalog = () => discoveryView(route().query).sample
    ? ctx.publicDots()
    : discoveryTestCatalog(ctx.getState?.()?.dots || ctx.publicDots(), ctx.getOwnedRees?.());
  const select = () => selectDiscoveryDots(catalog(), route().query, queryScore, dot=>ctx.userRoles?.roleForRee(dot)||"normal");
  function pager(data, compact = false) {
    const { view, pages } = data;
    if (pages <= 1) return "";
    const pageLink = (page, label, accessible) => page < 1 || page > pages
      ? `<span class="is-disabled" aria-disabled="true">${label}</span>`
      : link(discoveryPath(route().query, { page }), label, `aria-label="${accessible}"`);
    return `<nav class="discovery-pagination ${compact ? "is-compact" : ""}" aria-label="${t(compact ? "列表顶部分页" : "Ree 分页", compact ? "Top pagination" : "Ree pagination")}">${pageLink(view.page - 1, I("chevron"), t("上一页", "Previous page"))}${compact ? `<span class="mono">${view.page} / ${pages}</span>` : discoveryPageNumbers(view.page, pages).map(value => value === null ? '<span class="pagination-ellipsis">…</span>' : value === view.page ? `<span class="is-current" aria-current="page">${value}</span>` : pageLink(value, value, t("第 ", "Page ") + value + t(" 页", ""))).join("")}${pageLink(view.page + 1, I("chevron"), t("下一页", "Next page"))}${compact ? "" : `<form id="discovery-page-jump"><label for="discovery-page-number">${t("跳至", "Go to")}</label><input id="discovery-page-number" aria-label="${t("跳转页码", "Page number")}" name="page" type="number" min="1" max="${pages}" value="${view.page}" required><span>${t("页", "")}</span><button type="submit">${t("跳转", "Go")}</button></form>`}</nav>`;
  }
  function page() {
    const data = select(), { view } = data;
    const canonical = discoveryPath(route().query, { page: view.page });
    if (route().query.has("page") && Number(route().query.get("page")) !== view.page)
      history.replaceState(null, "", "#" + canonical);
    return `<div class="page discovery-page"><header class="discovery-page-head"><div><p class="eyebrow">FIND YOUR KNOWLEDGE COMPANION</p><h1>${t("发现 Ree", "Discover Rees")}</h1><p>${t("从一个问题出发，找到真正懂它的知识。", "Start with a question. Find knowledge that understands.")}</p></div></header>
      <p class="discovery-data-note">${I("info")}${t("已公开的自有 Ree 会同步展示，私有或已下架后隐藏；测试 Ree 的状态刷新后恢复，示例仅供浏览。", "Your public Rees appear here; private or taken-down Rees are hidden. Test visibility resets on refresh; samples are for browsing only.")}</p>
      <section class="discovery-toolbar" aria-label="${t("搜索与筛选 Ree", "Search and filter Rees")}"><div class="discovery-search-row"><form class="search-box" id="discovery-search">${I("search")}<input id="explore-input" name="q" aria-label="${t("输入问题或关键词", "Enter a question or keywords")}" placeholder="${t("搜索名称、领域，或输入一个问题…", "Search names, subjects, or ask a question…")}" value="${esc(view.q)}" maxlength="4000" autocomplete="off">${view.q ? `<button type="button" class="icon-btn" data-action="discover-clear" aria-label="${t("清除搜索", "Clear search")}">${I("close")}</button>` : ""}<button type="submit" class="btn">${t("搜索", "Search")}</button></form><label class="discovery-select"><span>${t("排序", "Sort")}</span><select id="discovery-sort" aria-label="${t("排序方式", "Sort Rees")}">${[["active",t("推荐优先","Recommended")],["answers",t("回答最多","Most answers")],["free",t("查询费最低","Lowest fee")]].map(([value,label])=>`<option value="${value}" ${view.sort === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><label class="discovery-select"><span>${t("每页", "Per page")}</span><select id="discovery-size" aria-label="${t("每页数量", "Rees per page")}">${PAGE_SIZES.map(size=>`<option value="${size}" ${view.size === size ? "selected" : ""}>${size} ${t("个", "Rees")}</option>`).join("")}</select></label></div><div class="filter-row" role="group" aria-label="${t("Ree 分类", "Ree categories")}">${[{id:"all",name:"全部",en:"All"},...DOT_CATEGORIES].map(category=>`<button type="button" class="filter ${view.category === category.id ? "active" : ""}" data-action="discover-category" data-value="${category.id}" aria-pressed="${view.category === category.id}">${t(category.name,category.en)}</button>`).join("")}</div></section>
      <div class="discovery-results-head"><p role="status" aria-live="polite">${view.q ? `<strong>“${esc(view.q)}”</strong> · ` : ""}${t("共", "")} <strong>${n(data.total)}</strong> ${t("个 Ree", "Rees")}${data.total ? `<span> · ${t("显示", "Showing")} ${n(data.start)}–${n(data.end)}</span>` : ""}</p>${pager(data,true)}</div>
      <div class="dot-grid" id="explore-results" aria-label="${t("Ree 列表", "Ree list")}">${data.items.map(dot=>dotCard(dot,view.q)).join("")}</div>
      ${data.total ? `<div class="discovery-results-footer"><span>${t("第", "Page")} ${view.page} / ${data.pages} ${t("页", "")}</span>${pager(data)}</div>` : `<div class="card empty">${I("search")}<h2>${t("没有找到相关的 Ree", "No matching Rees")}</h2><p>${t("试试其他关键词，或重置搜索和分类。", "Try another keyword, or reset search and category.")}</p><button class="btn secondary" data-action="discover-reset">${t("重置筛选", "Reset filters")}</button></div>`}
      <div class="knowledge-banner"><div><h3>${t("你的知识，也值得拥有自己的 Ree。", "Your knowledge deserves a Ree of its own.")}</h3><p>${t("从一份文档开始，把经验变成可以对话的伙伴。", "Start with a source. Turn experience into a conversation.")}</p></div><button class="btn secondary" data-action="create-dot">${I("plus")}${t("创建我的 Ree", "Create my Ree")}</button></div>${footer()}</div>`;
  }
  function scrollToResults() {
    const toolbar = document.querySelector(".discovery-toolbar");
    const results = document.querySelector(".discovery-results-head");
    const header = document.querySelector(".app-main > .topbar, .marketing-header");
    if (!toolbar || !results) return;
    const top = window.scrollY + results.getBoundingClientRect().top - toolbar.getBoundingClientRect().height - (header?.getBoundingClientRect().height || 0);
    window.scrollTo({ top:Math.max(0, top), behavior:"instant" });
  }
  function afterRender() {
    observer?.disconnect();
    const page = document.querySelector(".discovery-page");
    if (!page) return;
    const header = document.querySelector(".app-main > .topbar, .marketing-header");
    const measure = () => page.style.setProperty("--discovery-sticky-top", `${header?.getBoundingClientRect().height || 0}px`);
    measure();
    if (header) { observer = new ResizeObserver(measure); observer.observe(header); }
    if (discoveryView(route().query).page > 1)
      requestAnimationFrame(scrollToResults);
  }
  function onAction(action, data) {
    if (!action.startsWith("discover-")) return false;
    if (action === "discover-category") go(discoveryPath(route().query, { category:data.value }));
    if (action === "discover-clear") go(discoveryPath(route().query, { q:"" }));
    if (action === "discover-reset") go(discoveryPath(route().query, { q:"",category:"all",sort:"active" }));
    return true;
  }
  function onSubmit(form, values) {
    if (form.id === "discovery-search") { go(discoveryPath(route().query, { q:values.get("q") })); return true; }
    if (form.id === "discovery-page-jump") {
      const data = select();
      go(discoveryPath(route().query, { page:Math.min(data.pages, integer(values.get("page"), 1)) }));
      return true;
    }
    return false;
  }
  document.addEventListener("change", event => {
    if (event.target.id === "discovery-size") go(discoveryPath(route().query, { size:event.target.value }));
    if (event.target.id === "discovery-sort") go(discoveryPath(route().query, { sort:event.target.value }));
  });
  window.addEventListener("hashchange", event => {
    const oldPath = new URL(event.oldURL).hash.slice(1).split("?")[0];
    if (route().path === "/explore" && (oldPath === "/explore" || oldPath.startsWith("/d/")))
      requestAnimationFrame(scrollToResults);
  });
  return { page, afterRender, onAction, onSubmit };
}
