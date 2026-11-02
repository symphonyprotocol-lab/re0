import { adminReePath, adminReeDemoRows } from "./admin-ree.js";
import { sourceSummary } from "./workspace.js";

const tabs = [["overview", "资料概览", "Overview"], ["sources", "知识来源", "Sources"], ["statistics", "使用统计", "Usage statistics"], ["audit", "管理记录", "Management log"]];
const positivePage = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.min(100000, Math.floor(Number(value))) : 1;
export function adminReeBackPath(value) {
  if (typeof value === "string" && /^\/admin\/dots(?:\?|$)/.test(value))
    return adminReePath(new URLSearchParams(value.split("?")[1]));
  const user = typeof value === "string" && /^\/admin\/users\/([a-zA-Z0-9-]+)\?tab=dots$/.exec(value);
  return user ? `/admin/users/${user[1]}?tab=dots` : "/admin/dots";
}
export function adminReeDetailPath(dot, from = "", tab = "overview", changes = {}) {
  const query = new URLSearchParams({ from: adminReeBackPath(from, dot.adminDemo) });
  if (tabs.some(([id]) => id === tab) && tab !== "overview") query.set("tab", tab);
  if (tab === "sources") {
    if (changes.sourceQ) query.set("sourceQ", String(changes.sourceQ).trim().slice(0, 400));
    if (["ready", "processing", "failed", "paused"].includes(changes.sourceStatus)) query.set("sourceStatus", changes.sourceStatus);
    if (positivePage(changes.sourcePage) > 1) query.set("sourcePage", positivePage(changes.sourcePage));
  }
  return `/admin/dots/${encodeURIComponent(dot.id)}?${query}`;
}
export function adminReeSourcePath(dot, source, from = "", filters = {}, preview = {}) {
  const query = new URLSearchParams(adminReeDetailPath(dot, from, "sources", filters).split("?")[1]);
  for (const key of ["contentQ", "childQ"]) if (preview[key]) query.set(key, String(preview[key]).trim().slice(0, 200));
  for (const key of ["child", "childPage"]) {
    const value = Number(preview[key]);
    if (Number.isFinite(value) && value >= (key === "child" ? 1 : 2)) query.set(key, Math.min(100000, Math.floor(value)));
  }
  return `/admin/dots/${encodeURIComponent(dot.id)}/sources/${encodeURIComponent(source.id)}?${query}`;
}
export function findAdminRee(rows, id) {
  const real = rows.find(row => row.id === id);
  if (real) return real;
  if (!/^admin-ree-scale-\d{4}$/.test(id || "")) return undefined;
  return adminReeDemoRows().find(row => row.id === id);
}
export function filteredAdminReeSources(dot, query) {
  const q = (query.get("sourceQ") || "").trim().slice(0, 400), requested = query.get("sourceStatus");
  const status = ["ready", "processing", "failed", "paused"].includes(requested) ? requested : "all";
  const sourceState = source => source.enabled === false ? "paused" : ["ready", "failed"].includes(source.status) ? source.status : "processing";
  const rows = (dot.knowledge || []).filter(source =>
    (!q || String(source.title || "").toLocaleLowerCase().includes(q.toLocaleLowerCase())) &&
    (status === "all" || sourceState(source) === status));
  return { q, status, rows, sourceState };
}
export function adminReeSources(dot, query) {
  const { q, status, rows, sourceState } = filteredAdminReeSources(dot, query);
  const total = rows.length, pages = Math.max(1, Math.ceil(total / 20)), page = Math.min(positivePage(query.get("sourcePage")), pages);
  return { q, status, total, page, pages, items: rows.slice((page - 1) * 20, page * 20), sourceState };
}

