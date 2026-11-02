import { hasPublicVideoIntroduction, renderVideoPlaceholder } from "./discovery-video.js";
import { dotCategory } from "./dot-classification.js";
import { discoveryPath, discoveryDemoDot, discoveryDemoDots, discoveryTestCatalog } from "./discovery.js";
import { PUBLIC_REE_PAGE_SIZE, selectPublicReeRecommendations } from "./public-ree-recommendations.js";

// Keep list context in the detail URL so return navigation survives refresh/sign-in.
export function discoveryReturnPath(value = "") {
  if (value !== "/explore" && !value.startsWith("/explore?")) return "/explore";
  return discoveryPath(new URLSearchParams(value.split("?").slice(1).join("?")));
}
export const isPublicDot = (dot) => !!dot?.public && !dot.moderated;
export function resolvePublicDot(slug, realDots, ownedDots = []) {
  const dot = realDots.find(dot => dot.slug === slug) ||
    ownedDots.find(dot => dot.slug === slug) || discoveryDemoDot(slug);
  return isPublicDot(dot) ? dot : undefined;
}
export function publicDotFacts(dot) {
  const sources = (dot.knowledge || []).filter(
    (source) => source.status === "ready" && source.enabled !== false,
  );
  const queryFee = Math.min(
    10000,
    Math.max(0, Math.floor(Number(dot.fee) || 0)),
  );
  const answers = Number(dot.answers);
  const rating = (typeof dot.rating === "number" || typeof dot.rating === "string") && String(dot.rating).trim() !== "" ? Number(dot.rating) : NaN;
  return {
    sourceCount: sources.length,
    answers: Number.isFinite(answers) ? Math.max(0, answers) : 0,
    positiveRate: Number.isFinite(rating) && rating >= 0 && rating <= 100 &&
      (rating > 0 || Number(dot.ratingCount) > 0) ? rating : null,
    queryFee,
    price: 20 + queryFee,
  };
}
export function createPublicDot(ctx) {
  const { t, I, esc, n, title, desc, avatar } = ctx;
  const S = ctx.getState;
  const authorName = dot => dot.owner === "me" ? S().displayName || "Yu Zhao" : dot.owner || t("知识创作者", "Knowledge creator");
  function recommendationCatalog() {
    if (ctx.getPublicCatalog) return ctx.getPublicCatalog();
    const sample = new URLSearchParams(returnPath().split("?")[1] || "").get("sample") === "scale";
    return sample ? discoveryDemoDots() : discoveryTestCatalog(S().dots || [], ctx.getOwnedRees?.());
  }
  function recommendationPages(dot) {
    const ui = ctx.getUi();
    ui.publicReePages ||= Object.create(null);
    if (!Object.hasOwn(ui.publicReePages, dot.slug)) ui.publicReePages[dot.slug] = {};
    return ui.publicReePages[dot.slug];
  }
  function recommendationRow(dot) {
    const facts = publicDotFacts(dot);
    return `<li>${ctx.discoveryCover(dot)}<a class="public-ree-link" href="#${esc(path(dot))}"><div class="public-ree-copy"><strong>${esc(title(dot))}</strong><p>${esc(desc(dot))}</p><div class="public-ree-meta"><span>${esc(authorName(dot))}</span><span>${n(facts.answers)} ${t("次成功回答", "successful answers")}</span><span>${facts.positiveRate === null ? t("暂无评价", "No ratings yet") : n(facts.positiveRate) + "% " + t("好评率", "positive ratings")}</span></div></div>${I("arrow")}</a></li>`;
  }
  function recommendationGroup(dot, kind, result) {
    const related = kind === "related";
    const heading = related ? t("相关 Rees", "Related Rees") : t("作者的其他 Rees", "More Rees by this creator");
    const button = (page, icon, label) => `<button type="button" data-action="public-ree-page" data-kind="${kind}" data-page="${page}" aria-label="${label}" ${page < 1 || page > result.pages ? "disabled" : ""}>${I(icon)}</button>`;
    return `<section class="card public-ree-group" data-ree-group="${kind}" aria-labelledby="public-ree-${kind}-heading"><header><div><h2 id="public-ree-${kind}-heading">${I(related ? "compass" : "users")}${heading}</h2><p>${related ? t("探索相近的主题与知识领域。", "Explore similar topics and knowledge.") : esc(authorName(dot)) + t(" 创作的其他公开 Ree。", "’s other public Rees.")}</p></div><span>${n(result.total)} ${t("个", "Rees")}</span></header>${result.total ? `<ul class="public-ree-list">${result.items.map(recommendationRow).join("")}</ul>` : `<p class="public-ree-empty">${related ? t("暂时没有找到内容相近的公开 Ree。", "No related public Rees yet.") : t("作者暂无其他公开 Ree。", "This creator has no other public Rees yet.")}</p>`}${result.pages > 1 ? `<nav class="public-ree-pagination" aria-label="${heading + t("分页", " pagination")}"><span>${n((result.page - 1) * PUBLIC_REE_PAGE_SIZE + 1)}–${n(Math.min(result.page * PUBLIC_REE_PAGE_SIZE, result.total))} / ${n(result.total)}</span><div>${button(result.page - 1, "chevron", heading + t("上一页", " previous page"))}<span>${result.page} / ${result.pages}</span>${button(result.page + 1, "chevron", heading + t("下一页", " next page"))}</div></nav>` : ""}</section>`;
  }
  function recommendations(dot) {
    const result = selectPublicReeRecommendations(dot, recommendationCatalog(), recommendationPages(dot));
    return `<div class="public-ree-recommendations">${recommendationGroup(dot, "related", result.related)}${recommendationGroup(dot, "author", result.author)}</div>`;
  }
  function overview(dot) {
    const owner = dot.owner === "me" ? S().displayName || "Yu Zhao" : dot.owner;
    const category = ctx.classification.categoryLabel(dot);
    const tags = [...new Set(dot.tags || [])].filter((tag) => tag !== category);
    return `<section class="card public-dot-overview" aria-label="${t("Ree 详细信息", "About this Ree")}">
      <header class="public-dot-intro">
        <div class="public-dot-heading">${avatar(dot)}<div><span class="public-dot-eyebrow">MEET YOUR KNOWLEDGE COMPANION</span><h1>${esc(title(dot))}</h1></div></div>
        <p class="public-dot-description">${esc(desc(dot))}</p>
        <div class="public-dot-tags"><a href="#/explore?category=${encodeURIComponent(dotCategory(dot))}">${esc(category)}</a>${tags.map((tag) => `<a href="#/explore?q=${encodeURIComponent(tag)}">${esc(tag)}</a>`).join("")}</div>
        <div class="public-dot-byline"><span>${t("由", "By")} <strong>${esc(owner)}</strong> ${ctx.userRoles?.badgeForRee(dot)||""} ${t("创建", "")}</span><span>${I("globe")}${t("公开 Ree", "Public Ree")}</span></div>
      </header>
      <section class="public-dot-section"><h2>${I("film")}${t("视频介绍", "Video introduction")}</h2>${hasPublicVideoIntroduction(dot) ? ctx.inlineVideo(dot) : renderVideoPlaceholder(dot, ctx)}</section>
      ${dot.samples?.length ? `<section class="public-dot-section"><h2>${I("chat")}${t("你可以和它聊这些", "What you can discuss")}</h2><ol class="public-dot-topics">${dot.samples.slice(0, 6).map((question, index) => `<li><span>${String(index + 1).padStart(2, "0")}</span><p>${esc(question)}</p></li>`).join("")}</ol></section>` : ""}
    </section>`;
  }
  function summary(dot, facts) {
    const ready = facts.sourceCount > 0;
    return `<aside class="card public-dot-summary" aria-label="${t("使用信息", "Usage information")}">
      <div class="public-dot-summary-title"><h2>${t("使用这个 Ree", "Use this Ree")}</h2><span class="public-dot-status ${ready ? "is-ready" : ""}"><i></i>${ready ? t("已就绪", "Ready") : t("知识准备中", "Preparing knowledge")}</span></div>
      <div class="public-dot-stats">
        <span><span>${t("累计成功回答", "Successful answers, all time")}</span><strong>${n(facts.answers)}</strong></span>
        <span class="public-dot-source-total"><span>${t("知识来源", "Knowledge sources")}</span><strong>${n(facts.sourceCount)}</strong></span>
        <span><span>${t("好评率", "Positive ratings")}</span>${facts.positiveRate === null ? `<small class="public-dot-no-rating">${t("暂无评价", "No ratings yet")}</small>` : `<strong>${n(facts.positiveRate)}<small>%</small></strong>`}</span>
      </div>
      <small class="public-dot-demo">${t("原型演示数据", "Prototype demo data")}</small>
      <section class="public-dot-pricing" aria-label="${t("回答费用", "Answer pricing")}"><h3>${t("每次成功回答", "Per successful answer")}</h3><div class="public-dot-price"><strong>${n(facts.price)}</strong><span>credits</span></div><dl><div><dt>${t("基本使用费", "Base fee")}</dt><dd>20</dd></div><div><dt>${t("创作者查询费", "Creator query fee")}</dt><dd>${n(facts.queryFee)}</dd></div></dl><p>${t("仅成功作答收费，未作答不收费。", "Only successful answers are charged.")}</p>${S().signed && dot.owner === "me" ? `<p>${t("你是这个 Ree 的创作者，自己的提问仅收取 20 credits 基本使用费。", "As the creator, your own questions cost only the 20-credit base fee.")}</p>` : ""}</section>
      <div class="public-dot-trust">${I("shield")}<p>${ready ? t("基于已就绪的知识回答，回答附上相关来源引用。知识正文由创作者管理。", "Answers use ready knowledge and include relevant citations. Source content is managed by the creator.") : t("创作者正在准备知识，知识就绪后即可参与回答。", "The creator is preparing knowledge. Answers become available when it is ready.")}</p></div>
      <div class="public-dot-join"><button type="button" class="btn public-dot-invite" data-action="invite" data-id="${esc(dot.id)}" ${dot.discoveryDemo || dot.ownedDemo ? "disabled" : ""}>${I("plus")}${t("加入对话", "Add to a chat")}</button><p>${dot.discoveryDemo || dot.ownedDemo ? t("示例 Ree 仅供浏览，不会创建真实对话。", "Sample Rees are for browsing only.") : t("选择已有对话，或新建一场对话。", "Choose an existing chat or start a new one.")}</p></div>
    </aside>`;
  }
  function returnPath() {
    return discoveryReturnPath(ctx.route().query.get("from") || "");
  }
  function path(dot) {
    const current = ctx.route();
    const origin = current.path === "/explore"
      ? discoveryReturnPath("/explore" + (current.query.size ? "?" + current.query : ""))
      : returnPath();
    return "/d/" + encodeURIComponent(dot.slug) +
      (origin === "/explore" ? "" : "?from=" + encodeURIComponent(origin));
  }
  function page(dot) {
    if (!isPublicDot(dot)) return "";
    const facts = publicDotFacts(dot);
    const footer = `<footer class="public-dot-footer"><span>© 2026 RE0 · ${t("让每一份知识，都有回声。", "Give every piece of knowledge a voice.")}</span><button type="button" data-action="guide">${t("交互原型 · 本地演示", "Interactive prototype · Local demo")}${I("info")}</button></footer>`;
    const content = `${dot.discoveryDemo || dot.ownedDemo ? `<div class="discovery-scale-notice">${I("layers")}<span>${dot.ownedDemo ? t("测试 Ree · 公开状态与「我的 Ree」同步，刷新后恢复初始状态。", "Test Ree · Visibility follows My Rees and resets on refresh.") : t("规模演示 Ree · 以下为示例资料与统计", "Scale-demo Ree · Sample profile and statistics")}</span></div>` : ""}<div class="public-dot-layout">${overview(dot)}${summary(dot, facts)}</div>${recommendations(dot)}${footer}`;
    if (S().signed)
      return ctx.shell(`<div class="page public-dot-workspace public-dot-detail-content" data-dot="${esc(dot.id)}">${content}</div>`);
    const back = path(dot);
    const header = ctx.marketingHeader("/explore", { signInPath: "/login?next=" + encodeURIComponent(back) });
    const breadcrumbs = `<nav class="public-dot-breadcrumb" aria-label="${t("页面路径", "Breadcrumb")}"><a href="#${esc(returnPath())}">${I("arrow")}<span>${t("返回发现 Ree", "Back to discover")}</span></a>${I("chevron")}<span aria-current="page" title="${esc(title(dot))}">${esc(title(dot))}</span></nav>`;
    return `<div class="public-dot-site">${header}<main id="main" tabindex="-1" class="public-dot-page public-dot-detail-content" data-dot="${esc(dot.id)}">${breadcrumbs}${content}</main></div>`;
  }
  function unanswered(message, dot) {
    const missing =
      message.reason === "no-sources" ||
      (!message.reason && !publicDotFacts(dot).sourceCount);
    return `<article class="message public-dot-unanswered" data-message="${esc(message.id)}"><div class="message-head">${avatar(dot, true)}<strong>${esc(title(dot))}</strong>${ctx.userRoles?.badgeForRee(dot)||""}</div><h3>${missing ? t("知识还在准备，暂时无法给出回答。", "The knowledge is not ready to answer yet.") : t("这个问题，暂时超出了我的知识范围。", "This question is outside my knowledge for now.")}</h3><p>${t("没有找到足够的依据，你可以补充背景，或换一个更具体的问题。", "There is not enough evidence. Add some context or ask a more specific question.")}</p><small>${I("shield")}${t("未作答 · 本次未收费", "No answer · No credits charged")}</small></article>`;
  }
  function onAction(action, data) {
    if (action !== "public-ree-page") return false;
    if (!["related", "author"].includes(data.kind) || !Number.isInteger(Number(data.page))) return true;
    const current = ctx.route().path || "";
    if (!current.startsWith("/d/")) return true;
    const dot = resolvePublicDot(current.slice(3), S().dots || [], ctx.getOwnedRees?.());
    if (!dot) return true;
    const pages = recommendationPages(dot);
    const result = selectPublicReeRecommendations(dot, recommendationCatalog(), { ...pages, [data.kind]: Number(data.page) })[data.kind];
    pages[data.kind] = result.page;
    const group = typeof document !== "undefined" && document.querySelector(`[data-ree-group="${data.kind}"]`);
    if (group) group.outerHTML = recommendationGroup(dot, data.kind, result);
    return true;
  }
  return { page, unanswered, path, returnPath, onAction };
}
