import { discoveryPageNumbers } from "./discovery.js";
import { workspaceSummary, sourceSummary } from "./workspace.js";

export const OWNED_REE_DEMO_COUNT = 600;
export const OWNED_REE_PAGE_SIZES = [12, 24, 48];
export function ownedReeView(query) {
  const page = Number(query.get("page"));
  return {
    sample: query.get("sample") === "scale",
    layout: query.get("view") === "list" ? "list" : "cards",
    sort: ["name", "sources", "answers"].includes(query.get("sort")) ? query.get("sort") : "default",
    order: ["asc", "desc"].includes(query.get("order")) ? query.get("order") : query.get("sort") === "name" ? "asc" : "desc",
    q: (query.get("q") || "").trim().slice(0, 4000),
    visibility: ["public", "private"].includes(query.get("visibility")) ? query.get("visibility") : "all",
    size: OWNED_REE_PAGE_SIZES.includes(Number(query.get("size"))) ? Number(query.get("size")) : 12,
    page: Number.isFinite(page) && page >= 1 ? Math.min(100000, Math.floor(page)) : 1,
  };
}
export function ownedReePath(query, changes = {}) {
  const next = new URLSearchParams(query);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === "" || value === "all") next.delete(key);
    else next.set(key, String(value));
  }
  if (["q", "visibility", "size", "sample", "sort", "order"].some(key => key in changes)) next.delete("page");
  const view = ownedReeView(next), result = new URLSearchParams();
  if (view.sample) result.set("sample", "scale");
  if (view.q) result.set("q", view.q);
  if (view.visibility !== "all") result.set("visibility", view.visibility);
  if (view.layout === "list") result.set("view", "list");
  if (view.sort !== "default") {
    result.set("sort", view.sort);
    result.set("order", view.order);
  }
  if (view.size !== 12) result.set("size", view.size);
  if (view.page > 1) result.set("page", view.page);
  return "/dots" + (result.size ? "?" + result : "");
}
let demoRows;
export function ownedReeDemoRows() {
  if (demoRows) return demoRows;
  const subjects = [
    ["产品设计知识库", "Product design"], ["前端开发手册", "Frontend handbook"],
    ["阅读与研究笔记", "Reading and research"], ["品牌与创作灵感", "Brand inspiration"],
    ["团队协作档案", "Team collaboration"], ["生活与旅行收藏", "Life and travel"],
  ];
  demoRows = Array.from({ length: OWNED_REE_DEMO_COUNT }, (_, index) => {
    const number = String(index + 1).padStart(4, "0"), subject = subjects[index % subjects.length];
    return {
      id: "owned-ree-scale-" + number, slug: "owned-ree-scale-" + number,
      ownedDemo: true, owner: "me", public: index % 3 !== 2, moderated: index % 30 === 0,
      name: `${subject[0]}${index % 17 === 0 ? " · 长名称与多领域实践资料整理" : ""} · ${number}`,
      enName: `${subject[1]}${index % 17 === 0 ? " · Extended notes and practical references" : ""} · ${number}`,
      description: `围绕${subject[0]}整理方法、实践与经验，记录值得反复思考的问题。${index % 5 === 0 ? "从概念梳理到案例复盘，为每一次讨论提供清晰、可追溯的知识依据。" : ""}`,
      enDescription: `Methods, practice and experience about ${subject[1].toLowerCase()}. Notes and references for your next useful conversation.`,
      color: ["", "sage", "lilac", "sand", "rose", "slate"][index % 6],
      tags: [subject[0]], fee: 0, answers: (index * 173) % 120000,
      knowledge: Array.from({ length: index % 16 }, (_, i) => ({
        id: `sample-source-${i}`, title: `演示来源 ${i + 1}`, kind: "document", status: "ready", content: "",
      })),
    };
  });
  return demoRows;
}
// Keep test records outside account storage while making them directly available
// in the normal directory. Existing records take precedence over colliding IDs.
export function ownedReeTestCatalog(realDots, samples = ownedReeDemoRows()) {
  const owned = realDots.filter(dot => dot.owner === "me");
  const ids = new Set(realDots.map(dot => dot.id));
  const slugs = new Set(realDots.map(dot => dot.slug).filter(Boolean));
  return [...owned, ...samples.filter(dot => !ids.has(dot.id) && (!dot.slug || !slugs.has(dot.slug)))];
}
const nameCollators = {
  zh: new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" }),
  en: new Intl.Collator("en", { numeric: true, sensitivity: "base" }),
};
export function selectOwnedRees(realDots, query, title = dot => dot.name, locale = "zh", samples) {
  const view = ownedReeView(query);
  const catalog = (view.sample ? samples || ownedReeDemoRows() : realDots).filter(dot => dot.owner === "me");
  const q = view.q.toLocaleLowerCase();
  const rows = catalog.filter(dot => {
    const visible = !!dot.public && !dot.moderated;
    return (view.visibility === "all" || (view.visibility === "public" ? visible : !visible)) &&
      (!q || [title(dot), dot.name, dot.enName, dot.description, dot.enDescription, ...(dot.tags || [])]
        .filter(Boolean).join(" ").toLocaleLowerCase().includes(q));
  });
  if (view.sort !== "default") {
    const collator = nameCollators[locale] || nameCollators.zh;
    const count = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
    const value = dot => view.sort === "sources" ? (dot.knowledge || []).length : count(dot.answers);
    const direction = view.order === "asc" ? 1 : -1;
    // Array#sort is stable: equal names or counts retain their original relative order.
    rows.sort((a, b) => direction * (view.sort === "name"
      ? collator.compare(String(title(a) || a.name || ""), String(title(b) || b.name || ""))
      : value(a) - value(b)));
  }
  const total = rows.length, pages = Math.max(1, Math.ceil(total / view.size));
  view.page = Math.min(view.page, pages);
  const offset = (view.page - 1) * view.size;
  return { view, catalog, matches: rows, total, pages, start: total ? offset + 1 : 0, end: Math.min(offset + view.size, total), items: rows.slice(offset, offset + view.size) };
}
// Plans are revalidated at confirmation; moderation and ownership cannot be bypassed.
export function ownedReeVisibilityPlan(dots, ids, visibility, { sample = false } = {}) {
  const requested = new Set(ids), result = { changes: [], blocked: [], unchanged: [], unavailable: [] };
  if (!["public", "private"].includes(visibility)) return result;
  const wanted = visibility === "public";
  const available = new Map(dots.filter(dot => dot.owner === "me" && (sample === null || !!dot.ownedDemo === sample)).map(dot => [dot.id, dot]));
  for (const id of requested) {
    const dot = available.get(id);
    if (!dot) result.unavailable.push(id);
    else if (wanted && dot.moderated) result.blocked.push(id);
    else if (!!dot.public === wanted) result.unchanged.push(id);
    else result.changes.push({ id, before: dot.public, hadPublic: Object.hasOwn(dot, "public"), after: wanted });
  }
  return result;
}
export function createOwnedRees(ctx) {
  const { t, I, esc, n, route, go, title, desc, btn, footer, ownedDotCard, modal, avatar, confirmModal, save, render, toast } = ctx;
  let scrollToResults = false, focusView = false, focusSort = "";
  let samples, selectionScope = "";
  const selected = new Set();
  function catalog() {
    samples ||= ownedReeDemoRows().map(dot => ({ ...dot }));
    return ownedReeTestCatalog(ctx.getState().dots, samples);
  }
  function data() {
    const rows = catalog();
    const state = ctx.getState();
    return selectOwnedRees(rows, route().query, title, state.lang, samples);
  }
  const scopeKey = view => JSON.stringify([view.sample, view.layout, view.q, view.visibility]);
  function synchronize(result) {
    const key = scopeKey(result.view);
    if (selectionScope !== key || result.view.layout !== "list") selected.clear();
    selectionScope = key;
    const available = new Set(result.matches.map(dot => dot.id));
    for (const id of selected) if (!available.has(id)) selected.delete(id);
    return result;
  }
  const plan = (result, visibility, ids = selected) => ownedReeVisibilityPlan(result.catalog, ids, visibility, { sample: result.view.sample ? true : null });
  const link = (path, label, attrs = "") => `<a href="#${esc(path)}" ${attrs}>${label}</a>`;
  function pager(result, compact = false) {
    if (result.pages <= 1) return "";
    const { view, pages } = result;
    const item = (page, label, accessible) => page < 1 || page > pages
      ? `<span class="is-disabled" aria-disabled="true">${label}</span>`
      : link(ownedReePath(route().query, { page }), label, `aria-label="${accessible}"`);
    return `<nav class="discovery-pagination ${compact ? "is-compact" : ""}" aria-label="${t(compact ? "我的 Ree 顶部分页" : "我的 Ree 分页", compact ? "My Rees top pagination" : "My Rees pagination")}">${item(view.page - 1, I("chevron"), t("上一页 Ree", "Previous Rees"))}${compact ? `<span class="mono">${view.page} / ${pages}</span>` : discoveryPageNumbers(view.page, pages).map(page => page === null ? '<span class="pagination-ellipsis">…</span>' : page === view.page ? `<span class="is-current" aria-current="page">${page}</span>` : item(page, page, t("第 ", "Page ") + page + t(" 页", ""))).join("")}${item(view.page + 1, I("chevron"), t("下一页 Ree", "Next Rees"))}${compact ? "" : `<form id="owned-ree-jump"><label for="owned-ree-page">${t("跳至", "Go to")}</label><input id="owned-ree-page" name="page" type="number" min="1" max="${pages}" value="${view.page}" aria-label="${t("我的 Ree 跳转页码", "My Rees page number")}" required><button type="submit">${t("跳转", "Go")}</button></form>`}</nav>`;
  }
  function viewSwitcher(view) {
    return `<div class="owned-ree-view-switch" role="group" aria-label="${t("Ree 显示方式", "Ree display mode")}">${[
      ["cards", "grid", t("卡片", "Cards"), t("卡片视图", "Card view")],
      ["list", "list", t("列表", "List"), t("列表视图", "List view")],
    ].map(([value, icon, label, accessible]) => `<button type="button" data-action="owned-ree-view" data-value="${value}" aria-label="${accessible}" title="${accessible}" aria-pressed="${view.layout === value}">${I(icon)}<span>${label}</span></button>`).join("")}</div>`;
  }
  function sortOptions() {
    return [
      ["default", t("默认顺序", "Default order")],
      ["name:asc", t("名称 · 升序", "Name · A–Z")],
      ["name:desc", t("名称 · 降序", "Name · Z–A")],
      ["sources:desc", t("知识来源 · 从多到少", "Sources · Most first")],
      ["sources:asc", t("知识来源 · 从少到多", "Sources · Fewest first")],
      ["answers:desc", t("成功回答 · 从多到少", "Answers · Most first")],
      ["answers:asc", t("成功回答 · 从少到多", "Answers · Fewest first")],
    ];
  }
  function sortControl(view) {
    const selected = view.sort === "default" ? "default" : view.sort + ":" + view.order;
    return `<label class="owned-ree-sort-control"><span>${t("排序", "Sort")}</span><select id="owned-ree-sort" aria-label="${t("我的 Ree 排序方式", "Sort my Rees")}">${sortOptions().map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join("")}</select></label>`;
  }
  function sortHeader(key, label, view) {
    const active = view.sort === key;
    const next = active ? (view.order === "asc" ? "desc" : "asc") : key === "name" ? "asc" : "desc";
    const field = { name: t("名称", "name"), sources: t("知识来源数量", "source count"), answers: t("成功回答数", "answer count") }[key];
    const accessible = t("按" + field + (next === "asc" ? "升序" : "降序") + "排序", "Sort by " + field + (next === "asc" ? " ascending" : " descending"));
    return `<th class="owned-ree-heading-${key}" scope="col" aria-sort="${active ? view.order === "asc" ? "ascending" : "descending" : "none"}"><button type="button" class="owned-ree-sort-button" data-action="owned-ree-sort" data-value="${key}" aria-label="${accessible}" title="${accessible}">${label}${I(active ? "down" : "sort")}</button></th>`;
  }
  function applySort(sort, order, focus) {
    if (!["default", "name", "sources", "answers"].includes(sort) || (sort !== "default" && !["asc", "desc"].includes(order))) return;
    scrollToResults = true;
    focusSort = focus;
    go(ownedReePath(route().query, { sort: sort === "default" ? null : sort, order: sort === "default" ? null : order }));
  }
  function list(items, view) {
    const rows = items.map(dot => {
      const root = "/dots/" + encodeURIComponent(dot.id), demo = dot.ownedDemo;
      const name = esc(title(dot)), description = esc(desc(dot));
      const sources = sourceSummary(dot.knowledge || []);
      const state = dot.moderated ? "moderated" : dot.public ? "public" : "private";
      const status = state === "moderated" ? t("已下架", "Taken down") : state === "public" ? t("公开", "Public") : t("仅自己", "Private");
      const preview = (body, attrs = "") => `<button type="button" data-action="owned-ree-preview" data-id="${esc(dot.id)}" ${attrs}>${body}</button>`;
      const identity = `${avatar(dot, true)}<span><strong title="${name}">${name}</strong><small title="${description}">${description}</small></span>`;
      return `<tr class="owned-ree-list-row${selected.has(dot.id) ? " is-selected" : ""}"><td class="owned-ree-list-selection"><label><input type="checkbox" data-owned-ree-check="${esc(dot.id)}" aria-label="${esc(t("选择 Ree：", "Select Ree: ") + title(dot))}" ${selected.has(dot.id) ? "checked" : ""}></label></td><td class="owned-ree-list-identity">${demo ? preview(identity, `class="owned-ree-list-name" aria-label="${esc(t("预览演示 Ree：", "Preview sample Ree: ") + title(dot))}"`) : link(root, identity, `class="owned-ree-list-name" aria-label="${esc(t("打开工作台：", "Open studio: ") + title(dot))}"`)}</td><td class="owned-ree-list-status"><span class="owned-ree-status ${state}">${I(state === "public" ? "globe" : state === "moderated" ? "shield" : "lock")}${status}</span></td><td class="owned-ree-list-sources"><span class="owned-ree-mobile-label">${t("知识来源", "Sources")}</span>${demo ? `<strong>${n(sources.total)}</strong>` : link(root + "/knowledge", n(sources.total), `class="owned-ree-count-link" aria-label="${esc(t("管理知识：", "Manage knowledge: ") + title(dot))}"`)}<small>${t(n(sources.ready) + " 个已就绪", n(sources.ready) + " ready")}</small></td><td class="owned-ree-list-answers"><span class="owned-ree-mobile-label">${t("成功回答", "Answers")}</span>${demo ? `<strong>${n(dot.answers || 0)}</strong>` : link(root + "/statistics", n(dot.answers || 0), `class="owned-ree-count-link" aria-label="${esc(t("查看使用统计：", "View statistics: ") + title(dot))}"`)}</td><td class="owned-ree-list-actions">${demo ? `<span class="owned-ree-demo-label">${t("测试 Ree · 详情只读", "Test Ree · Read-only details")}</span>${preview(t("查看预览", "Preview") + I("arrow"), 'class="btn secondary sm"')}` : `${link(root + "/knowledge", t("管理知识", "Knowledge"), `class="btn secondary sm" aria-label="${esc(t("管理知识：", "Manage knowledge: ") + title(dot))}"`)}${link(root + "/video", I("film") + t("视频介绍", "Video"), `class="text-link" aria-label="${esc(t("视频介绍：", "Video: ") + title(dot))}"`)}${link(root + "/settings", I("settings"), `class="icon-btn" aria-label="${esc(t("设置：", "Settings: ") + title(dot))}" title="${esc(t("设置：", "Settings: ") + title(dot))}"`)}`}</td></tr>`;
    }).join("");
    return `<div class="card owned-ree-list-wrap"><table class="owned-ree-table"><caption class="owned-ree-sr-only">${t("我的 Ree 列表", "My Rees list")}</caption><thead><tr><th class="owned-ree-heading-selection" scope="col"><input type="checkbox" data-owned-ree-page-check aria-label="${t("选择本页全部 Ree", "Select all Rees on this page")}"></th>${sortHeader("name", t("Ree 名称", "Ree name"), view)}<th class="owned-ree-heading-status" scope="col">${t("公开状态", "Visibility")}</th>${sortHeader("sources", t("知识来源", "Sources"), view)}${sortHeader("answers", t("成功回答", "Answers"), view)}<th class="owned-ree-heading-actions" scope="col">${t("管理", "Manage")}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  function selectionToolbar(result) {
    const pageSelected = result.items.filter(dot => selected.has(dot.id)).length;
    const publicPlan = plan(result, "public"), privatePlan = plan(result, "private");
    const otherPages = selected.size - pageSelected;
    return `<div class="owned-ree-bulk-bar"><div class="owned-ree-bulk-summary"><label><input type="checkbox" data-owned-ree-page-check aria-label="${t("选择本页 Ree", "Select this page of Rees")}" ${!result.items.length ? "disabled" : ""}><span>${t("选择本页", "Select page")}</span></label><span role="status" aria-live="polite">${t("已选 " + n(selected.size) + " 个", n(selected.size) + " selected")}${otherPages ? `<small>${t("含其他页 " + n(otherPages) + " 个", n(otherPages) + " on other pages")}</small>` : ""}</span>${selected.size ? `<button type="button" class="text-link" data-action="owned-ree-selection-clear">${t("清空选择", "Clear selection")}</button>` : ""}</div><div class="owned-ree-bulk-actions">${selected.size && selected.size < result.total ? `<button type="button" class="text-link" data-action="owned-ree-select-filtered">${t("选中全部 " + n(result.total) + " 个结果", "Select all " + n(result.total) + " results")}</button>` : ""}<button type="button" class="btn secondary sm" data-action="owned-ree-bulk-visibility" data-value="public" ${!publicPlan.changes.length ? "disabled" : ""}>${I("globe")}${t("设为公开", "Make public")}</button><button type="button" class="btn secondary sm" data-action="owned-ree-bulk-visibility" data-value="private" ${!privatePlan.changes.length ? "disabled" : ""}>${I("lock")}${t("设为私有", "Make private")}</button></div></div>${publicPlan.blocked.length ? `<p class="owned-ree-bulk-note">${t(publicPlan.blocked.length + " 个已下架 Ree 无法公开，批量公开时会跳过。", publicPlan.blocked.length + " taken-down Rees will be skipped when making public.")}</p>` : ""}`;
  }
  function paintSelection(result = synchronize(data())) {
    const host = document.querySelector("#owned-ree-bulk-host");
    if (host) host.innerHTML = selectionToolbar(result);
    const checked = result.items.filter(dot => selected.has(dot.id)).length;
    for (const input of document.querySelectorAll("[data-owned-ree-page-check]")) {
      input.checked = !!result.items.length && checked === result.items.length;
      input.indeterminate = checked > 0 && checked < result.items.length;
    }
    for (const input of document.querySelectorAll("[data-owned-ree-check]")) {
      input.checked = selected.has(input.dataset.ownedReeCheck);
      input.closest(".owned-ree-list-row")?.classList.toggle("is-selected", input.checked);
    }
  }
  function onChange(event) {
    if (route().path !== "/dots") return false;
    const target = event.target;
    if (!target.dataset || !("ownedReeCheck" in target.dataset || "ownedReePageCheck" in target.dataset)) return false;
    const result = synchronize(data());
    if (result.view.layout !== "list") return true;
    if ("ownedReePageCheck" in target.dataset) {
      for (const dot of result.items) target.checked ? selected.add(dot.id) : selected.delete(dot.id);
    } else if (result.items.some(dot => dot.id === target.dataset.ownedReeCheck)) {
      target.checked ? selected.add(target.dataset.ownedReeCheck) : selected.delete(target.dataset.ownedReeCheck);
    }
    paintSelection(result);
    if (target.isConnected === false && "ownedReePageCheck" in target.dataset)
      document.querySelector("#owned-ree-bulk-host [data-owned-ree-page-check]")?.focus({ preventScroll: true });
    return true;
  }
  function batchVisibility(visibility) {
    const result = synchronize(data());
    if (!["public", "private"].includes(visibility) || !ctx.getState().signed || ctx.getState().disabled || result.view.layout !== "list") return;
    const review = plan(result, visibility), count = review.changes.length;
    if (!count) return;
    const records = new Map(result.catalog.map(dot => [dot.id, dot]));
    const names = new Map(result.catalog.map(dot => [dot.id, title(dot)]));
    const kinds = new Map(review.changes.map(item => [item.id, !!records.get(item.id).ownedDemo]));
    const testCount = review.changes.filter(item => kinds.get(item.id)).length, realCount = count - testCount;
    const publicTarget = visibility === "public", scope = selectionScope, sample = result.view.sample;
    const label = publicTarget ? t("公开", "public") : t("私有", "private");
    const body = `<p>${t("已选 " + n(selected.size) + " 个 Ree，本次将更新 " + n(count) + " 个。", n(selected.size) + " Rees selected; " + n(count) + " will change.")}</p><p>${t("真实 Ree " + n(realCount) + " 个 · 测试 Ree " + n(testCount) + " 个", n(realCount) + " real Rees · " + n(testCount) + " test Rees")}</p><ul class="owned-ree-bulk-review">${review.changes.slice(0, 5).map(item => `<li>${esc(names.get(item.id))}${kinds.get(item.id) ? t("（测试）", " (Test)") : ""}</li>`).join("")}</ul>${count > 5 ? `<p>${t("其余 " + n(count - 5) + " 个所选 Ree 也会更新。", "The other " + n(count - 5) + " selected Rees will also change.")}</p>` : ""}${review.unchanged.length ? `<p>${t(n(review.unchanged.length) + " 个已是目标状态，不重复修改。", n(review.unchanged.length) + " already have the requested visibility.")}</p>` : ""}${review.blocked.length ? `<p>${t(n(review.blocked.length) + " 个已下架 Ree 将跳过，只有管理员可以恢复公开。", n(review.blocked.length) + " taken-down Rees will be skipped; only an administrator can restore them.")}</p>` : ""}${realCount ? `<p>${publicTarget ? t("真实 Ree 的更改将保存，其他用户将可以发现这些 Ree，并打开其公开页。", "Real Ree changes will be saved. Other users will be able to discover them and open their public pages.") : t("真实 Ree 的更改将保存，它们将从发现页隐藏，其他用户无法打开其公开页。知识与已有对话保留。", "Real Ree changes will be saved. They will leave discovery and their public pages will be unavailable to other users. Knowledge and existing chats are retained.")}</p>` : ""}${testCount ? `<p>${t("测试 Ree 的操作仅在当前页面会话生效，刷新后恢复，不写入真实 Ree 数据。", "Test Ree changes only affect this page session. Refresh resets them; they are never stored in your real Ree data.")}</p>` : ""}`;
    let used = false;
    confirmModal(t("将 " + n(count) + " 个 Ree 设为" + label + "？", "Make " + n(count) + " Rees " + label + "?"), body, publicTarget ? t("确认设为公开", "Confirm public") : t("确认设为私有", "Confirm private"), () => {
      if (used) return;
      used = true;
      const current = synchronize(data());
      if (!ctx.getState().signed || ctx.getState().disabled || route().path !== "/dots" || scopeKey(current.view) !== scope || current.view.sample !== sample) {
        toast(t("列表已变化，请重新选择 Ree。", "The list changed. Select your Rees again."));
        return;
      }
      const lookup = new Map(current.catalog.map(dot => [dot.id, dot]));
      const ids = review.changes.map(item => item.id).filter(id => selected.has(id) && lookup.has(id) && !!lookup.get(id).ownedDemo === kinds.get(id));
      const fresh = plan(current, visibility, ids);
      for (const item of fresh.changes) lookup.get(item.id).public = item.after;
      const realChanges = fresh.changes.filter(item => !lookup.get(item.id).ownedDemo).length;
      const testChanges = fresh.changes.length - realChanges;
      if (realChanges && save() === false) {
        for (const item of fresh.changes) {
          if (item.hadPublic) lookup.get(item.id).public = item.before;
          else delete lookup.get(item.id).public;
        }
        render();
        toast(t("保存失败，公开状态未更改，请重试。", "Save failed. Visibility was restored; please try again."));
        return;
      }
      const blocked = review.blocked.length + fresh.blocked.length;
      selected.clear();
      render();
      toast(t("已将 " + n(fresh.changes.length) + " 个 Ree 设为" + label + (blocked ? "，跳过 " + blocked + " 个已下架 Ree。" : "。") + (testChanges ? "其中 " + n(testChanges) + " 个测试 Ree 刷新后恢复。" : ""), fresh.changes.length + " Rees made " + label + (blocked ? "; skipped " + blocked + " taken-down Rees." : ".") + (testChanges ? " " + testChanges + " test Rees reset on refresh." : "")));
    });
  }
  function page() {
    const result = synchronize(data()), { view, catalog } = result, summary = workspaceSummary({ dots: catalog });
    const testCount = catalog.filter(dot => dot.ownedDemo).length, realCount = catalog.length - testCount;
    return `<div class="page owned-rees-page"><div class="page-head"><div><p class="eyebrow">YOUR KNOWLEDGE, BROUGHT TO LIFE</p><h1>${t("我的 Ree", "My Rees")}<span class="owned-ree-count mono">${n(catalog.length)}</span></h1><p>${t("给它一些知识，让它成为最了解你的伙伴。", "Give it some knowledge. Make it your most helpful companion.")}</p></div><div class="owned-ree-head-actions">${view.sample ? "" : btn(I("plus") + t("新建 Ree", "New Ree"), "create-dot")}</div></div>${testCount ? `<div class="discovery-scale-notice">${I("layers")}<span><strong>${t(n(testCount) + " 个测试 Ree" + (realCount ? " · 保留 " + n(realCount) + " 个原有 Ree" : ""), n(testCount) + " test Rees" + (realCount ? " · " + n(realCount) + " existing Rees retained" : ""))}</strong><br>${t("可直接测试卡片、列表、排序及批量公开／私有。测试 Ree 的修改刷新后恢复；原有 Ree 的修改正常保存。", "Test cards, lists, sorting, and batch visibility here. Test Ree changes reset on refresh; existing Ree changes are saved.")}</span></div>` : ""}<div class="metric-grid"><div class="card metric"><p>${t("知识来源", "Knowledge sources")}</p><div class="value">${n(summary.sources.total)}<small>${t("个来源", "sources")}</small></div><small>${t("文档、音频与更多可能", "Documents, audio, and more")}</small></div><div class="card metric"><p>${t("累计成功回答", "Successful answers")}</p><div class="value">${n(summary.answers)}<small>${t("次", "answers")}</small></div><small>${t("每一个好问题都有回声", "Every good question gets a voice")}</small></div><div class="card metric"><p>${t("已公开 Ree", "Public Rees")}</p><div class="value">${n(summary.publicDots)}<small>${t("个", "Rees")}</small></div><small>${t(summary.privateDots + " 个仅自己或已下架", summary.privateDots + " private or taken down")}</small></div></div>
      <div id="owned-ree-list-start" class="owned-ree-list-start"></div><section class="owned-ree-toolbar" id="owned-ree-results" aria-label="${t("搜索与筛选我的 Ree", "Search and filter my Rees")}"><div class="owned-ree-controls"><div class="filter-row" role="group" aria-label="${t("Ree 公开状态", "Ree visibility")}">${[["all", t("全部 Ree", "All Rees")], ["public", t("公开", "Public")], ["private", t("仅自己", "Private")]].map(([value, label]) => `<button class="filter ${view.visibility === value ? "active" : ""}" data-action="owned-ree-filter" data-value="${value}" aria-pressed="${view.visibility === value}">${label}</button>`).join("")}</div><form class="search-small" id="owned-ree-search">${I("search")}<input name="q" value="${esc(view.q)}" maxlength="4000" aria-label="${t("搜索我的 Ree", "Search my Rees")}" placeholder="${t("搜索名称、简介或标签…", "Search names, descriptions, or tags…")}"><button type="submit" aria-label="${t("搜索", "Search")}">${I("arrow")}</button></form><label class="discovery-select"><span>${t("每页", "Per page")}</span><select id="owned-ree-size" aria-label="${t("我的 Ree 每页数量", "My Rees per page")}">${OWNED_REE_PAGE_SIZES.map(size => `<option value="${size}" ${view.size === size ? "selected" : ""}>${size}</option>`).join("")}</select></label></div><div class="discovery-results-head"><p>${t("共", "Total")} <strong>${n(result.total)}</strong> ${t("个 Ree", "Rees")}${result.total ? ` · ${n(result.start)}–${n(result.end)}` : ""}${view.q ? ` · ${t("搜索", "Search")}: ${esc(view.q)}` : ""}</p><div class="owned-ree-results-tools">${sortControl(view)}${viewSwitcher(view)}${pager(result, true)}</div></div>${view.layout === "list" ? `<div id="owned-ree-bulk-host">${selectionToolbar(result)}</div>` : ""}</section>
      ${result.items.length ? (view.layout === "list" ? list(result.items, view) : `<div class="dot-grid">${result.items.map(ownedDotCard).join("")}</div>`) : `<section class="card empty owned-ree-empty">${I("dot")}<h2>${catalog.length ? t("没有匹配的 Ree", "No matching Rees") : t("从你的第一个 Ree 开始", "Start with your first Ree")}</h2><p>${catalog.length ? t("试试其他关键词，或清除筛选条件。", "Try another keyword or clear your filters.") : t("整理你的知识，让它开始回答。", "Give your knowledge a voice.")}</p>${catalog.length ? link(ownedReePath(route().query, { q: null, visibility: "all" }), t("清除筛选", "Clear filters"), 'class="btn secondary"') : btn(t("创建 Ree", "Create Ree"), "create-dot")}</section>`}<div class="discovery-results-footer"><span>${t("仅显示当前页的 Ree", "Showing only this page of Rees")}</span>${pager(result)}</div>${footer()}</div>`;
  }
  function onAction(action, dataset) {
    if (["owned-ree-selection-clear", "owned-ree-select-filtered", "owned-ree-bulk-visibility"].includes(action)) {
      const result = synchronize(data());
      if (result.view.layout !== "list") return true;
      if (action === "owned-ree-selection-clear") selected.clear();
      if (action === "owned-ree-select-filtered") for (const dot of result.matches) selected.add(dot.id);
      if (action === "owned-ree-bulk-visibility") batchVisibility(dataset.value);
      else paintSelection(result);
      return true;
    }
    if (action === "owned-ree-sort") {
      if (!["name", "sources", "answers"].includes(dataset.value)) return true;
      const view = data().view, key = dataset.value;
      const order = view.sort === key ? (view.order === "asc" ? "desc" : "asc") : key === "name" ? "asc" : "desc";
      applySort(key, order, key);
      return true;
    }
    if (action === "owned-ree-view") {
      if (!["cards", "list"].includes(dataset.value)) return true;
      scrollToResults = true;
      focusView = true;
      go(ownedReePath(route().query, { view: dataset.value === "list" ? "list" : null }));
      return true;
    }
    if (action === "owned-ree-filter") { scrollToResults = true; go(ownedReePath(route().query, { visibility: dataset.value })); return true; }
    if (action !== "owned-ree-preview") return false;
    const row = data().catalog.find(dot => dot.id === dataset.id && dot.ownedDemo);
    if (!row) return true;
    modal(esc(title(row)), t("测试 Ree · 只读预览", "Test Ree · Read-only preview"), `<div class="owned-ree-preview"><p>${esc(desc(row))}</p><p>${t("知识来源", "Knowledge sources")}: ${n(row.knowledge.length)} · ${t("累计成功回答", "Successful answers")}: ${n(row.answers)}</p><p>${t("测试 Ree 支持列表中的批量公开／私有操作。知识编辑、视频和对话功能请使用原有 Ree。", "Test Rees support batch visibility in the list. Use your existing Rees to edit knowledge, manage videos, and chat.")}</p></div>`, btn(t("关闭", "Close"), "close-modal"));
    return true;
  }
  function onSubmit(form, fields) {
    if (form.id === "owned-ree-search") { scrollToResults = true; go(ownedReePath(route().query, { q: String(fields.get("q") || "").trim() })); return true; }
    if (form.id !== "owned-ree-jump") return false;
    const result = data(), page = Math.min(result.pages, Math.max(1, Math.floor(Number(fields.get("page"))) || 1));
    scrollToResults = true;
    go(ownedReePath(route().query, { page }));
    return true;
  }
  function afterRender() {
    if (route().path !== "/dots") { scrollToResults = false; focusView = false; focusSort = ""; selected.clear(); selectionScope = ""; return; }
    const result = synchronize(data()), query = route().query;
    if (result.view.layout === "list") paintSelection(result);
    if (query.has("page") && Number(query.get("page")) !== result.view.page)
      history.replaceState(null, "", "#" + ownedReePath(query, { page: result.view.page }));
    if (scrollToResults || result.view.page > 1) requestAnimationFrame(() => document.querySelector("#owned-ree-list-start")?.scrollIntoView({ block: "start", behavior: "instant" }));
    if (focusView) requestAnimationFrame(() => document.querySelector(`[data-action="owned-ree-view"][data-value="${result.view.layout}"]`)?.focus({ preventScroll: true }));
    if (focusSort) {
      const selector = focusSort === "select" ? "#owned-ree-sort" : `[data-action="owned-ree-sort"][data-value="${focusSort}"]`;
      requestAnimationFrame(() => document.querySelector(selector)?.focus({ preventScroll: true }));
    }
    scrollToResults = false;
    focusView = false;
    focusSort = "";
  }
  document.addEventListener("change", event => {
    if (onChange(event)) return;
    if (event.target.id === "owned-ree-sort") {
      const [sort, order] = event.target.value.split(":");
      applySort(sort, order, "select");
    }
    if (event.target.id === "owned-ree-size") {
      scrollToResults = true;
      go(ownedReePath(route().query, { size: event.target.value }));
    }
  });
  document.addEventListener("click", event => {
    if (event.target.closest(".owned-rees-page .discovery-pagination a")) scrollToResults = true;
  });
  return { page, catalog, onAction, onSubmit, onChange, afterRender };
}
