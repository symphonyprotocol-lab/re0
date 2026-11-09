import test from "node:test";
import assert from "node:assert/strict";
import { isPublicDot, publicDotFacts, createPublicDot, discoveryReturnPath, resolvePublicDot } from "../public-dot.js";

const dot = {
  id: "mine",
  slug: "product",
  owner: "me",
  public: true,
  name: "产品助手",
  description: "有据可查的产品知识。",
  category: "product",
  tags: ["产品设计", "AI 应用"],
  fee: 35,
  answers: 130,
  rating: 98,
  prompt: "PRIVATE_SYSTEM_PROMPT",
  samples: ["怎样开始？"],
  knowledge: [
    {
      id: "ready",
      title: "公开来源标题",
      kind: "document",
      status: "ready",
      content: "PRIVATE_SOURCE_BODY",
    },
    {
      id: "paused",
      title: "暂停来源不公开",
      kind: "document",
      status: "ready",
      enabled: false,
    },
    { id: "failed", title: "失败来源不公开", kind: "page", status: "failed" },
  ],
};
function setup(state = {}, overrides = {}) {
  const stored = {
    lang: "zh",
    signed: true,
    displayName: "自定义创作者",
    dotMessages: {},
    ...state,
  };
  return createPublicDot({
    getState: () => stored,
    getUi: () => ({}),
    getPublicCatalog: () => [],
    discoveryCover: (dot) => `<div class="discovery-cover" data-discovery-cover="${dot.id}"></div>`,
    t: (zh) => zh,
    I: () => "",
    esc: (value) => String(value ?? "").replaceAll('"', "&quot;"),
    n: String,
    title: (dot) => dot.name,
    desc: (dot) => dot.description,
    avatar: () => '<span class="dot-avatar"></span>',
    wordmark: () => "RE0",
    marketingHeader: (active, { signInPath }) => `<header class="marketing-header" data-active="${active}"><nav aria-label="官网导航"><a href="#/">首页</a><a href="#/explore">发现 Ree</a><a href="#/pricing">价格与购买</a></nav><a href="#${signInPath}">登录</a></header>`,
    shell: (content) => `<div class="test-workspace-shell">${content}</div>`,
    inlineVideo: () => '<div class="dot-inline-player"><button data-action="video-play">播放视频介绍</button><button data-action="inline-video-fullscreen">全屏播放</button></div>', 
    fee: (dot) => 20 + (dot.owner === "me" ? 0 : dot.fee),
    classification: { categoryLabel: () => "产品设计" },
    kinds: {
      document: ["文档", "Document", "file"],
      page: ["网页", "Web page", "globe"],
    },
    route: () => ({ query: new URLSearchParams("q=开始使用") }),
    messageHTML: (message) => `<article>${message.text}</article>`,
    ...overrides,
  });
}
test("public facts use cumulative counts, enabled ready sources and a viewer-independent advertised price", () => {
  assert.equal(publicDotFacts(dot).answers, 130);
  assert.equal(publicDotFacts(dot).sourceCount, 1);
  assert.equal(publicDotFacts(dot).price, 55);
  assert.equal(publicDotFacts(dot).positiveRate,98);
  assert.equal(publicDotFacts({ ...dot, owner: "someone" }).price, 55);
  assert.equal(isPublicDot({ ...dot, moderated: true }), false);
  assert.equal(isPublicDot({ ...dot, public: false }), false);
});
test("public metrics distinguish existing positive ratings, unrated Rees and valid zero-percent ratings", () => {
  for(const rating of [undefined,null,"",0,-1,101,Infinity,"bad",false])
    assert.equal(publicDotFacts({...dot,rating}).positiveRate,null);
  assert.equal(publicDotFacts({...dot,rating:"97.5"}).positiveRate,97.5);
  assert.equal(publicDotFacts({...dot,rating:0,ratingCount:3}).positiveRate,0);
  assert.equal(publicDotFacts({...dot,answers:Infinity}).answers,0);
  const html=setup().page({...dot,rating:0});
  assert.match(html,/好评率/);
  assert.match(html,/暂无评价/);
});
test("the built-in product assistant includes its video player before discussion topics while private pages remain unavailable", () => {
  const stock={...structuredClone(dot),slug:"re0-product",video:{generated:false,scenes:[{name:"Private draft"}]}};
  const before=structuredClone(stock),html=setup().page(stock);
  assert.match(html,/视频介绍/);
  assert.match(html,/dot-inline-player/);
  assert.ok(html.indexOf("dot-inline-player")<html.indexOf("你可以和它聊这些"));
  assert.match(html,/好评率/);
  assert.deepEqual(stock,before);
  assert.equal(setup().page({...stock,public:false}),"");
});
test("public resolution follows live owned visibility and private records cannot fall back to scale data", () => {
  const sample={...structuredClone(dot),id:"owned-ree-scale-0600",slug:"owned-ree-scale-0600",ownedDemo:true};
  assert.equal(resolvePublicDot(sample.slug,[],[sample]),sample);
  sample.public=false;
  assert.equal(resolvePublicDot(sample.slug,[],[sample]),undefined);
  sample.public=true;sample.moderated=true;
  assert.equal(resolvePublicDot(sample.slug,[],[sample]),undefined);
  assert.equal(resolvePublicDot("discovery-scale-0001",[{...dot,slug:"discovery-scale-0001",public:false}]),undefined);
  assert.equal(resolvePublicDot("discovery-scale-0001",[]).id,"discovery-scale-0001");
  assert.equal(resolvePublicDot("missing",[]),undefined);
});
test("published owned test details remain read-only for signed-in users and visitors", () => {
  const sample={...structuredClone(dot),ownedDemo:true},before=structuredClone(dot);
  for(const signed of [true,false]) {
    const html=setup({signed}).page(sample);
    assert.match(html,/公开状态与「我的 Ree」同步/);
    assert.match(html,/data-action="invite"[^>]*disabled/);
    assert.match(html,/示例 Ree 仅供浏览/);
    assert.doesNotMatch(html,/PRIVATE_SOURCE_BODY|PRIVATE_SYSTEM_PROMPT/);
  }
  assert.deepEqual(dot,before);
});
test("a hundred-source public page displays only a static count and keeps names out of the introduction", () => {
  const many = {
    ...dot,
    knowledge: Array.from({ length: 100 }, (_, i) => ({
      id: String(i),
      title: `SECRET_DOC_${i}`,
      kind: "document",
      status: "ready",
      content: "SECRET_SOURCE_BODY",
    })),
  };
  const before = structuredClone(many);
  const html = setup().page(many);
  assert.match(html, /class="public-dot-source-total"><span>知识来源<\/span><strong>100<\/strong>/);
  assert.doesNotMatch(
    html,
    /SECRET_DOC_|SECRET_SOURCE_BODY|public-source-|data-action="public-sources"/,
  );
  assert.deepEqual(many, before);
});
test("detail page shows saved profile, static topics and prices without reading or changing conversation history", () => {
  const histories = {
    "public:mine": [{ text: "PRIVATE_PUBLIC_HISTORY" }],
    "dot:mine": [{ text: "PRIVATE_CREATOR_TEST" }],
  };
  const before = structuredClone(histories);
  const html = setup({ dotMessages: histories }).page(dot);
  assert.match(html, /累计成功回答/);
  assert.match(html, /自定义创作者/);
  assert.match(html, /有据可查的产品知识/);
  assert.match(html, /你可以和它聊这些/);
  assert.match(html, /怎样开始？/);
  assert.match(html, /自己的提问仅收取 20 credits/);
  assert.doesNotMatch(html, /PRIVATE_SYSTEM_PROMPT|PRIVATE_SOURCE_BODY|PRIVATE_CREATOR_TEST|PRIVATE_PUBLIC_HISTORY|公开来源标题|暂停来源不公开|失败来源不公开|30 天/);
  assert.doesNotMatch(html, /<textarea|<form|id="transcript"|id="prefill"|public:mine|public-prompt|问问这个 Dot/);
  assert.deepEqual(histories, before);
  assert.equal(setup().page({ ...dot, moderated: true }), "");
  assert.equal(setup().page({ ...dot, public: false }), "");
});
test("visitor detail page offers sign-in, joining a chat, and an inline player or default video placeholder", () => {
  const html = setup({ signed: false }).page({ ...dot, owner: "作者" });
  assert.match(html, /next=%2Fd%2Fproduct"/);
  assert.match(html, /data-action="invite" data-id="mine"/);
  assert.match(html, /选择已有对话，或新建一场对话/);
  assert.match(html, /class="dot-inline-player"/);
  assert.match(html, /data-action="inline-video-fullscreen"/);
  assert.doesNotMatch(html, /data-action="play-video"|大窗口播放/);
  assert.doesNotMatch(html, /管理这个 Ree|自己的提问仅收取|登录并发送|id="prefill"/);
  assert.doesNotMatch(setup().page(dot), /class="dot-inline-player"/);
  for (const video of [undefined, { generated: false, scenes: [{ name: "PRIVATE_DRAFT" }] }]) {
    const withoutVideo = { ...structuredClone(dot), video };
    const before = structuredClone(withoutVideo);
    for (const signed of [true, false]) {
      const placeholder = setup({ signed }).page(withoutVideo);
      assert.match(placeholder, /class="public-dot-video-placeholder"/);
      assert.match(placeholder, /暂无视频介绍/);
      assert.ok(placeholder.indexOf('class="public-dot-video-placeholder"') < placeholder.indexOf("你可以和它聊这些"));
      assert.doesNotMatch(placeholder, /dot-inline-player|data-action="video-play"|PRIVATE_DRAFT/);
    }
    assert.deepEqual(withoutVideo, before);
  }
});
test("unavailable knowledge is explicit on the detail page and legacy no-answer messages remain non-chargeable", () => {
  const empty = { ...dot, knowledge: [] };
  const api = setup();
  assert.match(api.page(empty), /知识准备中/);
  assert.match(api.page(empty), /创作者正在准备知识/);
  assert.doesNotMatch(api.page(empty), /<textarea|<form/);
  assert.match(api.unanswered({ id: "one", noAnswer: true, reason: "out-of-scope" }, dot), /超出了我的知识范围/);
  assert.match(api.unanswered({ id: "one", noAnswer: true, reason: "no-sources" }, empty), /本次未收费/);
});

test("signed-in details keep the workspace shell while guests use website navigation and a separate in-content breadcrumb", () => {
  for (const experienceMode of ["chat", "creator"]) {
    const html = setup({ signed: true, experienceMode }).page(dot);
    assert.match(html, /test-workspace-shell/);
    assert.match(html, /page public-dot-workspace public-dot-detail-content/);
    assert.doesNotMatch(html, /class="public-dot-site"|class="public-dot-top"|<main/);
  }
  const guest = setup({ signed: false }).page(dot);
  assert.match(guest, /class="public-dot-site"/);
  assert.match(guest, /class="marketing-header" data-active="\/explore"/);
  assert.match(guest, /aria-label="官网导航"/);
  assert.match(guest, /href="#\/pricing"/);
  assert.match(guest, /class="public-dot-breadcrumb" aria-label="页面路径"/);
  assert.match(guest, /aria-current="page" title="产品助手"/);
  assert.match(guest, /返回发现 Ree/);
  assert.ok(guest.indexOf("</header>") < guest.indexOf('<main id="main"'));
  assert.ok(guest.indexOf('<main id="main"') < guest.indexOf('class="public-dot-breadcrumb"'));
  assert.doesNotMatch(guest, /test-workspace-shell|public-dot-workspace|class="public-dot-top"/);
});
test("detail links and login returns preserve discovery search, category and sort across refresh", () => {
  const origin = "/explore?q=React&category=technology&sort=answers";
  const listing = setup({}, { route: () => ({ path: "/explore", query: new URLSearchParams(origin.split("?")[1]) }) });
  const path = listing.path(dot);
  const detailQuery = new URLSearchParams(path.split("?")[1]);
  assert.equal(detailQuery.get("from"), origin);
  const detail = setup({ signed: false }, { route: () => ({ path: "/d/product", query: detailQuery }) });
  assert.equal(detail.returnPath(), origin);
  const html = detail.page(dot);
  assert.match(html, /href="#\/explore\?q=React&category=technology&sort=answers"/);
  assert.ok(html.includes("next=" + encodeURIComponent(path)));
  assert.equal(detail.path(dot), path);
});
test("return links only accept discovery paths and recognized filter fields", () => {
  for (const value of ["", "https://example.org", "//example.org", "/settings", "/explore/../../admin", "/explore#other"])
    assert.equal(discoveryReturnPath(value), "/explore");
  assert.equal(discoveryReturnPath("/explore?q=React&category=invalid&sort=invalid&next=https://example.org"), "/explore?q=React");
  assert.equal(discoveryReturnPath("/explore?category=design&sort=free"), "/explore?category=design&sort=free");
});

test("scale-demo details cannot create real conversations and keep account records intact", () => {
  const account = { signed:true, lang:"zh", dots:[dot], chats:[{id:"saved",dots:["mine"],messages:[]}], planCredits:120, dotMessages:{} };
  const before = structuredClone(account);
  const detail = setup({}, {getState:()=>account,route:()=>({path:"/d/discovery-scale-1177",query:new URLSearchParams("from=%2Fexplore%3Fsample%3Dscale%26page%3D50")})});
  const html = detail.page({...dot,id:"discovery-scale-1177",slug:"discovery-scale-1177",discoveryDemo:true,owner:"示例作者"});
  assert.match(html, /规模演示 Ree/);
  assert.match(html, /data-action="invite"[^>]*disabled/);
  assert.match(html, /示例 Ree 仅供浏览/);
  assert.equal(detail.returnPath(), "/explore?sample=scale&page=50");
  assert.deepEqual(account,before);
});

test("detail recommendations preserve discovery context, paginate each group separately and keep account data intact", () => {
  const catalog = [dot, ...Array.from({ length: 9 }, (_, i) => ({ ...dot, id: "other-" + i, slug: "other-" + i, name: "Related " + i, answers: i }))];
  const state = { signed: true, displayName: "Creator", dots: catalog }, before = structuredClone(state), ui = {};
  const api = setup({}, { getState: () => state, getUi: () => ui, getPublicCatalog: () => catalog, route: () => ({ path: "/d/product", query: new URLSearchParams("from=%2Fexplore%3Fq%3DPython%26page%3D3") }) });
  const html = api.page(dot);
  assert.match(html, /相关 Rees/);
  assert.match(html, /作者的其他 Rees/);
  assert.match(html, /href="#\/d\/other-8\?from=%2Fexplore%3Fq%3DPython%26page%3D3"/);
  assert.ok(html.indexOf('class="public-ree-recommendations"') > html.indexOf('class="public-dot-layout"'));
  assert.equal(api.onAction("public-ree-page", { kind: "author", page: "2" }), true);
  assert.equal(ui.publicReePages.product.author, 2);
  assert.equal(ui.publicReePages.product.related, undefined);
  assert.match(api.page(dot), /5–8 \/ 9/);
  assert.equal(api.onAction("unrelated-action", {}), false);
  assert.deepEqual(state, before);
});
