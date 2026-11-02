import { discoveryDemoDots, discoveryPageNumbers } from "./discovery.js";

const PAGE_SIZES = [20, 50, 100];
export function adminReeView(query) {
  const status = { active: "public", disabled: "moderated" }[query.get("status")] || query.get("status");
  const page = Number(query.get("page"));
  return {
    q: (query.get("q") || "").trim().slice(0, 400),
    status: ["public", "private", "moderated"].includes(status) ? status : "all",
    size: PAGE_SIZES.includes(Number(query.get("size"))) ? Number(query.get("size")) : 20,
    page: Number.isFinite(page) && page > 0 ? Math.min(100000, Math.floor(page)) : 1,
  };
}
export function adminReePath(query, changes = {}) {
  const next = new URLSearchParams(query);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === "" || value === "all") next.delete(key);
    else next.set(key, String(value));
  }
  if (["q", "status", "size"].some(key => key in changes)) next.delete("page");
  const view = adminReeView(next), result = new URLSearchParams();
  if (view.q) result.set("q", view.q);
  if (view.status !== "all") result.set("status", view.status);
  if (view.size !== 20) result.set("size", view.size);
  if (view.page > 1) result.set("page", view.page);
  return "/admin/dots" + (result.size ? "?" + result : "");
}
let demoRows;
export function adminReeDemoRows() {
  return demoRows ??= discoveryDemoDots().map((dot, index) => ({
    ...dot, id: "admin-ree-scale-" + String(index + 1).padStart(4, "0"),
    slug: "ree-scale-" + String(index + 1).padStart(4, "0"),
    adminDemo: true, public: index % 5 > 1, moderated: index % 5 === 1,
    ownerEmail: `creator${index % 83 + 1}@example.com`,
  }));
}
export function selectAdminRees(realRows, query, ownerText = () => "") {
  const view = adminReeView(query);
  const catalog = realRows;
  const q = view.q.toLocaleLowerCase();
  const rows = catalog.filter(dot => {
    const status = dot.moderated ? "moderated" : dot.public ? "public" : "private";
    return (view.status === "all" || view.status === status) && (!q ||
      [dot.id, dot.name, dot.enName, dot.slug, dot.owner, dot.ownerEmail, ownerText(dot)]
        .join(" ").toLocaleLowerCase().includes(q));
  });
  const total = rows.length, pages = Math.max(1, Math.ceil(total / view.size));
  view.page = Math.min(view.page, pages);
  const offset = (view.page - 1) * view.size;
  return { view, total, pages, start: total ? offset + 1 : 0, end: Math.min(offset + view.size, total), items: rows.slice(offset, offset + view.size) };
}

