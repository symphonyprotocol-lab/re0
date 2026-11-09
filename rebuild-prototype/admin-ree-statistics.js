import { createDotStatistics, statisticsForRee } from "./dot-statistics.js";
import { adminReeBackPath, adminReeDetailPath, findAdminRee } from "./admin-ree-detail.js";

// The admin session authorizes the broader Ree scope; the user loader stays owner-only.
export function adminReeStatistics(state, id) {
  if (!state.admin) return null;
  const dot = findAdminRee(state.dots || [], id);
  if (!dot) return null;
  if (dot.adminDemo) return statisticsForRee({entries:[],chats:[],dotMessages:{}}, dot);
  const seen = new Set();
  const entries = [...(state.entries || []), ...(state.console?.users || []).flatMap(user => user.entries || [])].filter(entry => {
    if (!entry.id) return true;
    const key = entry.type + ":" + entry.id;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return statisticsForRee({...state, entries}, dot);
}

export function createAdminReeStatistics(ctx) {
  const origin = dot => adminReeBackPath(ctx.route().query.get("from"), dot?.adminDemo);
  const detailPath = (id, params) => {
    const dot = ctx.reeRecord(id);
    if (!dot) return "/admin/dots";
    const base = adminReeDetailPath(dot, origin(dot), "statistics");
    const query = new URLSearchParams(base.split("?")[1]);
    for (const [key,value] of params) query.set(key,value);
    return base.split("?")[0] + "?" + query;
  };
  const shared = createDotStatistics(ctx, {
    load: adminReeStatistics,
    allowOfficialIncome: true,
    formScope: "admin-ree-statistics",
    shell: html => html,
    footer: () => "",
    pageClass: "admin-ree-statistics",
    path: detailPath,
    sourcesPath: id => {
      const dot = ctx.reeRecord(id);
      return dot ? adminReeDetailPath(dot, origin(dot), "sources", {sourceStatus:"ready"}) : "/admin/dots";
    },
  });
  return {
    page(dot,query) {
      const data = adminReeStatistics(ctx.getState(),dot.id);
      return data ? shared.page(data,query) : "";
    },
    onSubmit: shared.onSubmit,
  };
}