export function createAdminReeDetail(ctx) {
  const { t, I, esc, n, title, desc, avatar, btn, route, go } = ctx;
  const S = ctx.getState;
  const link = (path, label, cls = "text-link") => `<a href="#${esc(path)}" class="${cls}">${label}</a>`;
  const record = id => S().admin ? findAdminRee(S().dots || [], id) : undefined;
  const statusLabel = dot => dot.moderated ? t("已下架", "Taken down") : dot.public ? t("公开", "Public") : t("私有", "Private");
  const statusBadge = dot => `<span class="tag ${dot.moderated ? "orange" : dot.public ? "blue" : ""}">${statusLabel(dot)}</span>`;
  const activeTab = () => tabs.some(([id]) => id === route().query.get("tab")) ? route().query.get("tab") : "overview";
  const backPath = dot => adminReeBackPath(route().query.get("from"), dot?.adminDemo);
  const path = (dot, tab, changes) => adminReeDetailPath(dot, backPath(dot), tab, changes);
  const field = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  function navigation(id) {
    const dot = record(id);
    return dot ? `<nav class="admin-ree-detail-nav admin-ree-inline-tabs" aria-label="${t("Ree 详情导航", "Ree detail navigation")}">${tabs.map(([key,zh,en])=>`<a href="#${esc(path(dot,key))}" ${activeTab() === key ? 'class="active" aria-current="page"' : ""}>${t(zh,en)}</a>`).join("")}</nav>` : "";
  }
  function overview(dot) {
    const sources = sourceSummary(dot.knowledge || []), owner = dot.adminDemo ? { name:dot.owner, email:dot.ownerEmail } : ctx.owner(dot);
    return `<div class="admin-ree-detail-grid"><div><section class="card admin-ree-section"><h2>${t("基本资料", "Identity")}</h2><dl class="admin-ree-fields">${field("ID", `<code>${esc(dot.id)}</code>`)}${field(t("公开标识", "Public slug"), esc(dot.slug || "—"))}${field(t("主分类", "Category"), esc(ctx.categoryLabel(dot)))}${field(t("分类标签", "Tags"), (dot.tags || []).map(tag=>`<span class="tag">${esc(tag)}</span>`).join(" ") || "—")}${field(t("视频介绍", "Introduction video"), dot.video?.generated ? t("已制作", "Available") : t("未制作", "Not created"))}${field(t("创建时间", "Created"), esc(dot.createdAt ? new Date(dot.createdAt).toLocaleString(S().lang === "zh" ? "zh-CN" : "en-GB") : t("未记录", "Not recorded")))}</dl></section>
    <section class="card admin-ree-section"><h2>${t("回答方式与人设", "Answer style & personality")}</h2><p class="admin-ree-pre">${esc(dot.prompt || t("未单独设置，使用默认回答方式。", "Default answer style; no custom instructions."))}</p><h3>${t("示例问题", "Sample questions")}</h3>${(dot.samples || []).length ? `<ol class="admin-ree-samples">${dot.samples.map(sample=>`<li>${esc(sample)}</li>`).join("")}</ol>` : `<p class="muted small">${t("暂无示例问题", "No sample questions")}</p>`}</section></div>
    <aside><section class="card admin-ree-section"><h2>${t("所有者", "Owner")}</h2><strong>${esc(owner?.name || dot.owner)}</strong><p class="muted small">${esc(owner?.email || "—")}</p>${!dot.adminDemo && owner ? link("/admin/users/" + encodeURIComponent(owner.id), t("查看用户资料", "View user") + I("arrow")) : ""}</section>
    <section class="card admin-ree-section"><h2>${t("知识就绪情况", "Knowledge readiness")}</h2><div class="admin-ree-source-summary">${[["ready",t("已就绪","Ready")],["processing",t("处理中","Processing")],["failed",t("失败","Failed")],["paused",t("已停用","Paused")]].map(([key,label])=>link(path(dot,"sources",{sourceStatus:key}), `<span>${label}</span><strong>${n(sources[key])}</strong>`, "admin-ree-source-count")).join("")}</div></section>
    </aside></div>`;
  }
  function sources(dot) {
    const data = adminReeSources(dot, route().query);
    const states = { ready:t("已就绪","Ready"), processing:t("处理中","Processing"), failed:t("失败","Failed"), paused:t("已停用","Paused") };
    const pagePath = page => path(dot,"sources",{sourceQ:data.q,sourceStatus:data.status,sourcePage:page});
    return `<section class="card admin-ree-source-table"><form class="admin-ree-filter" id="admin-ree-source-filter" data-id="${esc(dot.id)}"><div class="search-small">${I("search")}<input name="sourceQ" aria-label="${t("搜索知识来源", "Search sources")}" placeholder="${t("搜索来源名称…", "Search source titles…")}" maxlength="400" value="${esc(data.q)}"></div><select name="sourceStatus" aria-label="${t("知识状态筛选", "Filter source status")}"><option value="all">${t("全部状态","All statuses")}</option>${Object.entries(states).map(([key,label])=>`<option value="${key}" ${key === data.status ? "selected" : ""}>${label}</option>`).join("")}</select><button class="btn secondary sm" type="submit">${t("筛选","Filter")}</button>${data.q || data.status !== "all" ? link(path(dot,"sources"),t("重置","Reset")) : ""}</form><div class="admin-ree-results">${t("共","")} <strong>${n(data.total)}</strong> ${t("个来源 · 每页 20 条","sources · 20 per page")}</div>${ctx.renderTable([t("来源名称","Source title"),t("类型","Type"),t("状态","Status")],data.items.map(source=>[link(adminReeSourcePath(dot,source,backPath(dot),{sourceQ:data.q,sourceStatus:data.status,sourcePage:data.page}),`${I("file")}<span>${esc(source.title)}</span>${I("external")}`,"admin-ree-source-link"),esc(ctx.kindLabel(source.kind)),`<span class="tag ${data.sourceState(source) === "ready" ? "green" : data.sourceState(source) === "failed" ? "red" : ""}">${states[data.sourceState(source)]}</span>`]))}<div class="admin-ree-pagination"><span>${t("第","Page")} ${data.page} / ${data.pages} ${t("页","")}</span><div class="flex">${data.page > 1 ? link(pagePath(data.page-1),t("上一页","Previous page"),"btn secondary sm") : `<button class="btn secondary sm" disabled>${t("上一页","Previous page")}</button>`}${data.page < data.pages ? link(pagePath(data.page+1),t("下一页","Next page"),"btn secondary sm") : `<button class="btn secondary sm" disabled>${t("下一页","Next page")}</button>`}</div></div></section>`;
  }
  function page(id) {
    const dot = record(id);
    if (!dot) return `<section class="card empty"><h1>${t("Ree 不存在或已删除", "Ree not found")}</h1>${link(backPath(), t("返回 Ree 列表", "Back to Rees"), "btn secondary mt16")}</section>`;
    const summary = sourceSummary(dot.knowledge || []), audits = dot.adminDemo ? [] : (S().console?.audits || []).filter(row=>row.target === dot.id);
    const tab = activeTab();
    if (tab === "statistics") return ctx.statisticsPage(dot, route().query);
    const fee = Math.max(0, Math.min(10000, Number(dot.fee) || 0));
    const pricing = `<article class="card admin-ree-fee-metric" title="${t("未作答不收费；所有者本人提问仅收 20 credits 平台基本费。", "No answer, no charge. Owners pay only the 20-credit platform fee.")}"><span>${t("成功回答计费", "Price per successful answer")}</span><strong>${n(20+fee)}<em>credits / ${t("次", "answer")}</em></strong><small>${t(`平台 ${n(20)} + 创作者 ${n(fee)}`,`Platform ${n(20)} + creator ${n(fee)}`)}<br>${t("未作答不收费 · 本人提问仅收基本费", "No answer, no charge · Owners pay base fee only")}</small></article>`;
    const actions = dot.adminDemo ? `<span class="tag blue">${t("只读示例", "Read-only sample")}</span>` : `${dot.public && !dot.moderated ? link("/d/" + encodeURIComponent(dot.slug), I("external") + t("公开页", "Public page"), "btn secondary sm") : ""}${dot.public || dot.moderated ? btn(dot.moderated ? t("恢复公开", "Restore visibility") : t("下架 Ree", "Take down Ree"), "moderate-dot", "secondary sm", `data-id="${esc(dot.id)}"`) : ""}`;
    return `<div class="admin-ree-detail"><header class="admin-ree-detail-head"><div class="flex">${avatar(dot)}<div><div class="flex"><h1>${esc(title(dot))}</h1>${statusBadge(dot)}</div><p>${esc(desc(dot))}</p></div></div><div class="flex admin-ree-detail-actions">${actions}</div></header><div class="admin-ree-detail-metrics">${[[t("累计成功回答","Successful answers"),n(Math.max(0,Number(dot.answers)||0)),t("累计演示数据","Cumulative demo data")],[t("知识来源","Sources"),n(summary.total),t("不含回收站","Excludes trash")],[t("已就绪来源","Ready sources"),n(summary.ready),t("已启用且处理完成","Enabled and processed")]].map(([label,value,note])=>`<article class="card"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join("")}${pricing}</div>${tab === "sources" ? sources(dot) : tab === "audit" ? `<section class="card"><div class="admin-ree-section admin-ree-audit-head"><h2>${t("管理记录", "Management log")}</h2><p class="muted small">${t("仅展示这个 Ree 的管理操作。", "Management actions for this Ree only.")}</p></div>${ctx.auditTable(audits)}</section>` : overview(dot)}</div>`;
  }
  function onSubmit(form, data) {
    if (form.id !== "admin-ree-source-filter") return false;
    const dot = record(form.dataset.id);
    if (dot) go(path(dot,"sources",{sourceQ:data.get("sourceQ"),sourceStatus:data.get("sourceStatus")}));
    else go("/admin/login");
    return true;
  }
  return { page, record, navigation, backPath, onSubmit };
}