export function createAdminRees(ctx) {
  const { t, I, esc, n, route, go, table, sectionHead, ownerText } = ctx;
  let observer, resize;
  const link = (path, label, attrs = "") => `<a href="#${esc(path)}" ${attrs}>${label}</a>`;
  function pager(data) {
    const { view, pages } = data;
    const pageLink = (page, label, name) => page < 1 || page > pages
      ? `<span class="is-disabled" aria-disabled="true">${label}</span>`
      : link(adminReePath(route().query, { page }), label, `aria-label="${name}"`);
    return `<div class="admin-ree-pagination"><span>${t("第", "Page")} ${view.page} / ${pages} ${t("页", "")}</span><nav class="admin-ree-pages" aria-label="${t("Ree 管理分页", "Ree management pagination")}">${pageLink(view.page - 1, I("chevron"), t("上一页", "Previous page"))}${discoveryPageNumbers(view.page, pages).map(page => page === null ? '<span class="pagination-ellipsis">…</span>' : page === view.page ? `<span class="is-current" aria-current="page">${page}</span>` : pageLink(page, page, t("第 ", "Page ") + page + t(" 页", ""))).join("")}${pageLink(view.page + 1, I("chevron"), t("下一页", "Next page"))}</nav><form id="admin-ree-page-jump"><label for="admin-ree-page-number">${t("跳至", "Go to")}</label><input id="admin-ree-page-number" aria-label="${t("跳转页码", "Page number")}" name="page" type="number" min="1" max="${pages}" value="${view.page}" required ${pages === 1 ? "disabled" : ""}><button class="btn secondary sm" type="submit" ${pages === 1 ? "disabled" : ""}>${t("跳转", "Go")}</button></form></div>`;
  }
  function page() {
    const query = route().query, data = selectAdminRees(adminReeDemoRows(), query, ownerText), { view } = data;
    const canonical = adminReePath(query, { page: view.page });
    if (query.toString() !== canonical.split("?")[1] && (query.size || canonical.includes("?")))
      history.replaceState(null, "", "#" + canonical);
    return `<div class="admin-ree-page">${sectionHead(t("Ree 管理", "Rees management"), t("维护公开内容；下架会转为私有并通知所有者。", "Manage public visibility. Takedowns make the Ree private and notify its owner."))}
      <section class="card admin-ree-table"><form class="admin-ree-filter" id="admin-ree-filter"><div class="search-small">${I("search")}<input name="q" aria-label="${t("搜索 Ree", "Search Rees")}" placeholder="${t("搜索名称、所有者、邮箱或编号…", "Search name, owner, email or ID…")}" value="${esc(view.q)}" maxlength="400"></div><label><span>${t("状态", "Visibility")}</span><select name="status" aria-label="${t("状态筛选", "Filter by visibility")}">${[["all",t("全部状态","All statuses")],["public",t("公开","Public")],["private",t("私有","Private")],["moderated",t("已下架","Taken down")]].map(([value,label])=>`<option value="${value}" ${view.status === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><button class="btn secondary sm" type="submit">${t("搜索", "Search")}</button>${view.q || view.status !== "all" ? link(adminReePath(query, {q:null,status:"all"}), t("重置","Reset"), 'class="text-link admin-ree-reset"') : ""}<label class="admin-ree-size"><span>${t("每页", "Per page")}</span><select name="size" aria-label="${t("每页条数", "Rees per page")}">${PAGE_SIZES.map(size=>`<option value="${size}" ${view.size === size ? "selected" : ""}>${size} ${t("条","rows")}</option>`).join("")}</select></label></form>
      <div class="admin-ree-results" role="status" aria-live="polite">${t("共", "")} <strong>${n(data.total)}</strong> ${t("个 Ree", "Rees")}<span> · ${t("显示", "Showing")} ${n(data.start)}–${n(data.end)}</span></div>${table(data.items)}${pager(data)}</section></div>`;
  }
  function afterRender() {
    observer?.disconnect();
    if (resize) window.removeEventListener("resize", resize);
    const form = document.querySelector("#admin-ree-filter");
    if (!form) return;
    for (const select of form.querySelectorAll("select")) select.addEventListener("change", () => apply(new FormData(form)));
    const root = document.querySelector(".admin-ree-page"), wrap = root.querySelector(".table-wrap");
    wrap.setAttribute("tabindex", "0");
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", t("Ree 数据表，可滚动查看更多", "Ree table, scroll for more rows"));
    resize = () => {
      if (!root.isConnected) return;
      const top = wrap.getBoundingClientRect().top + window.scrollY;
      const footer = root.querySelector(".admin-ree-pagination").getBoundingClientRect().height;
      root.style.setProperty("--admin-ree-table-height", Math.max(180, Math.min(760, window.innerHeight - top - footer - 24)) + "px");
    };
    observer = new ResizeObserver(resize);
    observer.observe(form);
    observer.observe(root.querySelector(".page-head"));
    window.addEventListener("resize", resize);
    requestAnimationFrame(resize);
  }
  function apply(formData) {
    go(adminReePath(route().query, { q: formData.get("q"), status: formData.get("status"), size: formData.get("size") }));
  }
  function onSubmit(form, data) {
    if (!["admin-ree-filter", "admin-ree-page-jump"].includes(form.id)) return false;
    if (!ctx.getState().admin) { go("/admin/login"); return true; }
    if (form.id === "admin-ree-filter") apply(data);
    else go(adminReePath(route().query, { page: data.get("page") }));
    return true;
  }
  return { page, afterRender, onSubmit };
}
