import { createSuite } from "./suite.js";
import { discoveryDemoDot } from "./discovery.js";
import { resolvePublicDot, publicDotFacts } from "./public-dot.js";
import { conversationSearchReturnPath } from "./conversations.js";
import { activePayout } from "./manual-kyc.js";
import { DOT_MARK, renderDotAvatar, dotAvatarValue } from "./dot-avatar.js";
import { DOT_CATEGORIES, dotCategory } from "./dot-classification.js";
let suite;
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
// Existing accounts may still contain this stock question; update its display only.
const prototypeCopy = (value) => value === "多 Dot 对话如何计算费用？" ? "多 Ree 对话如何计算费用？" : value;
const esc = (v = "") =>
  prototypeCopy(String(v)).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const uid = () => crypto.randomUUID();
const n = (value) => new Intl.NumberFormat("en-US").format(value);
const storageKey = "re0-rebuild-prototype-v3";
const paths = {
  sort: '<path d="M8 3v18m-4-4 4 4 4-4M16 21V3m-4 4 4-4 4 4"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  list: '<path d="M9 5h12M9 12h12M9 19h12M3 5h.01M3 12h.01M3 19h.01"/>',
  fullscreen: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  minimize: '<path d="M3 8h5V3m8 0v5h5M8 21v-5H3m13 5v-5h5"/>',
  chart: '<path d="M4 3v18h17M9 16v-5m5 5V6m5 10V9"/>',
  pin: '<path d="m9 3 12 12-3 3-4-2-4 4-2-2 4-4-2-4Zm-6 18 6-6"/>',
  archive: '<path d="M4 8h16v13H4ZM3 3h18v5H3Zm6 9h6"/>',
  "panel-close":
    '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18m7-13-3 4 3 4"/>',
  "panel-open":
    '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18m4-13 3 4-3 4"/>',
  play: '<path d="m8 4 12 8-12 8Z"/>',
  pause: '<path d="M8 4v16M16 4v16"/>',
  film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18m10-18v18M3 8h4m-4 8h4m10-8h4m-4 8h4"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  compass:
    '<circle cx="12" cy="12" r="9"/><path d="m16 8-2.4 5.6L8 16l2.4-5.6Z"/>',
  dot: DOT_MARK,
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 2V11.5A8.5 8.5 0 0 1 9.5 3h3a8.5 8.5 0 0 1 8.5 8.5Z"/><path d="M7 10h8m-8 4h5"/>',
  wallet:
    '<path d="M20 7V4H5a3 3 0 0 0 0 6h16v10H5a3 3 0 0 1-3-3V7"/><path d="M21 10h-6v6h6M17 13h.01"/>',
  settings:
    '<path d="m9 3 1-2h4l1 2 3 2 2-.2 2 3.4-1.3 1.8v3.7l1.3 1.9-2 3.4-2-.2-3 1.7-1 2h-4l-1-2-3-1.7-2 .2-2-3.4L3.3 14v-3.7L2 8.4 4 5l2 .2Z" transform="translate(1 1) scale(.9)"/><circle cx="12" cy="12" r="3"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  sparkle:
    '<path d="m12 2 2.7 7.3L22 12l-7.3 2.7L12 22l-2.7-7.3L2 12l7.3-2.7ZM20 2v4m-2-2h4"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8m-8 4h6"/>',
  folder:
    '<path d="M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  audio: '<path d="M3 10v4m4-8v12m5-16v20m5-16v12m4-8v4"/>',
  github:
    '<path d="M9 19c-4.5 1.5-4.5-2.5-6-3m12 6v-4a3.5 3.5 0 0 0-1-2.5c3.3-.4 6.7-1.6 6.7-7A5.4 5.4 0 0 0 19.2 5c.2-.5.7-2.3-.2-4 0 0-1.3-.4-4.1 1.5a14 14 0 0 0-7.4 0C4.7.6 3.4 1 3.4 1c-.9 1.7-.4 3.5-.2 4a5.4 5.4 0 0 0-1.5 3.7c0 5.3 3.4 6.5 6.7 7a3.5 3.5 0 0 0-1 2.5v4" transform="translate(1 0) scale(.95)"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  link: '<path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 8 1 1a4 4 0 0 0 6-6l-5-5" transform="translate(2 2) scale(.9)"/>',
  text: '<path d="M4 5h16M12 5v15M8 20h8M4 8V5m16 3V5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  shield:
    '<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Z"/><path d="m8 12 3 3 5-6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  up: '<path d="M4 14h4v8H4Zm4 6h10a2 2 0 0 0 2-1.5l2-8A2 2 0 0 0 20 8h-5V4a2 2 0 0 0-4-1l-3 9" transform="translate(0 -1) scale(.95)"/>',
  downvote:
    '<g transform="translate(24 24) rotate(180)"><path d="M4 14h4v8H4Zm4 6h10a2 2 0 0 0 2-1.5l2-8A2 2 0 0 0 20 8h-5V4a2 2 0 0 0-4-1l-3 9"/></g>',
  users:
    '<circle cx="9" cy="8" r="3"/><path d="M2 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6m1 4a5 5 0 0 1 4 5"/>',
  send: '<path d="m12 4 7 7m-7-7-7 7m7-7v16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H4v13h4"/>',
  external: '<path d="M14 3h7v7m0-7L11 13M10 3H4v17h17v-6"/>',
  refresh:
    '<path d="M20 10a8 8 0 0 0-14-5L3 8m0-6v6h6m-5 6a8 8 0 0 0 14 5l3-3m0 6v-6h-6"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M3 16v5h18v-5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 10v7m0-11v1"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  logout: '<path d="M10 3H4v18h6m6-15 6 6-6 6m-7-6h13"/>',
  book: '<path d="M12 6v15M2 3h5a5 5 0 0 1 5 3 5 5 0 0 1 5-3h5v16h-5a5 5 0 0 0-5 2 5 5 0 0 0-5-2H2Z"/>',
  layers:
    '<path d="m12 2 10 6-10 6L2 8Zm-10 12 10 6 10-6M2 19l10 6 10-6" transform="scale(.9) translate(1 0)"/>',
  code: '<path d="m8 5-6 7 6 7m8-14 6 7-6 7m-3-17-2 20"/>',
  light:
    '<path d="M9 18h6m-6 3h6M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 4H9c0-2 0-3-1-4Z"/>',
  map: '<path d="m3 5 6-3 6 3 6-3v17l-6 3-6-3-6 3Zm6-3v17m6-14v17"/>',
};
function icon(name, cls = "") {
  return `<svg class="${cls}" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.dot}</svg>`;
}
const I = icon;
const kinds = {
  document: ["文档", "Document", "file"],
  audio: ["音频", "Audio", "audio"],
  github: ["GitHub", "GitHub", "github"],
  page: ["单个网页", "Web page", "link"],
  site: ["整站", "Website", "globe"],
  text: ["粘贴文本", "Text", "text"],
};
function source(id, title, kind, locator, content = "") {
  return { id, title, kind, locator, status: "ready", content };
}
function seed() {
  return {
    version: 3,
    lang: "zh",
    signed: false,
    admin: false,
    plan: true,
    cancelled: false,
    planCredits: 68240,
    packCredits: 100000,
    earnedCredits: 528000,
    welcomeCredits: 0,
    kyc: "none",
    paypal: "",
    paypalChanged: 0,
    tax: "W-8BEN",
    github: true,
    domains: [{ domain: "re0.ai", status: "verified", method: "dns" }],
    payouts: [],
    dots: [
      {
        id: "design",
        slug: "design-partner",
        name: "产品设计顾问",
        enName: "Design partner",
        description: "从设计系统到用户体验，让每一个设计决策都有依据。",
        enDescription:
          "Thoughtful answers on design systems, product decisions, and user experience.",
        tags: ["产品设计", "用户体验"],
        icon: "layers",
        color: "",
        owner: "林舟",
        fee: 30,
        public: true,
        answers: 1280,
        rating: 98,
        samples: [
          "如何从零搭建一个设计系统？",
          "怎样评估产品的用户体验？",
          "设计规范应该包含哪些内容？",
        ],
        knowledge: [
          source(
            "d1",
            "设计系统实践手册.pdf",
            "document",
            "第 24–26 页",
            "一个可扩展的设计系统从设计原则开始。优先整理颜色、字体、间距等基础变量，再将常用交互沉淀成组件。每个组件需要包含使用场景、交互状态、无障碍约束与代码示例。",
          ),
          source("d2", "用户访谈与研究方法.md", "document", "第 3 节"),
          source(
            "d3",
            "design-system / components",
            "github",
            "components/button.tsx · L18–42",
          ),
          source("d4", "设计复盘 · 第 12 期.m4a", "audio", "12:34–13:08"),
        ],
      },
      {
        id: "code",
        slug: "frontend-guide",
        name: "前端技术搭子",
        enName: "Frontend companion",
        description: "读过源码的技术伙伴，聊 React、Next.js 和前端工程化。",
        enDescription:
          "A source-aware companion for React, Next.js, and frontend engineering.",
        tags: ["技术开发", "开源项目"],
        icon: "code",
        color: "lilac",
        owner: "Alex Chen",
        fee: 0,
        public: true,
        answers: 2460,
        rating: 99,
        samples: [
          "React 组件应该如何拆分？",
          "Next.js 如何组织服务端与客户端组件？",
          "如何让组件同时支持键盘操作？",
        ],
        knowledge: [
          source("c1", "React 官方文档", "site", "react.dev / learn"),
          source("c2", "vercel / next.js", "github", "app/page.tsx · L12–38"),
          source("c3", "前端工程化指南.md", "document", "第 4 节"),
        ],
      },
      {
        id: "growth",
        slug: "growth-notes",
        name: "独立开发手记",
        enName: "Indie maker notes",
        description: "从第一行代码到第一位付费用户，分享独立开发的真实经验。",
        enDescription:
          "Real lessons from the first line of code to the first paying customer.",
        tags: ["独立开发", "商业增长"],
        icon: "light",
        color: "sand",
        owner: "小川",
        fee: 50,
        public: true,
        answers: 864,
        rating: 97,
        samples: [
          "如何验证一个产品想法？",
          "怎么找到第一批种子用户？",
          "独立产品应该如何定价？",
        ],
        knowledge: [
          source("g1", "从 0 到 1 的产品验证.pdf", "document", "第 8–10 页"),
          source("g2", "独立开发者访谈.mp3", "audio", "08:42–10:15"),
          source("g3", "增长实验记录", "text", "第 2 段"),
        ],
      },
      {
        id: "read",
        slug: "reading-room",
        name: "阅读与思考",
        enName: "The reading room",
        description: "把读过的书连接起来，在文字之间发现新的思考。",
        enDescription:
          "Connect ideas across books and find new perspectives between the lines.",
        tags: ["阅读写作", "个人成长"],
        icon: "book",
        color: "sage",
        owner: "Mia",
        fee: 0,
        public: true,
        answers: 752,
        rating: 98,
        samples: [
          "如何建立自己的阅读体系？",
          "读完一本书之后如何做笔记？",
          "如何把知识转化为行动？",
        ],
        knowledge: [
          source("r1", "卡片笔记写作法.md", "document", "第 2 章"),
          source("r2", "阅读笔记合集", "text", "第 12 段"),
        ],
      },
      {
        id: "brand",
        slug: "brand-studio",
        name: "品牌灵感库",
        enName: "Brand inspiration",
        description: "好品牌不止于视觉。从品牌策略到表达，寻找你的独特声音。",
        enDescription:
          "Find your unique voice, from brand strategy to visual expression.",
        tags: ["产品设计", "商业增长"],
        icon: "sparkle",
        color: "rose",
        owner: "Studio June",
        fee: 20,
        public: true,
        answers: 618,
        rating: 96,
        samples: [
          "如何找到品牌的差异化定位？",
          "品牌语气如何保持一致？",
          "如何设计品牌视觉识别？",
        ],
        knowledge: [
          source("br1", "品牌策略工作手册.pdf", "document", "第 16 页"),
          source("br2", "品牌案例研究", "page", "品牌定位与表达"),
        ],
      },
      {
        id: "ai",
        slug: "ai-fieldnotes",
        name: "AI 实践指南",
        enName: "AI field notes",
        description: "少一点概念，多一点实践。让 AI 真正融入你的工作流。",
        enDescription:
          "Less hype, more practice. Bring AI into your everyday workflow.",
        tags: ["技术开发", "AI 应用"],
        icon: "dot",
        color: "slate",
        owner: "Ethan",
        fee: 10,
        public: true,
        answers: 1920,
        rating: 98,
        samples: [
          "RAG 应用如何提高回答准确率？",
          "如何为知识库设计切块策略？",
          "怎样评估 AI 回答的质量？",
        ],
        knowledge: [
          source("a1", "RAG 实战指南.md", "document", "第 3 章"),
          source("a2", "AI 工程实践交流.wav", "audio", "18:20–19:05"),
        ],
      },
      {
        id: "mine",
        slug: "re0-product",
        name: "RE0 产品助手",
        enName: "RE0 product assistant",
        description: "关于 RE0 的产品设计、功能说明与团队共识，都可以来问我。",
        enDescription:
          "Ask me about RE0 product decisions, features, and team knowledge.",
        tags: ["产品设计", "AI 应用"],
        icon: "dot",
        color: "",
        owner: "me",
        fee: 0,
        public: true,
        answers: 126,
        rating: 98,
        prompt:
          "你是 RE0 的产品助手。只根据提供的知识回答，保持清晰、友好，并标注引用。",
        samples: [
          "RE0 支持哪些知识来源？",
          "Plan 和 Pack 有什么区别？",
          "多 Ree 对话如何计算费用？",
        ],
        knowledge: [
          source(
            "m1",
            "rebuild-proposal.md",
            "document",
            "第 2.1 节",
            "RE0 支持六种知识来源：PDF、Word、Markdown、TXT 文档；MP3、M4A、WAV 音频；GitHub 仓库；单个网页；整站；粘贴文本。整站抓取需要域名确权，私有 GitHub 仓库需要授权。",
          ),
          source(
            "m2",
            "RE0 产品设计规范.pdf",
            "document",
            "第 12 页",
            "RE0 使用 #127ee3 电光蓝作为品牌主色，#091135 深海军蓝作为正文颜色，#f5f3ff 浅薰衣草作为页面背景。卡片圆角为 12px，按钮为 8px。",
          ),
          source("m3", "symphony / re0", "github", "README.md · L1–32"),
          source("m4", "产品方向讨论.m4a", "audio", "12:34–13:08"),
        ],
      },
      {
        id: "notes",
        slug: "my-reading-notes",
        name: "我的阅读库",
        enName: "My reading notes",
        description: "让读过的每一本书，都成为随时可以对话的知识。",
        enDescription:
          "Keep the ideas from every book ready for your next conversation.",
        tags: ["阅读写作"],
        icon: "book",
        color: "sage",
        owner: "me",
        fee: 0,
        public: false,
        answers: 42,
        rating: 100,
        prompt: "根据我的阅读笔记回答问题。",
        samples: [
          "如何更好地做阅读笔记？",
          "怎样建立知识之间的联系？",
          "如何将阅读收获应用到工作？",
        ],
        knowledge: [
          source("n1", "卡片笔记写作法.md", "document", "第 2 章"),
          source("n2", "最近的阅读思考", "text", "第 3 段"),
        ],
      },
    ],
    chats: [
      {
        id: "design-review",
        title: "一起聊聊产品设计系统",
        dots: ["design", "code"],
        updated: "今天 10:42",
        messages: [
          {
            id: "demo-u",
            role: "user",
            text: "搭建设计系统时，设计和前端应该如何协作？",
          },
          {
            id: "demo-a",
            role: "dot",
            dot: "design",
            text: "建议从一套共同的设计变量开始，让设计与代码使用同一套语言。\n\n先统一颜色、字体、间距和圆角，再一起定义按钮、输入框等基础组件的使用场景与交互状态。每个组件都应该说明「什么时候用」以及「如何正确使用」。",
            source: "d1",
            cost: 50,
          },
          {
            id: "demo-b",
            role: "dot",
            dot: "code",
            text: "在工程实现上，可以将设计变量映射成 CSS 自定义属性，由组件统一引用。\n\n组件接口需要覆盖尺寸、状态、键盘操作与无障碍属性。把设计稿、组件文档与代码示例放在一起维护，能减少交付时的信息损失。",
            source: "c2",
            cost: 20,
          },
        ],
      },
    ],
    dotMessages: {},
    entries: [
      {
        title: "产品设计顾问 · 查询收入",
        type: "income",
        amount: 30,
        time: "今天 10:38",
      },
      {
        title: "RE0 产品助手 · 提问",
        type: "query",
        amount: -20,
        time: "今天 10:25",
      },
      {
        title: "rebuild-proposal.md · 知识处理",
        type: "knowledge",
        amount: -24,
        time: "今天 09:56",
      },
      {
        title: "Pack · 充值成功",
        type: "purchase",
        amount: 100000,
        time: "10 月 28 日",
      },
      {
        title: "Plan · 当期额度",
        type: "purchase",
        amount: 100000,
        time: "10 月 24 日",
      },
    ],
    adminPayouts: [
      {
        id: "p1",
        name: "林舟",
        email: "linzhou@example.com",
        credits: 620000,
        status: "pending",
        tax: "W-8BEN",
      },
      {
        id: "p2",
        name: "Alex Chen",
        email: "alex@example.com",
        credits: 510000,
        status: "pending",
        tax: "W-9",
      },
    ],
  };
}
let state;
try {
  state = JSON.parse(localStorage.getItem(storageKey));
} catch {}
if (!state || state.version !== 3) state = seed();
const ui = {
  category: "全部",
  sort: "active",
  ownFilter: "all",
  billingTab: "all",
  settingsTab: "account",
  busy: false,
  modal: null,
  addKind: "document",
  color: "",
  selectedFile: null,
  selectedDots: [],
  returnTo: null,
  streaming: null,
};
const t = (zh, en) => (state.lang === "en" ? en : zh);
const title = (b) => (state.lang === "en" ? b.enName || b.name : b.name);
const desc = (b) =>
  state.lang === "en" ? b.enDescription || b.description : b.description;
const balance = () =>
  state.planCredits +
  state.packCredits +
  state.earnedCredits +
  state.welcomeCredits;
const mine = () => state.dots.filter((b) => b.owner === "me");
const publicDots = () => state.dots.filter((b) => b.public && !b.moderated && b.owner !== "me");
const dotById = (id) =>
  state.dots.find((b) => b.id === id) ||
  state.archivedDots?.find((b) => b.id === id) || discoveryDemoDot(id);
function publicDotBySlug(slug) {
  return resolvePublicDot(slug, state.dots, suite?.ownedRees.catalog());
}
const fee = (b) => 20 + (b.owner === "me" ? 0 : b.fee);
const save = () => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
    return true;
  } catch {
    toast(
      t(
        "浏览器存储已满，本次更改仅在当前页面保留",
        "Storage is full. Changes will last for this session only.",
      ),
    );
    return false;
  }
};
const route = () => {
  const u = new URL(location.hash.slice(1) || "/", location.origin);
  return { path: u.pathname, query: u.searchParams };
};
function go(path) {
  closeModal();
  if (location.hash === "#" + path) render();
  else location.hash = path;
}
const wordmark = () =>
  `<a class="wordmark" href="#/" aria-label="RE0 ${t("首页", "home")}"><img src="icon.svg" alt=""><span>RE0</span></a>`;
function avatar(b, sm = false) {
  return renderDotAvatar(b, { small: sm, esc });
}
function btn(label, action, kind = "", extra = "") {
  return `<button class="btn ${kind}" data-action="${action}" ${extra}>${label}</button>`;
}
function iconBtn(name, label, action, extra = "") {
  const cls = extra.match(/class="([^"]*)"/)?.[1] || "";
  extra = extra.replace(/class="[^"]*"/, "");
  return `<button class="icon-btn ${cls}" aria-label="${esc(label)}" title="${esc(label)}" data-action="${action}" ${extra}>${I(name)}</button>`;
}
function footer() {
  return `<footer class="page-footer"><span>© 2026 RE0 · ${t("让每一份知识，都有回声", "Give every piece of knowledge a voice.")}</span><span class="mono">REE + KNOWLEDGE + CONVERSATION</span><a href="#" data-action="guide">${t("原型导览", "Prototype guide")} ${I("external")}</a></footer>`;
}
function crumbFor() {
  const p = route().path;
  if (p === "/dashboard") return t("工作台概览", "Overview");
  if (p === "/talk") return t("新建对话", "New conversation");
  if (p === "/videos") return t("视频工作室", "Video studio");
  if (/^\/dots\/[^/]+\/video$/.test(p))
    return t("我的 Ree / 视频介绍", "My Rees / Video introduction");
  if (p.includes("/knowledge"))
    return t("我的 Ree / 知识管理", "My Rees / Knowledge library");
  return p.startsWith("/dots/")
    ? t("我的 Ree / Ree 工作台", "My Rees / Ree studio")
    : p.startsWith("/dots")
      ? t("我的 Ree", "My Rees")
      : p.startsWith("/chats/")
        ? t("我的对话 / 多 Ree 对话", "Conversations / Group chat")
        : p.startsWith("/chats")
          ? t("搜索对话", "Search conversations")
          : p.startsWith("/billing")
            ? t("余额与计费", "Credits & billing")
            : p.startsWith("/settings")
              ? t("设置", "Settings")
              : p.startsWith("/admin")
                ? t("提现审核", "Payout review")
                : t("发现 Ree", "Discover");
}
function selectedSettingsTab() {
  const tab = route().query.get("tab");
  return ["account", "role", "connections", "billing"].includes(tab) ? tab : "account";
}
function settingsHeaderTabs() {
  return `<nav class="header-tabs settings-header-tabs" aria-label="${t("设置分类", "Settings sections")}">${[
    ["account", t("个人资料", "Profile")],
    ["role", t("角色与认证", "Role & verification")],
    ["connections", t("连接与域名", "Connections & domains")],
    ["billing", t("余额与计费", "Credits & billing")],
  ].map(([value, label]) => `<a href="#/settings?tab=${value}" class="${selectedSettingsTab() === value ? "active" : ""}" ${selectedSettingsTab() === value ? 'aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
}
function workspaceHeader() {
  const p = route().path;
  const link = (path, label) => `<a href="#${esc(path)}" title="${esc(label)}">${esc(label)}</a>`;
  const current = (label) => `<span aria-current="page">${esc(label)}</span>`;
  const root = suite.experience.home();
  const rootLabel = suite.experience.label();
  const parts = ["/talk", "/chats"].includes(p) ? [] : [p === root ? current(rootLabel) : link(root, rootLabel)];
  const dotMatch = p.match(
    /^\/dots\/([^/]+)(?:\/(knowledge|video|statistics|settings|chat)(?:\/([^/]+))?)?$/,
  );
  const b = dotMatch && dotById(dotMatch[1]);
  const publicDetail = p.startsWith("/d/")
    ? publicDotBySlug(p.split("/")[2])
    : null;
  let context = "";
  let reeNavigation = "";
  if (publicDetail) {
    parts.push(link(suite.publicDot.returnPath(), t("发现 Ree", "Discover Rees")));
    parts.push(current(title(publicDetail)));
  } else if (["/workspace/sources", "/workspace/answers"].includes(p)) {
    parts.push(current(p.endsWith("sources") ? t("知识来源明细", "Source details") : t("累计回答明细", "Answer details")));
  } else if (p === "/dots/new") {
    parts.push(link("/dots", t("我的 Ree", "My Rees")));
    parts.push(current(t("创建 Ree", "Create Ree")));
    context = `<div class="context-nav-row">${suite.dotSetup.headerSteps()}</div>`;
  } else if (b?.owner === "me") {
    const backPath = dotMatch[3] ? "/dots/" + b.id + "/knowledge" : "/dots";
    const backLabel = dotMatch[3] ? t("返回知识管理", "Back to knowledge") : t("返回我的 Ree", "Back to My Rees");
    reeNavigation = `<div class="ree-mobile-location"><a class="ree-mobile-back" href="#${esc(backPath)}" aria-label="${backLabel}" title="${backLabel}">${I("arrow")}</a><span title="${esc(title(b))}">${esc(title(b))}</span></div>`;
    parts.push(link("/dots", t("我的 Ree", "My Rees")));
    parts.push(
      p === "/dots/" + b.id
        ? current(title(b))
        : link("/dots/" + b.id, title(b)),
    );
    if (dotMatch[3]) {
      parts.push(
        link("/dots/" + b.id + "/knowledge", t("知识管理", "Knowledge")),
      );
      const source = [...b.knowledge, ...(b.knowledgeTrash || [])].find(
        (k) => k.id === dotMatch[3],
      );
      parts.push(current(source?.title || t("知识预览", "Source preview")));
    }
    context = `<div class="context-nav-row">${suite.knowledge.workTabs(b)}<div class="context-nav-actions">${dotMatch[3] ? suite.knowledge.headerControls(b) : ""}${b.public ? `<a class="text-link context-public-link" href="#/d/${b.slug}" aria-label="${t("公开页", "Public page")}" title="${t("公开页", "Public page")}">${I("external")}<span>${t("公开页", "Public page")}</span></a>` : ""}</div></div>`;
  } else if (p === "/settings/identity") {
    parts.push(link("/settings?tab=billing", t("余额与计费", "Credits & billing")));
    parts.push(current(t("身份验证", "Identity verification")));
  } else if (p === "/settings") {
    parts.push(current(t("设置", "Settings")));
    context = `<div class="context-nav-row">${settingsHeaderTabs()}</div>`;
  } else if (p === "/chats" && route().query.get("sample") === "scale") {
    parts.push(link("/chats", t("我的对话", "Conversations")));
    parts.push(current(t("规模演示", "Scale demo")));
  } else if (p.startsWith("/chats/")) {
    parts.push(
      link(
        conversationSearchReturnPath(route().query.get("from") || "/chats"),
        t("搜索对话", "Search conversations"),
      ),
    );
    parts.push(
      current(chatById(p.split("/")[2])?.title || t("对话", "Conversation")),
    );
  } else if (p !== root) parts.push(current(crumbFor()));
  return {
    context,
    reeNavigation,
    breadcrumbs: `<nav class="header-breadcrumbs" aria-label="${t("页面路径", "Breadcrumb")}">${parts.map((part, i) => `${i ? I("chevron") : ""}${part}`).join("")}</nav>`,
  };
}
function sidebarToggle() {
  return iconBtn(
    state.sidebarCollapsed ? "panel-open" : "panel-close",
    state.sidebarCollapsed
      ? t("展开侧栏", "Expand sidebar")
      : t("收起侧栏", "Collapse sidebar"),
    "sidebar-collapse",
    `class="sidebar-collapse" aria-controls="sidebar" aria-expanded="${!state.sidebarCollapsed}"`,
  );
}
function userSettingsLink(subtitle) {
  return `<a class="user-settings-link" href="#/settings?tab=account" aria-label="${t("打开账户设置", "Open account settings")}" title="${t("账户设置", "Account settings")}">${suite.profile.avatar("avatar user")}<div class="grow"><strong>${esc(state.displayName || "Yu Zhao")}</strong><p>${subtitle}</p></div></a>`;
}
function sidebarAccountFooter(subtitle) {
  return `<div class="chat-sidebar-footer sidebar-account-footer">${suite.usage.sidebar()}<div class="user-row">${userSettingsLink(subtitle)}${iconBtn("logout", t("退出演示账号", "Sign out of demo"), "logout")}</div></div>`;
}
function shell(content) {
  const p = route().path;
  const header = workspaceHeader();
  return `${suite.conversations.sidebar()}<div class="app-main conversations-shell ${header.context ? "has-context-nav" : ""} ${header.reeNavigation ? "ree-workspace-shell" : ""}"><header class="topbar"><div class="topbar-main"><div class="topbar-location">${iconBtn("menu", t("展开导航", "Open navigation"), "mobile-menu", 'class="mobile-menu icon-btn"')}${sidebarToggle()}${header.reeNavigation}${header.breadcrumbs}</div><div class="topbar-right"><button class="btn ghost sm shell-language" data-action="language" aria-label="${t("切换语言", "Switch language")}">${I("globe")}${state.lang === "zh" ? "中 / EN" : "EN / 中"}</button><a class="text-link shell-site-link" href="#/" style="font-size:11px">${t("返回官网", "Website")} ${I("external")}</a><span class="prototype-badge"><i class="dot"></i> PREVIEW</span>${iconBtn("info", t("原型说明", "Prototype information"), "guide")}</div></div>${header.context}</header><main id="main" tabindex="-1">${content}</main></div>`;
}
function orbitArt() {
  return `<div class="orbit-art" aria-hidden="true"><div class="orbit-grid"></div><div class="orbit-ring"></div><div class="orbit-ring two"></div><div class="orbit-center"><span class="dot-face"><i></i></span></div><span class="orbit-node n1">${I("file")}</span><span class="orbit-node n2">${I("code")}</span><span class="orbit-node n3">${I("audio")}</span><span class="orbit-node n4">${I("globe")}</span><span class="art-caption">YOUR KNOWLEDGE. A NEW VOICE.</span></div>`;
}
function dotCard(b, query = "") {
  const facts = publicDotFacts(b);
  const excerpt =
    b.knowledge[0]?.content ||
    t(
      "从真实的实践与原始资料出发，建立有依据的知识连接。每一次回答都可以追溯到具体来源。",
      "Start with original sources, connect ideas, and trace every answer back to its evidence.",
    );
  return `<article class="dot-card discovery-card" aria-label="${esc(title(b))}">
    ${suite.discoveryCover(b)}
    <p class="description">${esc(desc(b))}</p>
    ${query ? `<p class="match-excerpt">“${esc(excerpt.slice(0, 103))}${excerpt.length > 103 ? "…" : ""}”</p>` : ""}
    <div class="dot-sources">${I("file")}${b.knowledge.length} ${t("个知识来源", "knowledge sources")}<span class="discovery-author">${esc(b.owner === "me" ? state.displayName || "Yu Zhao" : b.owner)}${suite.userRoles.badgeForRee(b)}</span></div>
    <div class="card-actions"><span class="price" title="20 ${t("基本费", "base fee")} + ${b.fee} ${t("查询费", "owner fee")}">${fee(b)}<small>${t("credits / 次", "credits / answer")}</small></span><div class="discovery-card-metrics" role="group" aria-label="${t("Ree 表现", "Ree activity")}"><span><strong>${I("chat")}${n(facts.answers)}</strong><small>${t("累计成功回答", "Successful answers")}</small></span><span><strong>${I("up")}${facts.positiveRate === null ? `<span class="discovery-rating-empty">${t("暂无评价", "No ratings yet")}</span>` : n(facts.positiveRate) + "%"}</strong><small>${t("好评率", "Positive ratings")}</small></span></div></div>
  </article>`;
}
function queryScore(b, q) {
  const hay = [
    b.name,
    b.enName,
    b.description,
    b.enDescription,
    suite.classification.categoryLabel(b),
    ...(b.tags || []),
    ...(b.samples || []),
    ...(b.knowledge || []).map((k) => k.title),
  ]
    .join(" ")
    .toLowerCase();
  const words = q.toLowerCase().match(/[a-z0-9.+#-]+|[\u4e00-\u9fff]+/g) || [];
  const terms = words.flatMap((w) =>
    /[\u4e00-\u9fff]/.test(w)
      ? [
          w,
          ...Array.from({ length: Math.max(0, w.length - 1) }, (_, i) =>
            w.slice(i, i + 2),
          ),
        ]
      : [w],
  );
  const stop = new Set([
    "如何",
    "什么",
    "怎么",
    "一个",
    "哪些",
    "可以",
    "应该",
    "我们",
    "的时",
    "时候",
    "怎样",
    "是否",
    "the",
    "a",
    "how",
    "to",
    "what",
    "is",
    "of",
    "can",
    "do",
    "i",
    "you",
    "and",
  ]);
  const keywords = {
    design: ["设计", "design", "体验", "ux", "规范", "用户"],
    code: [
      "前端",
      "react",
      "next",
      "组件",
      "开发",
      "代码",
      "frontend",
      "css",
      "typescript",
    ],
    growth: [
      "独立",
      "增长",
      "验证",
      "产品",
      "定价",
      "用户",
      "indie",
      "growth",
      "pricing",
    ],
    read: ["阅读", "读书", "笔记", "写作", "学习", "book", "read", "note"],
    brand: ["品牌", "定位", "策略", "视觉", "brand", "identity"],
    ai: ["ai", "rag", "模型", "人工智能", "检索", "切块", "embedding"],
  };
  return (
    terms
      .filter((w) => !stop.has(w) && w.length > 1)
      .reduce((sum, w) => sum + (hay.includes(w) ? 1 : 0), 0) +
    (keywords[b.id] || []).reduce(
      (sum, w) => sum + (q.toLowerCase().includes(w) ? 3 : 0),
      0,
    )
  );
}
function explore() {
  return suite.discovery.page();
}
function ownedDotCard(b) {
  const root = "/dots/" + b.id;
  if (b.ownedDemo) return `<article class="dot-card owned-card creator-dot-card" aria-label="${esc(title(b))}">
    ${suite.discoveryCover(b, { owned: true })}<p class="description">${esc(desc(b))}</p>
    <div class="dot-stats creator-dot-stats"><span>${I("file")}${n(b.knowledge.length)} ${t("个来源", "sources")}</span><span>${I("chat")}${n(b.answers)} ${t("次成功回答", "successful answers")}</span></div>
    <div class="card-actions"><span class="owned-ree-demo-label">${t("测试 Ree · 详情只读", "Test Ree · Read-only details")}</span>${btn(t("查看预览", "Preview") + I("arrow"), "owned-ree-preview", "secondary sm", `data-id="${b.id}"`)}</div></article>`;
  return `<article class="dot-card owned-card creator-dot-card" aria-label="${esc(title(b))}">
    ${suite.discoveryCover(b, { owned: true })}
    <p class="description">${esc(desc(b))}</p>
    <div class="dot-stats creator-dot-stats">
      <a href="#${root}/knowledge" aria-label="${esc(t("管理知识：", "Manage knowledge: ") + title(b))}">${I("file")}${n(b.knowledge.length)} ${t("个来源", "sources")}</a>
      <a href="#${root}/statistics" aria-label="${esc(t("查看使用统计：", "View statistics: ") + title(b))}">${I("chat")}${n(b.answers)} ${t("次成功回答", "successful answers")}</a>
    </div>
    <div class="card-actions"><a class="text-link" href="#${root}/video">${I("film")}${b.video?.generated ? t("编辑视频", "Edit video") : t("制作视频", "Create video")}</a><a class="btn secondary sm" href="#${root}">${t("打开工作台", "Open studio")} ${I("arrow")}</a></div>
  </article>`;
}
function dotsPage() {
  return suite.ownedRees.page();
}
function knowledgeItem(k, b) {
  return `<div class="knowledge-item"><span class="file-icon">${I(kinds[k.kind][2])}</span><div class="grow"><h4>${esc(k.title)}</h4><p>${t(kinds[k.kind][0], kinds[k.kind][1])} · ${esc(k.locator || t("刚刚添加", "Just added"))}</p><span class="status ${k.status}">${k.status === "processing" ? '<i class="spinner" style="width:9px;height:9px"></i>' : '<i class="dot"></i>'}${{ ready: t("已就绪", "Ready"), processing: t("正在处理…", "Processing…"), failed: t("处理失败 · 可重试", "Failed · Retry") }[k.status]}</span>${k.error ? `<p style="color:var(--red)">${esc(k.error)}</p>` : ""}</div><div class="source-actions">${k.status !== "processing" ? iconBtn("refresh", t("重新处理", "Reprocess"), "refresh-source", `data-dot="${b.id}" data-id="${k.id}"`) : ""}${iconBtn("trash", t("删除知识", "Delete source"), "delete-source", `data-dot="${b.id}" data-id="${k.id}"`)}</div></div>`;
}
function messagesForContext(key) {
  if (key.startsWith("chat:")) return chatById(key.slice(5))?.messages || [];
  return state.dotMessages[key] || [];
}
function messageHTML(m) {
  if (m.role === "user")
    return `<div class="message user"><div class="user-bubble">${esc(m.text)}</div></div>`;
  const b = dotById(m.dot);
  if (!b) return "";
  if (m.noAnswer && /^\/dots\/[^/]+\/chat$/.test(route().path))
    return suite.dotConversation.unanswered(m, b);
  if (m.noAnswer && route().path.startsWith("/d/"))
    return suite.publicDot.unanswered(m, b);
  if (m.noAnswer)
    return `<div class="no-answer">${esc(title(b))}：${t("没有相关知识，本次未收费。", "No relevant knowledge. No charge.")} ${
      m.suggestions
        ? `<div class="flex mt16">${publicDots()
            .filter((x) => !m.participants?.includes(x.id))
            .slice(0, 3)
            .map((x) =>
              btn(
                `${I("plus")}${esc(title(x))}`,
                "add-suggestion",
                "secondary sm",
                `data-id="${x.id}" data-chat="${m.chat}"`,
              ),
            )
            .join("")}</div>`
        : ""
    }</div>`;
  const k =
    b.knowledge.find((x) => x.id === m.source) ||
    b.knowledgeTrash?.find((x) => x.id === m.source) ||
    m.citationSnapshot;
  return `<article class="message" data-message="${m.id}"><div class="message-head">${avatar(b, true)}<strong>${esc(title(b))}</strong>${suite.userRoles.badgeForRee(b)}<small>${t("基于知识来源回答", "Grounded in sources")}</small></div><div class="answer-text">${esc(m.text)}${k ? `<button class="citation" data-action="citation" data-dot="${b.id}" data-id="${k.id}" aria-label="${t("查看引用 1", "View citation 1")}">1</button>` : ""}</div>${k ? `<div class="citation-chips"><button class="citation-chip" data-action="citation" data-dot="${b.id}" data-id="${k.id}">${I(kinds[k.kind][2])}<span>1 · ${esc(k.title)} · ${esc(k.locator)}</span>${I("external")}</button></div>` : ""}<div class="message-feedback">${iconBtn("up", t("有用", "Helpful"), "vote", `data-id="${m.id}" data-vote="up" aria-pressed="${m.vote === "up"}" ${m.vote === "up" ? 'style="color:var(--blue);background:var(--soft)"' : ""}`)}${iconBtn("downvote", t("没用", "Not helpful"), "vote", `data-id="${m.id}" data-vote="down" aria-pressed="${m.vote === "down"}" ${m.vote === "down" ? 'style="color:var(--blue);background:var(--soft)"' : ""}`)}${iconBtn("copy", t("复制回答", "Copy answer"), "copy-answer", `data-id="${m.id}"`)}<small>${m.cost || 0} credits · ${t("演示回答", "Demo response")}</small></div></article>`;
}
function chatEmpty(b, key, group = false) {
  return `<div class="chat-empty">${group ? `<span class="dot-avatar">${I("users")}</span>` : avatar(b)}<h2>${group ? t("把不同的知识，带进同一场对话。", "Different knowledge. One conversation.") : esc(t(`你好，我是${title(b)}`, `Hi, I’m ${title(b)}`))}</h2><p>${group ? t("每个 Ree 独立回答它了解的部分。<br>输入 @，也可以只问某一个。", "Each Ree answers from its own knowledge.<br>Use @ to ask one Ree directly.") : esc(desc(b))}</p><div class="sample-questions">${(group
    ? [
        t(
          "搭建设计系统时，设计和前端应该如何协作？",
          "How should designers and developers build a design system together?",
        ),
        t(
          "从想法到上线，需要关注哪些问题？",
          "What should I consider from idea to launch?",
        ),
      ]
    : b.samples || []
  )
    .slice(0, 3)
    .map(
      (s) =>
        `<button class="sample-question" data-action="sample" data-context="${key}" data-value="${esc(s)}">${esc(s)} ${I("arrow")}</button>`,
    )
    .join(
      "",
    )}</div>${!group && !b.knowledge.length ? `<p class="small muted mt16">${t("先添加第一份知识，再开始对话。", "Add your first source to start a conversation.")}</p>` : ""}</div>`;
}
function compose(key, dotIds) {
  const dots = dotIds.map(dotById).filter(Boolean),
    cost = dots.reduce((s, b) => s + fee(b), 0);
  return `<div class="chat-compose"><form class="composer" id="compose" data-context="${key}"><div id="mention-menu"></div><textarea id="message-input" aria-label="${t("输入你的问题", "Your question")}" placeholder="${dots.length > 1 ? t("问问你的知识团队，或输入 @ 指定一个 Ree…", "Ask your knowledge team, or @ a specific Ree…") : t("问一个关于这些知识的问题…", "Ask a question about these sources…")}" rows="2" maxlength="4000" ${ui.busy ? "disabled" : ""}></textarea><div class="compose-tools"><span>${I("sparkle")}<span id="cost-label">${t("最多", "Up to")} <strong>${cost}</strong> credits</span>${dots.length > 1 ? `<span style="margin-left:5px">· @ ${t("指定 Ree", "mention a Ree")}</span>` : ""}</span><button class="btn" type="submit" aria-label="${t("发送问题", "Send question")}" ${ui.busy || !dots.length ? "disabled" : ""}>${ui.busy ? '<i class="spinner"></i>' : I("send")}</button></div></form><p class="compose-note">${t("演示回答，不连接真实模型 · 仅实际作答的 Ree 收费 · Enter 发送，Shift + Enter 换行", "Demo answers · Only answering Rees charge credits · Enter to send, Shift + Enter for a new line")}</p></div>`;
}
function dotStudio(b) {
  const key = "dot:" + b.id;
  const ms = messagesForContext(key);
  return suite.dotConversation.page(b, ms);
}
function chatsPage() {
  return suite.conversations.page();
}
function chatById(id) {
  if (suite?.conversations) return suite.conversations.findChat(id);
  return (
    state.chats.find((c) => c.id === id) ||
    state.chatListDemo?.chats.find((c) => c.id === id)
  );
}

function chatPage(c) {
  return suite.chatRoom.page(c);
}
function settings() {
  ui.settingsTab = selectedSettingsTab();
  return `<div class="page settings-page"><div class="settings-layout"><div class="settings-content">${ui.settingsTab === "role" ? suite.rolePages.settings() : ui.settingsTab === "billing" ? billing() : ui.settingsTab === "connections" ? `<section class="card settings-card"><h2>${t("账号连接", "Connected accounts")}</h2><p class="muted">${t("让 Ree 读取你授权的私有知识。", "Give your Rees access to the private knowledge you authorize.")}</p><div class="settings-row"><div class="flex"><span class="connection-icon">${I("github")}</span><div><h3>GitHub ${state.github ? '<span class="tag green">' + t("已连接", "Connected") + "</span>" : ""}</h3><p>${state.github ? "@yuzhao · " + t("仓库只读权限", "Read-only repository access") : t("连接后可添加和刷新私有仓库", "Connect to add and refresh private repositories")}</p></div></div>${btn(state.github ? t("断开连接", "Disconnect") : t("连接 GitHub", "Connect GitHub"), state.github ? "disconnect-github" : "connect-github", "secondary")}</div><div class="info-strip mt24">${I("shield")}<span>${t("公开仓库无需授权。私有仓库只申请读取权限，断开连接后会停止刷新。", "Public repositories need no authorization. Private access is read-only. Disconnecting stops refreshes.")}</span></div></section><section class="card settings-card"><div class="between"><div><h2>${t("我的域名", "My domains")}</h2><p class="muted small" style="font-size:10px;margin-top:6px">${t("整站抓取前，先验证你拥有这个域名。", "Verify ownership before crawling an entire website.")}</p></div>${btn(`${I("plus")}${t("添加域名", "Add domain")}`, "add-domain", "secondary sm")}</div><div class="mt24">${state.domains.map((d) => `<div class="domain-row"><div><h3>${esc(d.domain)}</h3><small>${d.method === "dns" ? "DNS TXT" : t("验证文件", "Verification file")} · ${t("所有 Ree 可共用", "Shared across your Rees")}</small></div><div class="flex"><span class="tag ${d.status === "verified" ? "green" : "orange"}">${I(d.status === "verified" ? "check" : "clock")}${d.status === "verified" ? t("已验证", "Verified") : t("待验证", "Pending")}</span>${d.status !== "verified" ? btn(t("继续验证", "Verify"), "verify-domain", "secondary sm", `data-value="${esc(d.domain)}"`) : iconBtn("trash", t("移除域名", "Remove domain"), "remove-domain", `data-value="${esc(d.domain)}"`)}</div></div>`).join("") || `<p class="small muted">${t("还没有添加域名。", "No domains added yet.")}</p>`}</div></section>` : `<section class="card settings-card"><h2>${t("个人资料", "Profile")}</h2><form id="profile-form" class="mt24">${suite.profile.editor()}<div class="field"><label for="profile-name">${t("显示名称", "Display name")}</label><input id="profile-name" name="name" value="${esc(ui.profileNameDraft ?? state.displayName ?? "Yu Zhao")}" required maxlength="40"></div>${suite.profile.loginInfo()}<button class="btn" type="submit">${t("保存资料", "Save profile")}</button></form></section><section class="card settings-card"><h2>${t("语言", "Language")}</h2><div class="settings-row"><div><h3>${t("界面语言", "Interface language")}</h3><p>${t("随时切换中文与英文", "Switch between Chinese and English")}</p></div>${btn(state.lang === "zh" ? "English" : "简体中文", "language", "secondary")}</div></section>`}</div></div>${footer()}</div>`;
}
function ledger() {
  ui.billingTab = ["all","spend","income"].includes(route().query.get("activity")) && !(suite.userRoles.roleFor("me") === "official" && route().query.get("activity") === "income") ? route().query.get("activity") : "all";
  const entries = state.entries.filter(e => suite.userRoles.roleFor("me") !== "official" || e.type !== "income").filter(
    (e) =>
      ui.billingTab === "all" ||
      (ui.billingTab === "income"
        ? e.amount > 0 && e.type === "income"
        : e.amount < 0),
  );
  return `<div class="tab-row">${[
    ["all", t("全部明细", "All activity")],
    ["spend", t("消费", "Spending")],
    ["income", t("收入", "Earnings")],
  ]
    .filter(([value]) => value !== "income" || suite.userRoles.roleFor("me") !== "official")
    .map(
      ([v, l]) =>
        `<button data-action="billing-tab" data-value="${v}" class="${ui.billingTab === v ? "active" : ""}">${l}</button>`,
    )
    .join(
      "",
    )}</div><div class="table-wrap"><table><thead><tr><th>${t("事项", "Activity")}</th><th>${t("时间", "Date")}</th><th style="text-align:right">Credits</th></tr></thead><tbody>${
    entries
      .slice(0, 12)
      .map(
        (e) =>
          `<tr><td>${esc(e.title)}</td><td>${esc(e.time)}</td><td class="mono ${e.amount > 0 ? "positive" : "negative"}" style="text-align:right">${e.amount > 0 ? "+" : ""}${n(e.amount)}</td></tr>`,
      )
      .join("") ||
    `<tr><td colspan="3" style="text-align:center;padding:35px">${t("暂无记录", "No activity yet")}</td></tr>`
  }</tbody></table></div>`;
}
function billing() {
  return `<div class="settings-billing ${suite.userRoles.roleFor("me") === "official" ? "official-billing" : ""}"><div class="billing-summary"><span class="billing-total">${t("总余额", "Total balance")}<strong>${n(balance())}</strong><span>credits</span></span></div>${state.welcomeCredits ? `<div class="welcome-credits"><span>${I("sparkle")} ${t("注册赠送额度", "Welcome credits")} · ${n(state.welcomeCredits)} credits</span><span>${t("不过期", "No expiration")}</span></div>` : ""}<div class="billing-balance"><div class="card balance-card"><p class="label">${t("Plan 当期额度", "Plan credits")}<span class="tag blue">${state.plan ? t("按月", "Monthly") : t("未订阅", "Inactive")}</span></p><p class="big-number">${n(state.planCredits)}</p><small>${state.plan ? t("当前演示周期 · 当期有效", "Current demo cycle · Expires at period end") : t("订阅后每期获得 100,000 credits", "Get 100,000 credits each billing cycle")}</small></div><div class="card balance-card"><p class="label">${t("Pack 余额", "Pack credits")}${I("layers")}</p><p class="big-number">${n(state.packCredits)}</p><small>${t("不过期 · 取消 Plan 后仍可使用", "Never expire · Usable after Plan cancellation")}</small></div>${suite.userRoles.roleFor("me") === "official" ? "" : `<div class="card balance-card earned"><p class="label">${t("收入 Credits", "Earned credits")}${I("sparkle")}</p><p class="big-number">${n(state.earnedCredits)}</p><small>${t("不过期 · 可消费，满足条件可提现", "Never expire · Spend or withdraw when eligible")}</small></div>`}</div><div class="billing-plans"><section class="card plan-card primary"><div class="between"><h3>Plan</h3><span class="tag ${state.plan ? "blue" : ""}">${state.plan ? (state.cancelled ? t("周期末取消", "Cancels at period end") : t("当前订阅", "Current plan")) : t("从这里开始", "Start here")}</span></div><p class="plan-price">$10<small> / ${t("月", "month")}</small></p><p>100,000 credits / ${t("计费周期", "billing cycle")}</p><div class="features"><span>${I("check")}${t("创建 Ree、处理知识与提问", "Create Rees, process knowledge, and ask questions")}</span><span>${I("check")}${t("当期额度优先扣减，未使用部分周期末失效", "Plan credits are spent first and expire at period end")}</span><span>${I("check")}${t("随时取消，使用至当前周期结束", "Cancel anytime; keep access until period end")}</span></div>${state.plan ? btn(state.cancelled ? t("恢复续费", "Resume renewal") : t("管理订阅", "Manage subscription"), "manage-plan", "secondary") : btn(t("订阅 Plan · $10 / 月", "Subscribe · $10 / month"), "checkout", "", 'data-kind="plan"')}</section><section class="card plan-card"><div class="between"><h3>Pack</h3><span class="tag">${t("按需补充", "On demand")}</span></div><p class="plan-price">$10<small> / ${t("份", "pack")}</small></p><p>100,000 credits / ${t("份，可多次购买", "pack, buy as needed")}</p><div class="features"><span>${I("check")}${t("一次购买，永久有效", "One-time purchase, no expiration")}</span><span>${I("check")}${t("只有有效 Plan 订阅者可以购买", "Available with an active Plan subscription")}</span><span>${I("check")}${t("已有 Pack 在 Plan 取消后仍然有效", "Purchased credits remain after Plan cancellation")}</span></div>${btn(state.plan ? t("购买 Pack · $10", "Buy a pack · $10") : t("先订阅 Plan，即可购买", "Subscribe to Plan to unlock"), "checkout", "secondary", `data-kind="pack" ${state.plan ? "" : "disabled"}`)}</section></div><div class="info-strip mt24">${I("info")}<span>${t("1 credit = $0.0001。每个成功作答的 Ree 收取 20 credits 基本使用费；他人的 Ree 另加其设定的查询费。知识处理每 1,000 字符 1 credit，音频转写每分钟另加 100 credits。", "1 credit = $0.0001. Each answering Ree costs 20 credits plus its owner’s query fee. Knowledge costs 1 credit / 1,000 characters; audio adds 100 credits / minute.")}</span></div><section class="card mt32" id="credit-activity"><div class="between" style="padding:22px 24px 0"><h2 class="section-title" style="font-size:15px">${t("收支明细", "Credit activity")}</h2><span class="tiny muted">${t("先扣 Plan，再扣 Pack 与收入", "Plan credits are spent first")}</span></div>${ledger()}</section><div class="between mt32 mb16"><h2 class="section-title" style="font-size:17px">${t("让知识的价值，回到你手中。", "Let the value of your knowledge come back to you.")}</h2></div>${suite.userRoles.roleFor("me") === "official" ? suite.rolePages.officialNotice() : suite.manualKyc.userCard()}</div>`;
}
function publicPage(b) {
  return suite.publicDot.page(b);
}

function loginPage() {
  return `<main class="login-page" id="main"><section class="login-visual">${wordmark()}<div><p class="eyebrow" style="color:#788db6;margin-bottom:23px">KNOWLEDGE FINDS ITS VOICE.</p><h1>${t("一些知识，<br>一个 Ree，<br><span>无限种对话的可能。</span>", "A little knowledge.<br>A Ree of your own.<br><span>Conversations that matter.</span>")}</h1>${orbitArt()}</div><p>© 2026 RE0 · YOUR KNOWLEDGE. A NEW VOICE.</p></section><section class="login-form-side"><div class="login-form"><p class="eyebrow">WELCOME TO RE0</p><h2>${t("让知识，开口回答。", "Give knowledge a voice.")}</h2><p>${t("登录，创建你的第一个 Ree。<br>把你的知识，变成可以对话的伙伴。", "Sign in and create your first Ree.<br>Make your knowledge a companion you can talk to.")}</p><div class="oauth-buttons">${btn('<span style="font-size:18px;font-weight:650;color:#4285f4">G</span>' + t("使用 Google 继续", "Continue with Google"), "sign-in", "secondary full", 'data-provider="Google"')}${btn(I("github") + t("使用 GitHub 继续", "Continue with GitHub"), "sign-in", "secondary full", 'data-provider="GitHub"')}</div><div class="login-benefit">${I("sparkle")}${t("新用户赠送 2,000 credits，开始你的探索。", "New users get 2,000 credits to get started.")}</div><p class="legal">${t("继续即表示你同意", "By continuing you accept our")} <button class="text-link" style="font-size:9px" data-action="legal" data-value="terms">${t("服务条款", "Terms")}</button> ${t("及", "and")} <button class="text-link" style="font-size:9px" data-action="legal" data-value="privacy">${t("隐私政策", "Privacy")}</button>。</p><p class="login-demo-note">${t("设计原型 · 点击后进入本地演示账号，不会连接真实 OAuth 服务。", "Design prototype · Sign-in opens a local demo account without contacting OAuth services.")}</p><div class="back"><a class="text-link" style="font-size:10px" href="#/explore">${t("先去逛逛，发现 Ree", "Explore Rees first")} ${I("arrow")}</a></div></div></section></main>`;
}
function render() {
  const draftInput = $("#message-input"),
    draftForm = $("#compose");
  if (draftInput && draftForm && !ui.busy) {
    ui.chatDrafts ??= {};
    ui.chatDrafts[draftForm.dataset.context] = draftInput.value;
  }
  const { path, query } = route();
  const fullPage = suite?.resolve(path, query);
  if (fullPage?.redirect) {
    go(fullPage.redirect);
    return;
  }
  if (fullPage?.html !== undefined) {
    $("#app").innerHTML = fullPage.html;
    document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
    document.title = (fullPage.title || "RE0") + " · RE0";
    syncPanels();
    suite.afterRender();
    return;
  }
  if (
    !state.signed &&
    !["/explore", "/login"].includes(path) &&
    !path.startsWith("/d/")
  ) {
    go("/login?next=" + encodeURIComponent(path));
    return;
  }
  let html;
  if (path === "/login") html = loginPage();
  else if (path.startsWith("/d/")) {
    const b = publicDotBySlug(path.split("/")[2]);
    html = b ? publicPage(b) : shell(notFound());
  } else {
    let body;
    if (path === "/explore" || path === "/") body = explore();
    else if (path === "/dots") body = dotsPage();
    else if (path.startsWith("/dots/")) {
      const b = dotById(path.split("/")[2]);
      body = b && b.owner === "me" && path === "/dots/" + b.id + "/chat" ? dotStudio(b) : notFound();
    } else if (path === "/chats") body = chatsPage();
    else if (path.startsWith("/chats/")) {
      const c = chatById(path.split("/")[2]);
      body = c ? chatPage(c) : notFound();
    } else if (path === "/settings") body = settings();
    else body = notFound();
    html = shell(body);
  }
  $("#app").innerHTML = html;
  document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
  const publicDot = path.startsWith("/d/")
    ? publicDotBySlug(path.split("/")[2])
    : null;
  document.title = `${publicDot ? title(publicDot) : path === "/login" ? t("登录", "Sign in") : crumbFor()} · RE0`;
  if (!state.signed && path === "/explore") {
    $(".user-row").innerHTML =
      `<a class="btn full" href="#/login">${t("登录 / 注册", "Sign in / Sign up")}${I("arrow")}</a>`;
    if ($(".credit-mini")) $(".credit-mini").innerHTML =
      `<p style="font-size:11px">${t("让知识，开口回答。", "Give knowledge a voice.")}</p><p class="tiny muted mt16">${t("注册即赠 2,000 credits。", "Start with 2,000 free credits.")}</p>`;
  }
  if (
    $("#compose") &&
    $("#message-input") &&
    !ui.busy &&
    ui.chatDrafts?.[$("#compose").dataset.context]
  )
    $("#message-input").value = ui.chatDrafts[$("#compose").dataset.context];
  if ($("#prefill") && $("#message-input"))
    $("#message-input").value = $("#prefill").value;
  if (
    $("#transcript") &&
    messagesForContext($("#compose")?.dataset.context || "").length
  )
    $("#transcript").scrollTop = $("#transcript").scrollHeight;
  syncPanels();
  suite?.afterRender();
}
function notFound() {
  return `<div class="page"><div class="card empty">${I("compass")}<h3>${t("这个页面，暂时不在知识范围内。", "This page is outside our knowledge.")}</h3><p>${t("链接可能已失效，或 Ree 已设为私有。", "The link may be unavailable, or this Ree may now be private.")}</p><a class="btn" href="#/explore">${t("回到发现", "Back to discover")}</a></div></div>`;
}

// Interaction implementation follows. Every external service is simulated locally.
let lastFocus, toastTimer, confirmCallback;
function toast(message) {
  clearTimeout(toastTimer);
  $("#toast-root").innerHTML =
    `<div class="toast">${I("check")}<span>${esc(message)}</span></div>`;
  toastTimer = setTimeout(() => ($("#toast-root").innerHTML = ""), 3500);
}
function modal(heading, subheading, body, actions = "", opts = {}) {
  if (!$("#overlay-root").firstElementChild) lastFocus = document.activeElement;
  $("#overlay-root").innerHTML =
    `<div class="overlay-backdrop ${opts.drawer ? "drawer-backdrop" : ""}" data-backdrop="true"><section class="modal ${opts.drawer ? "drawer" : ""} ${opts.wide ? "wide" : ""} ${opts.video ? "video-intro-modal" : ""}" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1"><header class="modal-head"><div><h2 id="dialog-title">${heading}</h2>${subheading ? `<p>${subheading}</p>` : ""}</div>${iconBtn("close", t("关闭", "Close"), "close-modal")}</header><div class="modal-body">${body}</div>${actions ? `<footer class="modal-footer">${actions}</footer>` : ""}</section></div>`;
  document.body.style.overflow = "hidden";
  queueMicrotask(() =>
    (
      (opts.video && $(".modal-head .icon-btn")) ||
      $(".modal input:not([type=checkbox]):not([type=hidden]):not([type=file]):not([hidden])") ||
      $(".modal .icon-btn") ||
      $(".modal")
    ).focus(),
  );
}
function closeModal() {
  if (!$("#overlay-root").firstElementChild) return;
  $("#overlay-root").innerHTML = "";
  document.body.style.overflow = "";
  ui.modal = null;
  lastFocus?.isConnected && lastFocus.focus();
}
function cancelButton() {
  return btn(t("取消", "Cancel"), "close-modal", "secondary");
}
function submitButton(text, form) {
  return `<button class="btn" type="submit" form="${form}">${text}</button>`;
}
function formError(text) {
  const form = $(".modal form");
  if (!form) {
    toast(text);
    return;
  }
  $(".form-error", form)?.remove();
  form.insertAdjacentHTML(
    "afterbegin",
    `<div class="form-error" role="alert">${esc(text)}</div>`,
  );
}
function confirmModal(heading, text, label, callback, danger = false) {
  confirmCallback = callback;
  modal(
    heading,
    "",
    `<p class="form-hint">${text}</p>`,
    cancelButton() + btn(label, "confirm-action", danger ? "danger" : ""),
  );
}
function requireLogin(next = route().path) {
  if (state.signed) return true;
  go("/login?next=" + encodeURIComponent(next));
  return false;
}
function createDotModal() {
  if (requireLogin("/dots/new")) go("/dots/new");
}
function dotSettingsModal(b) {
  if (b?.owner === "me") go("/dots/" + b.id + "/settings");
}
function addKnowledgeModal(dotId, kind = "document") {
  ui.modal = { type: "knowledge", dot: dotId };
  ui.addKind = kind;
  ui.selectedFile = null;
  const verified = state.domains.filter((d) => d.status === "verified");
  let input = "";
  if (kind === "document" || kind === "audio")
    input = `<label class="dropzone" id="dropzone">${I(kind === "audio" ? "audio" : "upload")}<strong id="file-label">${t("点击选择，或拖动文件到这里", "Choose a file or drop it here")}</strong><small>${kind === "audio" ? "MP3 / M4A / WAV · 100 MB" : "PDF / DOCX / MD / TXT · 20 MB"}</small><input type="file" id="knowledge-file" accept="${kind === "audio" ? ".mp3,.m4a,.wav" : ".pdf,.docx,.md,.txt"}"></label>${kind === "audio" ? `<div class="info-strip mt16">${I("info")}<span>${t("真实产品会将音频发送至第三方转写服务。原型只模拟处理，不上传你的文件。", "The real product sends audio to a transcription service. This prototype only simulates processing and never uploads files.")}</span></div><label class="check-row" style="font-size:10px"><input type="checkbox" name="audio-consent" required>${t("我了解音频需要发送给转写服务", "I understand audio requires third-party transcription")}</label>` : ""}`;
  else if (kind === "text")
    input = `<div class="field"><label for="source-title">${t("标题", "Title")}</label><input id="source-title" name="title" required maxlength="100" placeholder="${t("给这份知识起一个名字", "Name this source")}"></div><div class="field"><label for="source-text">${t("知识内容", "Content")}</label><textarea id="source-text" name="content" placeholder="${t("粘贴你的笔记、经验或任何值得被记住的知识…", "Paste notes, experience, or knowledge worth remembering…")}" rows="6" maxlength="30000" required></textarea></div>`;
  else
    input = `<div class="field"><label for="source-url">${kind === "github" ? t("仓库地址", "Repository URL") : kind === "site" ? t("网站根地址或路径前缀", "Website root or path prefix") : t("网页地址", "Page URL")}</label><input id="source-url" name="url" type="url" required placeholder="${kind === "github" ? "https://github.com/owner/repo" : kind === "site" ? "https://docs.example.com" : "https://example.com/article"}"></div>${kind === "github" ? `<label class="check-row" style="font-size:11px"><input type="checkbox" name="private" id="private-repo">${t("这是一个私有仓库", "This is a private repository")}</label><p class="form-hint mt16">${state.github ? t("GitHub 已连接，可模拟添加有权限的私有仓库。", "GitHub connected. You can simulate adding authorized private repositories.") : t("私有仓库需要先在设置中连接 GitHub。公开仓库无需授权。", "Connect GitHub in Settings for private repositories. Public repositories need no authorization.")} <a class="text-link" href="#/settings">${t("管理连接", "Connections")} ${I("arrow")}</a></p>` : kind === "site" ? `<div class="info-strip">${I("shield")}<span>${t("整站抓取最多 500 页，添加前需要验证域名。", "Crawls up to 500 pages. Verify the domain before adding.")}<br>${verified.length ? t("已验证：", "Verified: ") + verified.map((d) => esc(d.domain)).join(", ") : t("还没有已验证域名。", "No verified domains yet.")} <a class="text-link" href="#/settings">${t("去确权", "Verify domain")} ${I("arrow")}</a></span></div>` : `<p class="form-hint">${t("只读取这一页，无需域名确权。", "Only this page is read. Domain verification is not required.")}</p>`}`;
  modal(
    t("给 Ree 一些知识。", "Give your Ree some knowledge."),
    t(
      "每一份来源，都是回答的依据。",
      "Every source is a foundation for an answer.",
    ),
    `<div class="type-grid">${Object.entries(kinds)
      .map(
        ([key, [zh, en, ic]]) =>
          `<button class="type-choice ${key === kind ? "active" : ""}" data-action="knowledge-type" data-value="${key}">${I(ic)}${t(zh, en)}</button>`,
      )
      .join(
        "",
      )}</div><form id="knowledge-form" data-dot="${dotId}">${input}<div class="estimate"><span>${t("预计处理费用", "Estimated processing cost")}</span><strong id="estimate-value">${kind === "audio" ? "~ 300" : kind === "site" ? "~ 500" : kind === "github" ? "~ 120" : "~ 20"} credits</strong></div><p class="form-hint mt16" style="font-size:9px">${t("费用预估后冻结，按实际文本量结算；失败全额退回。原型仅保存文件名称和少量文本，不会上传、抓取或转写。", "Credits are reserved, then settled; failures are refunded. This prototype stores names and short text only. No upload, crawling, or transcription occurs.")}</p></form>`,
    cancelButton() +
      submitButton(t("添加并处理", "Add & process"), "knowledge-form"),
  );
}
function findChatsForInvite(b) {
  return state.chats.filter((c) => !c.dots.includes(b.id) && c.dots.length < 5);
}
function inviteModal(b) {
  if (!b || b.discoveryDemo || b.ownedDemo) return toast(t("这是测试 Ree，请从原有 Ree 中选择知识伙伴。", "This is a test Ree. Choose one of your existing companions."));
  if (!requireLogin(suite.publicDot.path(b))) return;
  ui.modal = { type: "invite", dot: b.id };
  const cs = findChatsForInvite(b);
  modal(
    t("把它，带进对话。", "Bring this Ree into a conversation."),
    `${esc(title(b))} · ${fee(b)} credits / ${t("成功回答", "successful answer")}`,
    `<div class="flex mb16">${avatar(b)}<div><strong style="font-size:13px">${esc(title(b))}</strong><p class="small muted" style="font-size:10px">${esc(desc(b))}</p></div></div>${cs.length ? `<div class="stack">${cs.map((c) => btn(`${I("chat")}<span class="grow" style="text-align:left">${esc(c.title)}</span><small>${c.dots.length}/5</small>`, "invite-existing", "secondary full", `data-chat="${c.id}" data-id="${b.id}"`)).join("")}</div><div class="rule"></div>` : `<p class="form-hint mb16">${t("每场对话最多 5 个 Ree，已加入或已满的对话不会显示。", "Chats already containing this Ree, or with 5 participants, are omitted.")}</p>`}${btn(`${I("plus")}${t("新建一场对话", "Start a new conversation")}`, "invite-new", "full", `data-id="${b.id}"`)}`,
    cancelButton(),
  );
}
function pickDotsModal(chatId = null, preselected = []) {
  if (!requireLogin("/chats")) return;
  const chat = chatById(chatId);
  ui.selectedDots = chat ? [...chat.dots] : [...preselected];
  ui.modal = { type: "pick", chat: chatId };
  const bs = [...mine(), ...publicDots()];
  modal(
    t(
      chat ? "邀请更多知识同伴" : "开始一场新的对话",
      chat ? "Invite more companions" : "Start a new conversation",
    ),
    t(
      "最多选择 5 个 Ree。每个 Ree 独立回答它了解的部分。",
      "Choose up to 5 Rees. Each answers from its own sources.",
    ),
    `<form id="pick-dots-form" data-chat="${chatId || ""}">${!chat ? `<div class="field"><label for="chat-title">${t("对话名称", "Conversation title")}</label><input id="chat-title" name="title" maxlength="60" placeholder="${t("例如：下一次产品灵感讨论", "e.g. Ideas for our next product")}"></div>` : ""}<div style="max-height:350px;overflow-y:auto">${bs.map((b) => `<label class="check-row">${avatar(b, true)}<div class="grow"><strong>${esc(title(b))}</strong><p><small>${fee(b)} credits / ${t("次", "answer")}${b.owner === "me" ? " · " + t("我的 Ree", "My Ree") : ""}</small></p></div><input type="checkbox" name="dots" value="${b.id}" ${ui.selectedDots.includes(b.id) ? "checked" : ""}></label>`).join("")}</div><div class="estimate"><span id="selection-count">${ui.selectedDots.length} / 5 ${t("个 Ree", "Rees")}</span><strong id="selection-cost">${ui.selectedDots.map(dotById).reduce((s, b) => s + fee(b), 0)} credits ${t("/ 次最多", "maximum / question")}</strong></div></form>`,
    cancelButton() +
      submitButton(
        t(
          chat ? "更新参与者" : "创建对话",
          chat ? "Update participants" : "Create conversation",
        ),
        "pick-dots-form",
      ),
    { wide: true },
  );
}
function citationModal(b, k) {
  if (route().path.startsWith("/d/") && !state.signed) {
    go("/login?next=" + encodeURIComponent(route().path));
    return;
  }
  const text =
    k.content ||
    t(
      "这是一段用于展示引用交互的演示摘录。真实产品会从该知识来源的命中段落中提取正文，并显示对应页码、时间戳或文件行号。\n\n每一个回答都应当能够追溯到具体的知识来源。",
      "This is a sample passage for the citation interaction. The real product retrieves a matching passage and its page, timestamp, or source-code lines.\n\nEvery answer should trace back to a specific source.",
    );
  modal(
    t("答案，从这里来。", "Here is where the answer comes from."),
    esc(k.title),
    `<div class="source-meta">${I(kinds[k.kind][2])}${t(kinds[k.kind][0], kinds[k.kind][1])}<span>·</span>${esc(k.locator)}</div><div class="citation-preview">${esc(text)}</div><div class="info-strip mt24">${I("info")}<span>${t("这是与当前回答关联的引用片段，不是完整知识正文。音频引用显示时间戳，代码引用显示文件与行号。", "This is an answer-linked excerpt, not the entire source. Audio uses timestamps; code uses file paths and line numbers.")}</span></div><div class="flex mt24">${avatar(b, true)}<span class="small muted" style="font-size:10px">${esc(title(b))} · ${t("来源 1", "Source 1")}</span></div>`,
    btn(
      `${I("copy")}${t("复制引用", "Copy excerpt")}`,
      "copy-citation",
      "secondary",
      `data-dot="${b.id}" data-id="${k.id}"`,
    ),
    { drawer: true },
  );
}
function domainModal(domain = "", method = "dns") {
  ui.modal = { type: "domain", domain, method };
  const challenge =
    "re0-verification=demo_" +
    (domain || "your-domain").replace(/[^a-zA-Z0-9]/g, "").slice(0, 20);
  modal(
    domain
      ? t("验证你的域名", "Verify your domain")
      : t("连接你的整个知识世界。", "Connect a world of knowledge."),
    t(
      "一个域名只需验证一次，你的所有 Ree 都能使用。",
      "Verify a domain once and share it across all your Rees.",
    ),
    `${!domain ? `<form id="domain-form"><div class="field"><label for="domain-name">${t("域名", "Domain")}</label><input id="domain-name" name="domain" placeholder="docs.example.com" required maxlength="253"><small>${t("只输入域名，不需要 https:// 或路径。", "Enter only the domain, without https:// or a path.")}</small></div></form>` : `<p class="mono small mb16">${esc(domain)}</p><div class="radio-tabs"><button class="${method === "dns" ? "active" : ""}" data-action="domain-method" data-value="dns">DNS TXT</button><button class="${method === "file" ? "active" : ""}" data-action="domain-method" data-value="file">${t("验证文件", "Verification file")}</button></div><p class="form-hint mb16">${method === "dns" ? t("在域名管理后台添加以下 TXT 记录。", "Add the following TXT record in your DNS settings.") : t("在站点指定路径放置包含验证内容的文件。", "Place a verification file at the following path.")}</p><div class="code-block">${method === "dns" ? `Host: _re0.${esc(domain)}\nType: TXT\nValue: ${challenge}` : `https://${esc(domain)}/.well-known/re0-verification.txt\n\n${challenge}`}</div>${btn(I("copy") + t("复制验证内容", "Copy verification value"), "copy-domain", "secondary full mt16", `data-value="${challenge}"`)}<label class="check-row mt16" style="font-size:11px"><input id="domain-demo-check" type="checkbox">${t("模拟：我已添加正确的验证记录", "Simulate: I have added the correct verification record")}</label><div class="demo-label mt16">${t("本原型不会查询 DNS 或访问网站。勾选后可模拟验证成功；不勾选可体验失败状态。", "This prototype does not query DNS or websites. Check the box for a simulated success; leave it unchecked to see failure.")}</div><div id="domain-error"></div>`}`,
    cancelButton() +
      (!domain
        ? submitButton(t("下一步", "Continue"), "domain-form")
        : btn(t("验证域名", "Verify domain"), "check-domain")),
  );
}
function checkoutModal(kind) {
  if (kind === "pack" && !state.plan) {
    toast(
      t(
        "需要有效的 Plan 订阅才能购买 Pack",
        "An active Plan is required to buy a pack",
      ),
    );
    return;
  }
  ui.modal = { type: "checkout", kind };
  modal(
    t("为下一次好奇，准备一些 Credits。", "Credits for your next question."),
    t(
      "本地支付流程演示，不会产生扣款。",
      "Local payment simulation. You will not be charged.",
    ),
    `<form id="checkout-form" data-kind="${kind}"><div class="between"><div><h3>${kind === "plan" ? "Plan" : "Pack"}</h3><p class="small muted mt16">100,000 credits${kind === "plan" ? " / " + t("计费周期", "billing cycle") : ""}</p></div><strong class="mono" style="font-size:29px">$10<span class="small muted">${kind === "plan" ? t("/月", "/mo") : ""}</span></strong></div><div class="rule"></div><p class="form-hint">${t("正式产品会前往 Paddle 托管结账，由 Paddle 处理开票与税费。此处只模拟支付成功状态。", "The real product opens Paddle-hosted checkout with invoicing and tax handled by Paddle. This is a success-state simulation.")}</p><label class="check-row mt16" style="font-size:11px"><input type="checkbox" required name="confirm">${t("我知道这是模拟充值，不会真实付款", "I understand this is a simulation with no real payment")}</label></form>`,
    cancelButton() +
      submitButton(
        t("模拟支付成功", "Simulate successful payment"),
        "checkout-form",
      ),
  );
}
function paypalModal() {
  if (state.kyc !== "verified")
    return toast(t("请先完成身份验证", "Complete identity verification first"));
  modal(
    t("设置你的收款方式", "Set up your payout method"),
    t("通过 PayPal 以美元收款。", "Receive USD payouts through PayPal."),
    `<form id="paypal-form"><div class="field"><label for="paypal-email">${t("PayPal 收款邮箱", "PayPal email")}</label><input id="paypal-email" name="email" type="email" value="${esc(state.paypal || "creator@example.com")}" required maxlength="254"></div><div class="info-strip">${I("shield")}<span>${t("首次绑定后可申请提现；更换邮箱后 7 天内不可提现。原型请使用演示邮箱，不填写真实收款资料。", "Your first email can be used immediately. Changing it starts a 7-day hold. Use a demo email here.")}</span></div></form>`,
    cancelButton() +
      submitButton(t("保存收款邮箱", "Save payout email"), "paypal-form"),
  );
}
function payoutModal() {
  if (
    state.kyc !== "verified" ||
    !state.paypal ||
    state.earnedCredits < 500000 ||
    state.payouts.some(activePayout) ||
    Date.now() - state.paypalChanged < 7 * 86400000
  )
    return toast(
      t(
        "尚未满足提现条件，请检查身份、邮箱、余额与冷静期",
        "Check verification, email, balance, and payout hold requirements",
      ),
    );
  modal(
    t("申请收入提现", "Request a payout"),
    t(
      "提交后收入 credits 会立即冻结，等待审核。",
      "Earnings are held immediately while the request is reviewed.",
    ),
    `<form id="payout-form"><div class="field"><label for="payout-credits">${t("提现 Credits", "Credits to withdraw")}</label><input type="number" id="payout-credits" name="credits" min="500000" max="${state.earnedCredits}" step="1" value="${state.earnedCredits}" required><small>500,000 credits = $50.00</small></div><div class="estimate"><span>${t("收款邮箱", "PayPal email")}</span><strong>${esc(state.paypal)}</strong></div><div class="info-strip mt16">${I("info")}<span>${t("PayPal 手续费从打款金额中扣除，实际金额以处理结果为准。驳回或失败会解冻并退回全部 credits。此处不会真实转账。", "PayPal fees are deducted from the payout. Rejection or failure releases all held credits. No real money moves here.")}</span></div></form>`,
    cancelButton() +
      submitButton(t("提交模拟申请", "Submit demo request"), "payout-form"),
  );
}
function guideModal() {
  return suite.guide();
}

function contextDots(key) {
  if (key === suite?.chatRoom.draftContext)
    return suite.chatRoom.draftChat().dots.map(dotById).filter(Boolean);
  if (key.startsWith("chat:"))
    return chatById(key.slice(5))?.dots.map(dotById).filter(Boolean) || [];
  return [dotById(key.split(":")[1])].filter(Boolean);
}
function resolveTargetDots(key, text) {
  if (key === suite?.chatRoom.draftContext)
    return suite.chatRoom.targets(suite.chatRoom.draftChat(), text);
  if (key.startsWith("chat:"))
    return suite.chatRoom.targets(chatById(key.slice(5)), text);
  const bs = contextDots(key);
  if (!text.includes("@")) return bs;
  return bs.filter(
    (b) =>
      text.includes("@" + b.name) ||
      text.includes("@" + title(b)) ||
      text.includes("@" + b.enName),
  );
}
function getMessages(key) {
  if (key.startsWith("chat:")) return chatById(key.slice(5))?.messages;
  return state.dotMessages[key] || (state.dotMessages[key] = []);
}
function creditEntry(title, amount, type) {
  state.entries.unshift({ title, amount, type, time: t("刚刚", "Just now"), createdAt: new Date().toISOString() });
}
function takeCredits(amount) {
  if (balance() < amount) return null;
  const allocations = {};
  let remaining = amount;
  for (const key of [
    "planCredits",
    "welcomeCredits",
    "packCredits",
    "earnedCredits",
  ]) {
    const used = Math.min(state[key], remaining);
    state[key] -= used;
    allocations[key] = used;
    remaining -= used;
    if (!remaining) break;
  }
  return allocations;
}
function releaseCredits(
  allocations,
  amount = Object.values(allocations).reduce((s, v) => s + v, 0),
) {
  let remaining = amount;
  for (const key of [
    "earnedCredits",
    "packCredits",
    "welcomeCredits",
    "planCredits",
  ]) {
    const returned = Math.min(allocations[key] || 0, remaining);
    state[key] += returned;
    remaining -= returned;
    if (!remaining) break;
  }
}
function debit(amount) {
  const allocations = takeCredits(amount);
  ui.lastDeduction = allocations;
  return !!allocations;
}
function answerFor(b, q) {
  const en = state.lang === "en";
  if (b.id === "mine" && /credit|费用|收费|计费|Plan|Pack/i.test(q))
    return en
      ? "Each Ree that successfully answers costs 20 base credits. Public Rees may add an owner query fee. Your own Ree only charges the base fee.\n\nPlan includes 100,000 credits per cycle for $10, expiring at cycle end. A $10 Pack adds 100,000 non-expiring credits and requires an active Plan. Rees that cannot answer do not charge."
      : "每个成功作答的 Ree 收取 20 credits 基本使用费。提问他人的 Ree 时，再加上 Ree 主设定的查询费；问自己的 Ree 只收基本使用费。\n\nPlan 每月 $10，提供当期有效的 100,000 credits。Pack 每份 $10，提供永久有效的 100,000 credits，需要有效 Plan 才能购买。没有相关知识的 Ree 不作答，也不收费。";
  if (b.id === "mine")
    return en
      ? "RE0 supports six knowledge sources: documents (PDF, Word, Markdown, TXT), audio, GitHub repositories, individual pages, entire websites, and pasted text.\n\nPublic repositories and individual pages need no verification. Private repositories require GitHub authorization; entire websites require verified domain ownership. Every successful answer includes citations to its source."
      : "RE0 支持六种知识来源：文档（PDF、Word、Markdown、TXT）、音频、GitHub 仓库、单个网页、整站，以及粘贴文本。\n\n公开仓库和单个网页无需确权。私有仓库需要连接 GitHub 授权，整站抓取则需要先验证域名。处理完成后，Ree 只基于这些知识作答，并在回答中附上来源引用。";
  const latest = b.knowledge.find(
    (k) =>
      k.kind === "text" &&
      k.content &&
      k.status === "ready" &&
      k.enabled !== false,
  );
  if (latest && b.owner === "me")
    return en
      ? `Based on “${latest.title}”, here is the relevant source excerpt:\n\n${latest.content.slice(0, 420)}\n\nThis prototype demonstrates source-based answers and citations; it does not run semantic retrieval or a language model.`
      : `根据「${latest.title}」，这里是与你的提问关联的知识片段：\n\n${latest.content.slice(0, 420)}\n\n原型用于演示基于知识回答和引用的交互，未运行语义检索或真实模型。`;
  const responses = {
    design: [
      "搭建设计系统，可以从「共同语言」开始，而不是急着收集组件。\n\n先统一颜色、字体、间距等基础变量，再沉淀按钮、输入框和导航等高频组件。每个组件都需要明确使用场景、交互状态和无障碍要求。\n\n建议从一个真实页面试用，让设计与开发一起验证，再逐步扩展。",
      "Start with a shared language: colors, typography, and spacing. Then define frequently used components, their states, and accessibility requirements.\n\nValidate the system on a real screen with both designers and developers before expanding it.",
    ],
    code: [
      "可以把设计规范中的颜色、间距与圆角映射为 CSS 自定义属性，再由组件统一引用。\n\n在 React 中，让组件接口围绕明确的使用场景设计，避免堆叠过多布尔属性。按钮、弹层和表单还应包含键盘操作、焦点管理与状态反馈。",
      "Map design tokens to CSS custom properties and use them consistently across components.\n\nKeep React component APIs focused on clear use cases. Include keyboard support, focus management, and meaningful state feedback for buttons, dialogs, and forms.",
    ],
    growth: [
      "先确认问题真实存在，再投入完整的产品开发。\n\n找 5–10 位目标用户，了解他们最近一次遇到这个问题的具体经历。用一个小原型验证核心路径，观察他们是否愿意投入时间，或为结果付费。\n\n把每次实验的假设、结果和下一步记下来。",
      "Validate the problem before building the whole product. Talk to 5–10 potential users about a recent, concrete experience.\n\nTest the core flow with a small prototype. Observe whether they invest time or pay for the outcome. Record the hypothesis, result, and next step for each experiment.",
    ],
    read: [
      "让笔记成为自己的思考，而不只是书中原句的存档。\n\n每张笔记只写一个想法，用自己的话说明，再补上它与已有知识的连接。保留书名与章节，方便日后回到原始语境。\n\n最有价值的复习，是把一个想法应用到真实的问题里。",
      "Make notes a form of thinking, rather than an archive of quotations.\n\nCapture one idea per note in your own words, connect it to existing ideas, and keep the source and chapter. The most useful review applies an idea to a real problem.",
    ],
    brand: [
      "品牌定位可以从三个问题开始：为谁服务、解决什么问题、为什么相信你。\n\n先用一句清晰的话表达差异，再把它延伸到品牌语气、视觉规范与具体触点。真实、一致的表达，比追逐短期的视觉流行更有帮助。",
      "Start with three questions: who do you serve, what problem do you solve, and why should people trust you?\n\nExpress the difference in one clear sentence, then extend it into voice, visual guidelines, and touchpoints. Consistency and authenticity matter.",
    ],
    ai: [
      "提升知识问答质量，先从来源质量和引用链路入手。\n\n切块时保留标题、段落和来源定位，检索后检查是否真的命中问题。没有相关知识时明确拒答，避免模型用通用知识填空。\n\n可以用一组真实问题，分别评估检索命中率、回答准确率与引用正确性。",
      "Improve source quality and traceable citations first. Preserve headings, paragraph boundaries, and source locations during chunking.\n\nCheck whether retrieval actually supports the question. When evidence is missing, decline to answer. Evaluate retrieval, correctness, and citation quality separately.",
    ],
  };
  return (responses[b.id] || [
    t(
      "这份知识提到了信息之间的连接与实践。你可以点击引用，回到原始段落查看更完整的内容。",
      "This source discusses connecting ideas and putting them into practice. Open the citation to see the original passage.",
    ),
    "This source discusses connecting ideas and putting them into practice. Open the citation for context.",
  ])[en ? 1 : 0];
}
async function sendMessage(key, text) {
  text = text.trim();
  if (!text || ui.busy) return;
  if (state.disabled) {
    toast(
      t(
        "账号已停用，暂时无法提问。",
        "This account is disabled and cannot ask questions.",
      ),
    );
    return;
  }
  if (
    !requireLogin(
      route().path +
        (key.startsWith("public:") ? "?q=" + encodeURIComponent(text) : ""),
    )
  )
    return;
  const bs = resolveTargetDots(key, text);
  if (!bs.length) {
    toast(
      t(
        "请选择参与者，或使用完整的 @Ree 名称",
        "Choose a participant or use a complete @Ree name",
      ),
    );
    return;
  }
  if (bs.some((b) => !b.public && b.owner !== "me"))
    return toast(
      t("其中一个 Ree 已转为私有", "One of these Rees is now private"),
    );
  const max = bs.reduce((s, b) => s + fee(b), 0);
  if (balance() < max) {
    modal(
      t("给好奇心，补充一点能量。", "A few more credits for your curiosity."),
      t(
        "当前余额不足以预留本次最高费用。",
        "Your balance cannot cover this question’s maximum cost.",
      ),
      `<div class="estimate"><span>${t("当前余额", "Available balance")}</span><strong>${n(balance())} credits</strong></div><div class="estimate"><span>${t("最多需要", "Maximum needed")}</span><strong>${max} credits</strong></div>`,
      cancelButton() +
        `<a class="btn" href="#/settings?tab=billing">${t("前往充值", "Add credits")} ${I("arrow")}</a>`,
    );
    return;
  }
  const ms = getMessages(key);
  if (!ms) return;
  ui.chatDrafts ??= {};
  ui.chatDrafts[key] = "";
  ui.busy = true;
  if (key.startsWith("public:"))
    history.replaceState(null, "", "#" + route().path);
  const reserved = takeCredits(max);
  state.chatReservation = { key, allocations: reserved, id: uid(), max };
  ms.push({ id: uid(), role: "user", text });
  suite.userRoles.recordQuestions(bs,"me",state.chatReservation.id);
  save();
  render();
  const tr = $("#transcript");
  tr?.insertAdjacentHTML(
    "beforeend",
    `<div class="typing" id="typing-indicator"><i></i><i></i><i></i></div>`,
  );
  if (tr) tr.scrollTop = tr.scrollHeight;
  await new Promise((r) => setTimeout(r, 750));
  const noKnowledge =
    /火星|天气|明天|足球|彩票|星座|天文|外星|weather|lottery|horoscope|mars/i.test(
      text,
    );
  let answered = 0,
    charged = 0;
  for (const b of bs) {
    const ready = b.knowledge.filter(
      (k) => k.status === "ready" && k.enabled !== false,
    );
    if (!ready.length || noKnowledge) {
      ms.push({
        id: uid(),
        role: "dot",
        dot: b.id,
        noAnswer: true,
        reason: !ready.length ? "no-sources" : "out-of-scope",
        text: "",
        cost: 0,
        suggestions:
          key.startsWith("chat:") && answered === 0 && b === bs.at(-1),
        participants: bs.map((x) => x.id),
        chat: key.slice(5),
      });
      continue;
    }
    const cost = fee(b);
    charged += cost;
    answered++;
    b.answers++;
    const response = answerFor(b, text);
    const k =
      b.owner === "me" && b.id !== "mine"
        ? ready.find((k) => k.kind === "text") || ready[0]
        : ready[0];
    const m = {
      id: uid(),
      role: "dot",
      dot: b.id,
      createdAt: new Date().toISOString(),
      text: "",
      source: k.id,
      citationSnapshot: {
        id: k.id,
        title: k.title,
        kind: k.kind,
        locator: k.locator,
        content: (k.content || "").slice(0, 2000),
      },
      cost,
      requestId: state.chatReservation.id,
    };
    ms.push(m);
    creditEntry(`${title(b)} · ${t("提问", "Question")}`, -cost, "query");
    state.entries[0].requestId = state.chatReservation.id;
    state.entries[0].dotId = b.id;
    state.entries[0].answerId = m.id;
    state.entries[0].createdAt = m.createdAt;
    const current = () => $("#compose")?.dataset.context === key;
    if (current()) {
      const v = $("#transcript");
      $("#typing-indicator")?.remove();
      v.insertAdjacentHTML("beforeend", messageHTML(m));
    }
    const step = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? response.length
      : 13;
    for (let i = 0; i < response.length; i += step) {
      m.text = response.slice(0, i + step);
      if (current()) {
        const el = $(`[data-message="${m.id}"] .answer-text`);
        if (el) el.textContent = m.text;
        const v = $("#transcript");
        v.scrollTop = v.scrollHeight;
      }
      if (step < response.length) await new Promise((r) => setTimeout(r, 17));
    }
  }
  if (key.startsWith("chat:")) {
    const c = chatById(key.slice(5));
    if (c) {
      c.updated = t("刚刚", "Just now");
      c.updatedAt = new Date().toISOString();
      delete c.archivedAt;
      if (c.title === t("新的对话", "New conversation"))
        c.title = text.slice(0, 30);
    }
  }
  releaseCredits(reserved, max - charged);
  delete state.chatReservation;
  ui.busy = false;
  save();
  render();
  if (!answered)
    toast(
      t(
        "没有相关知识，本次未扣费",
        "No relevant knowledge. No credits charged.",
      ),
    );
}
function scheduleProcessing(b, k, cost, fail = false) {
  setTimeout(() => {
    const live = state.dots.find((x) => x.id === b.id);
    const source = live?.knowledge.find((x) => x.id === k.id);
    if (!source) return;
    if (fail) {
      source.status = "failed";
      source.error = t(
        "演示：来源暂时无法读取，请重试。",
        "Demo: source is temporarily unavailable. Please retry.",
      );
      if (source.hold) releaseCredits(source.hold);
      else state.packCredits += cost;
      creditEntry(
        `${source.title} · ${t("失败退款", "Failure refund")}`,
        cost,
        "refund",
      );
    } else {
      source.status = "ready";
      delete source.error;
      source.locator =
        source.kind === "audio"
          ? "12:34–13:08"
          : source.kind === "github"
            ? "README.md · L1–32"
            : source.kind === "document"
              ? t("第 1–3 页", "Pages 1–3")
              : source.kind === "site"
                ? t("已模拟处理 12 页", "12 demo pages")
                : t("第 1 段", "Paragraph 1");
    }
    delete source.hold;
    delete source.processingCost;
    delete source.simulateFailure;
    const handled = suite?.knowledge?.processed(b, source, fail);
    save();
    if (handled) return;
    if (!$("#overlay-root").firstElementChild && !ui.busy) render();
    toast(
      fail
        ? t(
            "处理失败，预留费用已全额退回",
            "Processing failed. All reserved credits refunded.",
          )
        : t("知识已就绪，可以开始提问了", "Knowledge is ready. Ask away."),
    );
  }, 1800);
}
async function copy(value) {
  try {
    await navigator.clipboard.writeText(value);
    toast(t("已复制", "Copied"));
  } catch {
    modal(
      t("复制内容", "Copy this content"),
      t(
        "浏览器未开放剪贴板，请手动复制。",
        "Clipboard access is unavailable. Copy the text manually.",
      ),
      `<textarea class="input" rows="5" readonly>${esc(value)}</textarea>`,
      btn(t("完成", "Done"), "close-modal"),
    );
  }
}
function allMessages() {
  return [
    ...Object.values(state.dotMessages).flat(),
    ...state.chats.flatMap((c) => c.messages),
    ...(state.chatListDemo?.chats || []).flatMap((c) => c.messages),
  ];
}

document.addEventListener("click", async (e) => {
  if (e.target.closest(".skip-link")) {
    e.preventDefault();
    $("#main")?.focus();
    return;
  }
  const el = e.target.closest("[data-action]");
  if (!el) {
    if (e.target.dataset.backdrop) closeModal();
    return;
  }
  const a = el.dataset.action,
    d = el.dataset;
  e.preventDefault();
  if (await suite?.onAction(a, d, el)) return;
  switch (a) {
    case "close-modal":
      closeModal();
      break;
    case "confirm-action": {
      const cb = confirmCallback;
      confirmCallback = null;
      closeModal();
      cb?.();
      break;
    }
    case "language":
      state.lang = state.lang === "zh" ? "en" : "zh";
      save();
      closeModal();
      render();
      break;
    case "guide":
      guideModal();
      break;
    case "guide-link":
      closeModal();
      go(el.getAttribute("href").slice(1));
      break;
    case "mobile-menu":
      $("#sidebar").classList.toggle("mobile-open");
      syncPanels();
      break;
    case "sidebar-collapse":
      state.sidebarCollapsed = !state.sidebarCollapsed;
      save();
      syncPanels();
      break;
    case "toggle-knowledge-panel":
      $("#knowledge-panel")?.classList.toggle("show");
      syncPanels();
      break;
    case "participants-toggle":
      $("#participants")?.classList.toggle("show");
      break;
    case "create-dot":
      createDotModal();
      break;
    case "choose-color":
      ui.color = d.value;
      suite.dotAvatar.setColor(d.value);
      $$(".color-option").forEach((b) => {
        b.classList.toggle("active", b === el);
        b.setAttribute("aria-pressed", b === el);
      });
      break;
    case "category":
      ui.category = d.value;
      { const query = new URLSearchParams(route().query); if (d.value === "全部") query.delete("category"); else query.set("category", d.value); go("/explore" + (query.size ? "?" + query : "")); }
      break;
    case "clear-search":
      { const query = new URLSearchParams(route().query); query.delete("q"); go("/explore" + (query.size ? "?" + query : "")); }
      break;
    case "reset-search":
      ui.category = "全部";
      go("/explore");
      break;
    case "search-hint":
      ui.category = "全部";
      go("/explore?q=" + encodeURIComponent(d.value));
      break;
    case "dot-settings":
      dotSettingsModal(dotById(d.id));
      break;
    case "toggle-public": {
      const checked = el.getAttribute("aria-checked") !== "true";
      el.setAttribute("aria-checked", checked);
      $("#public-value").value = checked;
      break;
    }
    case "copy-link": {
      const b = dotById(d.id);
      await copy(location.href.split("#")[0] + "#/d/" + b.slug);
      break;
    }
    case "delete-dot": {
      const b = dotById(d.id);
      confirmModal(
        t("删除这个 Ree？", "Delete this Ree?"),
        t(
          "知识也会被移除。对话中的历史回答会保留，但它将不再参与新的问答。",
          "Its knowledge is removed. Historical replies remain, but the Ree will no longer participate.",
        ),
        t("删除 Ree", "Delete Ree"),
        () => {
          if (ui.busy)
            return toast(
              t(
                "请等待当前回答结束后重试",
                "Wait for the current response to finish",
              ),
            );
          for (const k of b.knowledge) {
            if (k.status === "processing" && k.hold) {
              releaseCredits(k.hold);
              creditEntry(
                k.title + " · " + t("取消处理退款", "Processing cancelled"),
                k.processingCost || 0,
                "refund",
              );
            }
          }
          state.archivedDots ??= [];
          state.archivedDots.push({ ...b, knowledge: [] });
          state.dots = state.dots.filter((x) => x.id !== b.id);
          state.chats.forEach(
            (c) => (c.dots = c.dots.filter((id) => id !== b.id)),
          );
          save();
          go("/dots");
          toast(
            t(
              "Ree 已删除，历史回答已保留",
              "Ree deleted. Historical answers preserved.",
            ),
          );
        },
        true,
      );
      break;
    }
    case "add-knowledge":
      addKnowledgeModal(d.id);
      break;
    case "knowledge-type":
      addKnowledgeModal(ui.modal.dot, d.value);
      break;
    case "refresh-source": {
      const b = dotById(d.dot),
        k = b.knowledge.find((k) => k.id === d.id);
      if (k.kind === "github" && k.private && !state.github) {
        toast(
          t(
            "私有仓库需要重新连接 GitHub",
            "Reconnect GitHub to refresh this private repository",
          ),
        );
        break;
      }
      confirmModal(
        t("重新处理这份知识？", "Reprocess this source?"),
        t(
          "重新处理会再次收费，演示费用为 20 credits。失败时全额退回。",
          "Reprocessing charges again: 20 demo credits. Failures receive a full refund.",
        ),
        t("确认并处理", "Reprocess"),
        () => {
          if (!debit(20)) {
            toast(t("余额不足，请充值", "Insufficient credits"));
            return;
          }
          k.status = "processing";
          k.hold = ui.lastDeduction;
          k.processingCost = 20;
          delete k.error;
          creditEntry(
            k.title + " · " + t("重新处理", "Reprocess"),
            -20,
            "knowledge",
          );
          save();
          render();
          scheduleProcessing(b, k, 20);
        },
      );
      break;
    }
    case "delete-source": {
      const b = dotById(d.dot),
        k = b.knowledge.find((k) => k.id === d.id);
      if (k.status === "processing") {
        toast(t("请等待处理结束后再删除", "Wait until processing finishes"));
        break;
      }
      confirmModal(
        t("删除知识来源？", "Delete this source?"),
        t(
          "Ree 将无法在新的回答中引用这份知识。",
          "The Ree will no longer use it for new answers.",
        ),
        t("删除知识", "Delete source"),
        () => {
          b.knowledge = b.knowledge.filter((k) => k.id !== d.id);
          save();
          render();
          toast(t("知识来源已删除", "Source deleted"));
        },
        true,
      );
      break;
    }
    case "new-chat":
      pickDotsModal();
      break;
    case "pick-dots":
      pickDotsModal(d.chat);
      break;
    case "invite":
      inviteModal(dotById(d.id));
      break;
    case "invite-existing": {
      const c = chatById(d.chat);
      if (c.dots.length >= 5) {
        toast(t("每场对话最多 5 个 Ree", "Maximum 5 Rees"));
        break;
      }
      if (!c.dots.includes(d.id)) c.dots.push(d.id);
      save();
      go("/chats/" + c.id);
      toast(t("Ree 已加入对话", "Ree joined the conversation"));
      break;
    }
    case "invite-new": {
      const c = {
        id: uid(),
        title: t(
          "和 " + title(dotById(d.id)) + " 聊聊",
          "Chat with " + title(dotById(d.id)),
        ),
        dots: [d.id],
        messages: [],
        updated: t("刚刚", "Just now"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.chats.unshift(c);
      save();
      go("/chats/" + c.id);
      break;
    }
    case "remove-participant": {
      if (ui.busy) {
        toast(
          t(
            "请等当前回答结束后再调整参与者",
            "Wait for the current response to finish",
          ),
        );
        break;
      }
      const c = chatById(d.chat);
      c.dots = c.dots.filter((id) => id !== d.id);
      save();
      render();
      toast(
        t(
          "已移出，历史回答仍然保留",
          "Ree removed. Historical replies remain.",
        ),
      );
      break;
    }
    case "sample":
      if ($("#message-input")) {
        $("#message-input").value = d.value;
        $("#message-input").focus();
        updateCompose();
      }
      break;
    case "citation": {
      const b = dotById(d.dot),
        k =
          b.knowledge.find((k) => k.id === d.id) ||
          b.knowledgeTrash?.find((k) => k.id === d.id);
      if (k) citationModal(b, k);
      else toast(t("来源已被移除", "The source has been removed"));
      break;
    }
    case "copy-citation": {
      const b = dotById(d.dot),
        k =
          b?.knowledge.find((k) => k.id === d.id) ||
          b?.knowledgeTrash?.find((k) => k.id === d.id);
      if (!k) break;
      await copy(
        `${k.title} · ${k.locator}\n${k.content || t("演示引用片段", "Demo citation excerpt")}`,
      );
      break;
    }
    case "copy-answer":
      await copy(allMessages().find((m) => m.id === d.id)?.text || "");
      break;
    case "vote": {
      const m = allMessages().find((m) => m.id === d.id);
      if (m) {
        m.vote = m.vote === d.vote ? null : d.vote;
        suite.userRoles.recordVote(m,"me");
        save();
        render();
        toast(t("反馈已记录，谢谢。", "Feedback recorded. Thank you."));
      }
      break;
    }
    case "add-suggestion": {
      const c = chatById(d.chat);
      if (c && c.dots.length < 5) {
        c.dots.push(d.id);
        save();
        render();
        toast(
          t(
            "Ree 已加入，请再次发送问题",
            "Ree added. Ask your question again.",
          ),
        );
      } else toast(t("每场对话最多 5 个 Ree", "Maximum 5 Rees"));
      break;
    }
    case "mention": {
      const b = dotById(d.id),
        inp = $("#message-input");
      inp.value = inp.value.replace(/@[^@\n]*$/, "@" + title(b) + " ");
      $("#mention-menu").innerHTML = "";
      inp.focus();
      updateCompose(false);
      break;
    }
    case "connect-github":
      confirmModal(
        t("连接 GitHub", "Connect GitHub"),
        t(
          "模拟授权：只读取你允许的仓库，不申请写入权限。不会连接真实 GitHub。",
          "Simulated authorization: read-only access to allowed repositories. No real GitHub connection.",
        ),
        t("模拟授权成功", "Simulate authorization"),
        () => {
          state.github = true;
          save();
          render();
          toast(t("GitHub 已连接 · 演示", "GitHub connected · Demo"));
        },
      );
      break;
    case "disconnect-github":
      confirmModal(
        t("断开 GitHub 连接？", "Disconnect GitHub?"),
        t(
          "已有知识会保留，私有仓库将停止刷新。",
          "Existing knowledge stays. Private repository refreshes will stop.",
        ),
        t("断开连接", "Disconnect"),
        () => {
          state.github = false;
          save();
          render();
        },
      );
      break;
    case "add-domain":
      domainModal();
      break;
    case "verify-domain":
      domainModal(d.value);
      break;
    case "domain-method":
      domainModal(ui.modal.domain, d.value);
      break;
    case "copy-domain":
      await copy(d.value);
      break;
    case "check-domain": {
      const domain = ui.modal.domain;
      if (!$("#domain-demo-check").checked) {
        $("#domain-error").innerHTML =
          `<div class="form-error mt16" role="alert">${t("未找到匹配的验证记录。请检查后重试。", "No matching verification record found. Check it and retry.")}</div>`;
        break;
      }
      const entry = state.domains.find((x) => x.domain === domain);
      entry.status = "verified";
      entry.method = ui.modal.method;
      save();
      closeModal();
      render();
      toast(t("域名验证成功 · 演示", "Domain verified · Demo"));
      break;
    }
    case "remove-domain":
      confirmModal(
        t("移除域名？", "Remove domain?"),
        t(
          "该域名将无法用于新的整站抓取，直到重新验证。",
          "New website crawls require verification again.",
        ),
        t("移除", "Remove"),
        () => {
          state.domains = state.domains.filter((x) => x.domain !== d.value);
          save();
          render();
        },
        true,
      );
      break;
    case "billing-tab":
      ui.billingTab = d.value;
      go("/settings?tab=billing&activity="+encodeURIComponent(d.value)+"&section=activity");
      break;
    case "checkout":
      go("/checkout?kind=" + d.kind);
      break;
    case "manage-plan":
      if (state.cancelled) {
        state.cancelled = false;
        save();
        render();
        toast(t("已恢复自动续费 · 演示", "Renewal resumed · Demo"));
      } else
        confirmModal(
          t("管理 Plan 订阅", "Manage your Plan"),
          t(
            "取消后可以继续使用至当前周期末；已有 Pack 与收入 credits 不受影响。",
            "Keep Plan access until the current cycle ends. Pack and earned credits remain.",
          ),
          t("取消自动续费", "Cancel renewal"),
          () => {
            state.cancelled = true;
            save();
            render();
            toast(
              t(
                "将在当前周期结束后取消 · 演示",
                "Cancels at the end of this cycle · Demo",
              ),
            );
          },
        );
      break;
    case "kyc":
      suite.manualKyc.onAction("kyc", {});
      break;
    case "paypal":
      paypalModal();
      break;
    case "payout":
      payoutModal();
      break;
    case "sign-in": {
      state.signed = true;
      suite.profile.recordLogin(d.provider);
      save();
      const next = route().query.get("next");
      suite.experience.signIn(next);
      toast(
        t(
          "已进入本地演示账号，不会连接真实登录服务",
          "Local demo account opened. No OAuth service contacted.",
        ),
      );
      break;
    }
    case "logout":
      if (ui.busy) {
        toast(t("请等待当前回答结束", "Wait for the response to finish"));
        break;
      }
      state.signed = false;
      save();
      go("/login");
      break;
    case "legal":
      modal(
        d.value === "privacy"
          ? t("隐私政策 · 原型说明", "Privacy · Prototype note")
          : t("服务条款 · 原型说明", "Terms · Prototype note"),
        "",
        `<p class="form-hint">${t("此页面用于设计评审，不构成正式服务条款。数据仅保存在本浏览器，重置演示会清除。文件不会上传；文字内容不会发送至 AI。正式上线前需单独审阅服务条款、隐私政策、音频转写与支付服务说明。", "This is a design review prototype, not a legal agreement. Data is stored in this browser and cleared on reset. Files are not uploaded, and text is not sent to AI. Production terms, privacy, audio processing, and payment policies require separate review.")}</p>`,
        btn(t("知道了", "Got it"), "close-modal"),
      );
      break;
    case "scenario": {
      if (ui.busy)
        return toast(
          t("请等待当前操作完成", "Wait for the current operation to finish"),
        );
      if (d.value === "trial") {
        confirmModal(
          t("切换到新用户场景？", "Switch to a new user?"),
          t(
            "会清空当前演示修改，并模拟注册赠送的 2,000 credits。",
            "This resets demo changes and starts with 2,000 welcome credits.",
          ),
          t("切换场景", "Switch scenario"),
          () => {
            state = seed();
            state.signed = true;
            state.plan = false;
            state.planCredits = 0;
            state.packCredits = 0;
            state.earnedCredits = 0;
            state.welcomeCredits = 2000;
            state.dots = state.dots.filter((b) => b.owner !== "me");
            state.chats = [];
            state.domains = [];
            state.github = false;
            save();
            go("/dots");
          },
        );
        break;
      }
      if (d.value === "low") {
        state.planCredits = 0;
        state.packCredits = 0;
        state.earnedCredits = 0;
        state.welcomeCredits = 5;
        save();
        go("/chats/" + (state.chats[0]?.id || ""));
        toast(
          t(
            "余额已设为 5 credits，试着提问",
            "Balance set to 5 credits. Try asking a question.",
          ),
        );
      }
      if (d.value === "failed") {
        const b = mine()[0];
        if (!b) {
          toast(t("请先创建一个 Ree", "Create a Ree first"));
          break;
        }
        b.knowledge.push({
          id: uid(),
          title: "无法读取的资料.pdf",
          kind: "document",
          status: "failed",
          locator: "PDF · 2.4 MB",
          error: t(
            "演示：文档加密，暂时无法提取文本。可重试或删除。",
            "Demo: encrypted document. Retry or delete.",
          ),
        });
        save();
        go("/dots/" + b.id);
      }
      if (d.value === "admin") {
        go("/admin/login");
      }
      if (d.value === "user") {
        state.admin = false;
        save();
        go("/explore");
        toast(t("已切换为普通账号", "Regular demo account selected"));
      }
      break;
    }
    case "reset-demo":
      confirmModal(
        t("重置演示数据？", "Reset demo data?"),
        t(
          "所有本地修改都会被清除，恢复初始示例。",
          "All local changes will be cleared and the original examples restored.",
        ),
        t("重置", "Reset"),
        () => {
          if (ui.busy)
            return toast(
              t("请等待当前操作完成", "Wait for the current operation"),
            );
          state = seed();
          ui.category = "全部";
          ui.ownFilter = "all";
          save();
          go("/");
          toast(t("演示已重置", "Demo reset"));
        },
        true,
      );
      break;
  }
});

document.addEventListener("submit", async (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement)) return;
  e.preventDefault();
  const f = new FormData(form);
  if (await suite?.onSubmit(form, f, e)) return;
  if (form.id === "explore-search") {
    const query = new URLSearchParams(route().query);
    if (f.get("q").trim()) query.set("q", f.get("q").trim());
    else query.delete("q");
    go("/explore" + (query.size ? "?" + query : ""));
  }
  if (form.id === "compose")
    sendMessage(form.dataset.context, $("#message-input").value);
  if (form.id === "knowledge-form") {
    const b = dotById(form.dataset.dot),
      kind = ui.addKind;
    let title = "",
      content = "",
      url = "",
      isPrivate = false,
      cost = 20;
    if (kind === "document" || kind === "audio") {
      const file = ui.selectedFile;
      if (!file) return formError(t("请先选择一个文件", "Choose a file first"));
      const ext = file.name.split(".").pop().toLowerCase();
      const allowed =
        kind === "audio" ? ["mp3", "m4a", "wav"] : ["pdf", "docx", "md", "txt"];
      if (!allowed.includes(ext))
        return formError(
          t("不支持这个文件类型", "This file type is not supported"),
        );
      if (file.size > (kind === "audio" ? 100 : 20) * 1024 * 1024)
        return formError(
          t("文件超过大小限制", "The file exceeds the size limit"),
        );
      title = file.name;
      if (["md", "txt"].includes(ext)) {
        content = (await file.text()).slice(0, 10000);
        cost = Math.max(1, Math.ceil(content.length / 1000));
      } else cost = kind === "audio" ? 300 : 20;
    } else if (kind === "text") {
      title = f.get("title").trim();
      content = f.get("content").trim();
      if (!title || !content)
        return formError(
          t("请填写标题和知识内容", "Enter a title and content"),
        );
      cost = Math.max(1, Math.ceil(content.length / 1000));
    } else {
      try {
        const u = new URL(f.get("url"));
        if (u.protocol !== "https:" && u.protocol !== "http:") throw Error();
        url = u.href;
        if (
          kind === "github" &&
          (u.hostname !== "github.com" ||
            u.pathname.split("/").filter(Boolean).length < 2)
        )
          return formError(
            t("请输入有效的 GitHub 仓库地址", "Enter a GitHub repository URL"),
          );
        if (
          kind === "site" &&
          !state.domains.some(
            (d) => d.domain === u.hostname && d.status === "verified",
          )
        )
          return formError(
            t("请先在设置中验证该域名", "Verify this domain in Settings first"),
          );
        title =
          kind === "github"
            ? u.pathname.slice(1).replace(/\/$/, "")
            : u.hostname + u.pathname.replace(/\/$/, "");
      } catch {
        return formError(
          t("请输入有效的 http(s) 地址", "Enter a valid HTTP(S) URL"),
        );
      }
      isPrivate = f.get("private") === "on";
      if (isPrivate && !state.github)
        return formError(
          t(
            "私有仓库需要先连接 GitHub",
            "Connect GitHub before adding a private repository",
          ),
        );
      cost = kind === "github" ? 120 : kind === "site" ? 500 : 20;
    }
    if (!debit(cost))
      return formError(
        t(
          "余额不足，请先前往计费页充值。",
          "Insufficient credits. Add credits in Billing first.",
        ),
      );
    const k = {
      id: uid(),
      title,
      kind,
      content,
      source: url,
      private: isPrivate,
      status: "processing",
      hold: ui.lastDeduction,
      processingCost: cost,
      simulateFailure: /fail|失败/i.test(title),
      locator: t("等待解析与索引", "Preparing and indexing"),
    };
    suite.knowledge.ingested(
      b,
      k,
      ["document", "audio"].includes(kind) ? ui.selectedFile : null,
    );
    b.knowledge.push(k);
    creditEntry(
      title + " · " + t("知识处理预留", "Knowledge processing"),
      -cost,
      "knowledge",
    );
    save();
    closeModal();
    render();
    toast(
      t("知识已添加，正在模拟处理", "Source added. Simulating processing."),
    );
    scheduleProcessing(b, k, cost, /fail|失败/i.test(title));
  }
  if (form.id === "pick-dots-form") {
    const ids = f.getAll("dots");
    if (!ids.length)
      return formError(t("至少选择一个 Ree", "Choose at least one Ree"));
    if (ids.length > 5)
      return formError(
        t("每场对话最多 5 个 Ree", "Maximum 5 Rees per conversation"),
      );
    if (ui.busy)
      return formError(
        t("请等待当前回答结束", "Wait for the current response to finish"),
      );
    const c = chatById(form.dataset.chat);
    if (c) {
      c.dots = ids;
      save();
      closeModal();
      render();
      toast(t("参与者已更新", "Participants updated"));
    } else {
      const chat = {
        id: uid(),
        title: f.get("title")?.trim() || t("新的对话", "New conversation"),
        dots: ids,
        messages: [],
        updated: t("刚刚", "Just now"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.chats.unshift(chat);
      save();
      go("/chats/" + chat.id);
    }
  }
  if (form.id === "domain-form") {
    const domain = f.get("domain").trim().toLowerCase();
    if (
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
        domain,
      )
    )
      return formError(
        t(
          "请输入有效域名，例如 docs.example.com",
          "Enter a valid domain, like docs.example.com",
        ),
      );
    if (
      state.domains.some((d) => d.domain === domain && d.status === "verified")
    )
      return formError(
        t("这个域名已经验证过了", "This domain is already verified"),
      );
    if (!state.domains.some((d) => d.domain === domain))
      state.domains.push({ domain, status: "pending", method: "dns" });
    save();
    domainModal(domain);
  }
  if (form.id === "profile-form") {
    state.displayName = f.get("name").trim();
    if (!state.displayName) return;
    delete ui.profileNameDraft;
    save();
    render();
    toast(t("个人资料已保存", "Profile saved"));
  }
  if (form.id === "checkout-form") {
    const kind = form.dataset.kind;
    if (kind === "pack" && !state.plan)
      return formError(t("需要有效 Plan 订阅", "An active Plan is required"));
    if (kind === "plan" && state.plan)
      return formError(
        t("你已经有有效订阅", "You already have an active Plan"),
      );
    if (kind === "plan") {
      state.plan = true;
      state.cancelled = false;
      state.planCredits += 100000;
    } else state.packCredits += 100000;
    creditEntry(
      kind.toUpperCase() + " · " + t("模拟充值", "Demo purchase"),
      100000,
      "purchase",
    );
    save();
    closeModal();
    render();
    modal(
      t("好奇心，已准备就绪。", "Ready for your next question."),
      "",
      `<div class="success-body"><div class="success-mark">${I("check")}</div><h3>+ 100,000 credits</h3><p>${t("模拟充值成功，没有产生真实扣款。", "Simulated purchase complete. No real charge was made.")}</p></div>`,
      btn(t("继续探索", "Keep exploring"), "close-modal"),
    );
  }
  if (form.id === "paypal-form") {
    if (state.kyc !== "verified") return formError(t("身份验证通过后才能修改收款邮箱", "Verification is required before changing the payout email"));
    const email = f.get("email").trim();
    if (!email) return;
    const changing = !!state.paypal && state.paypal !== email;
    if (changing) state.paypalChanged = Date.now();
    state.paypal = email;
    save();
    closeModal();
    render();
    toast(
      changing
        ? t(
            "邮箱已更换，7 天后可提现",
            "Email changed. Payouts unlock in 7 days.",
          )
        : t("收款邮箱已绑定 · 演示", "Payout email connected · Demo"),
    );
  }
  if (form.id === "payout-form") {
    const amount = Number(f.get("credits"));
    if (
      !Number.isInteger(amount) ||
      amount < 500000 ||
      amount > state.earnedCredits ||
      state.payouts.some(activePayout) ||
      state.kyc !== "verified" ||
      !state.paypal ||
      Date.now() - state.paypalChanged < 7 * 86400000
    )
      return formError(
        t(
          "不满足提现条件，请检查金额、身份、收款邮箱与冷静期",
          "Check amount, verification, payout email, and hold period",
        ),
      );
    state.earnedCredits -= amount;
    state.payouts.unshift({
      id: uid(),
      credits: amount,
      email: state.paypal,
      status: "pending",
      created: "2026-10-31",
    });
    creditEntry(
      t("提现申请 · 冻结收入", "Payout request · Earnings held"),
      -amount,
      "payout",
    );
    save();
    closeModal();
    render();
    toast(
      t(
        "申请已提交，收入 credits 已冻结",
        "Request submitted. Earned credits held for review.",
      ),
    );
  }
});

function updateCompose(showMenu = true) {
  const inp = $("#message-input"),
    form = $("#compose");
  if (!inp || !form) return;
  const key = form.dataset.context;
  const bs = resolveTargetDots(key, inp.value);
  const send = form.querySelector(".room-send");
  if (send) send.disabled = ui.busy || !inp.value.trim() || !bs.length;
  $("#cost-label").innerHTML =
    `${t("最多", "Up to")} <strong>${bs.reduce((s, b) => s + fee(b), 0)}</strong> credits`;
  const menu = $("#mention-menu");
  if (!menu) return;
  const match = inp.value.match(/@([^@\n]*)$/);
  if (showMenu && match && contextDots(key).length > 1) {
    const q = match[1].toLowerCase();
    const matches = contextDots(key).filter(
      (b) =>
        title(b).toLowerCase().includes(q) || b.name.toLowerCase().includes(q),
    );
    menu.innerHTML = matches.length
      ? `<div class="mention-menu" role="group" aria-label="${t("选择 Ree", "Select a Ree")}">${matches.map((b) => `<button type="button" data-action="mention" data-id="${b.id}">${avatar(b, true)}${esc(title(b))}</button>`).join("")}</div>`
      : "";
  } else menu.innerHTML = "";
}
document.addEventListener("input", (e) => {
  if (e.target.id === "message-input") updateCompose();
  if (e.target.id === "source-text")
    $("#estimate-value").textContent =
      Math.max(1, Math.ceil(e.target.value.length / 1000)) + " credits";
});
document.addEventListener("change", (e) => {
  if (e.target.id === "sort") {
    const query = new URLSearchParams(route().query);
    query.set("sort", e.target.value);
    go("/explore?" + query);
  }
  if (e.target.id === "knowledge-file") selectFile(e.target.files[0]);
  if (e.target.name === "dots" && e.target.closest("#pick-dots-form")) {
    const checked = $$("#pick-dots-form input[name=dots]:checked");
    if (checked.length > 5) {
      e.target.checked = false;
      toast(t("最多选择 5 个 Ree", "Choose up to 5 Rees"));
      return;
    }
    ui.selectedDots = $$("#pick-dots-form input[name=dots]:checked").map(
      (x) => x.value,
    );
    $("#selection-count").textContent =
      ui.selectedDots.length + " / 5 " + t("个 Ree", "Rees");
    $("#selection-cost").textContent =
      ui.selectedDots.map(dotById).reduce((s, b) => s + fee(b), 0) +
      " credits " +
      t("/ 次最多", "maximum / question");
  }
});
function selectFile(file) {
  if (!file) return;
  ui.selectedFile = file;
  $("#file-label").textContent = file.name;
  const cost = ui.addKind === "audio" ? 300 : 20;
  $("#estimate-value").textContent = "~ " + cost + " credits";
}
document.addEventListener("dragover", (e) => {
  const dz = e.target.closest("#dropzone");
  if (dz) {
    e.preventDefault();
    dz.classList.add("dragover");
  }
});
document.addEventListener("dragleave", (e) =>
  e.target.closest("#dropzone")?.classList.remove("dragover"),
);
document.addEventListener("drop", (e) => {
  const dz = e.target.closest("#dropzone");
  if (dz) {
    e.preventDefault();
    dz.classList.remove("dragover");
    selectFile(e.dataTransfer.files[0]);
  }
});
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (!$("#explore-input")) {
      go("/explore");
      setTimeout(() => $("#explore-input")?.focus(), 30);
    } else $("#explore-input").focus();
  }
  if (e.key === "Escape") {
    if ($("#overlay-root").firstElementChild) closeModal();
    $("#sidebar")?.classList.remove("mobile-open");
    $("#knowledge-panel")?.classList.remove("show");
    $("#participants")?.classList.remove("show");
    if ($("#mention-menu")) $("#mention-menu").innerHTML = "";
    syncPanels();
  }
  if (
    e.target.id === "message-input" &&
    e.key === "Enter" &&
    !e.shiftKey &&
    !e.isComposing
  ) {
    e.preventDefault();
    $("#compose").requestSubmit();
  }
  if (e.key === "Tab" && $("#overlay-root").firstElementChild) {
    const focusable = $$(
      '.modal a[href], .modal button:not(:disabled), .modal input:not(:disabled):not([type=hidden]), .modal textarea:not(:disabled), .modal select:not(:disabled), .modal [tabindex="0"]',
    ).filter((el) => el.getClientRects().length);
    const first = focusable[0],
      last = focusable.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});
function syncPanels() {
  document
    .querySelector(".header-tabs [aria-current='page']")
    ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  const sidebar = $("#sidebar"),
    knowledge = $("#knowledge-panel");
  sidebar?.classList.toggle("is-collapsed", !!state.sidebarCollapsed);
  $(".app-main, .console-main")?.classList.toggle(
    "sidebar-collapsed",
    !!state.sidebarCollapsed,
  );
  for (const link of $$("#sidebar a[href]")) {
    if (!link.hasAttribute("aria-label")) {
      const text = link.cloneNode(true);
      text
        .querySelectorAll("small,.nav-count")
        .forEach((count) => count.remove());
      link.setAttribute("aria-label", text.textContent.trim());
    }
    link.title = link.getAttribute("aria-label");
  }
  const guide = $("#sidebar button[data-action='guide']");
  if (guide) {
    guide.setAttribute("aria-label", t("页面导览", "Page guide"));
    guide.title = guide.getAttribute("aria-label");
  }
  for (const button of $$("[data-action='sidebar-collapse']")) {
    button.setAttribute("aria-expanded", String(!state.sidebarCollapsed));
    button.setAttribute(
      "aria-label",
      state.sidebarCollapsed
        ? t("展开侧栏", "Expand sidebar")
        : t("收起侧栏", "Collapse sidebar"),
    );
    button.title = button.getAttribute("aria-label");
    button.innerHTML = I(state.sidebarCollapsed ? "panel-open" : "panel-close");
  }
  if (sidebar)
    sidebar.inert =
      matchMedia("(max-width:760px)").matches &&
      !sidebar.classList.contains("mobile-open");
  if (knowledge)
    knowledge.inert =
      matchMedia("(max-width:560px)").matches &&
      !knowledge.classList.contains("show");
  for (const [action, panel, openClass] of [
    ["mobile-menu", sidebar, "mobile-open"],
    ["toggle-knowledge-panel", knowledge, "show"],
  ]) {
    for (const button of $$(`[data-action="${action}"]`)) {
      if (panel) {
        button.setAttribute("aria-controls", panel.id);
        button.setAttribute(
          "aria-expanded",
          panel.classList.contains(openClass),
        );
      }
    }
  }
}
window.addEventListener("resize", syncPanels);
document.addEventListener("click", (e) => {
  const sidebar = $("#sidebar");
  if (
    sidebar?.classList.contains("mobile-open") &&
    !e.target.closest("#sidebar") &&
    !e.target.closest('[data-action="mobile-menu"]')
  ) {
    sidebar.classList.remove("mobile-open");
    syncPanels();
  }
});
document.addEventListener("click", (e) => {
  const link = e.target.closest('a[href^="#/"]');
  if (link) {
    closeModal();
    $("#sidebar")?.classList.remove("mobile-open");
  }
});
window.addEventListener("hashchange", () => {
  closeModal();
  render();
  window.scrollTo(0, 0);
});
// Recover simulated in-flight processing after a refresh without replaying charges.
if (state.chatReservation) {
  const hold = state.chatReservation;
  releaseCredits(hold.allocations, hold.max);
  const ms = getMessages(hold.key) || [];
  for (let i = ms.length - 1; i >= 0; i--) {
    if (ms[i].requestId === hold.id) {
      const b = dotById(ms[i].dot);
      if (b) b.answers = Math.max(0, b.answers - 1);
      ms.splice(i, 1);
    }
  }
  state.entries = state.entries.filter((e) => e.requestId !== hold.id);
  delete state.chatReservation;
  save();
  toast(
    t(
      "上次回答已中断，预留 credits 已退回",
      "Previous response interrupted. Reserved credits returned.",
    ),
  );
}
state.dots.forEach((b) =>
  b.knowledge.forEach((k) => {
    if (k.status === "processing")
      scheduleProcessing(b, k, k.processingCost || 0, !!k.simulateFailure);
  }),
);
suite = createSuite({
  getState: () => state,
  getUi: () => ui,
  t,
  I,
  esc,
  uid,
  n,
  title,
  desc,
  mine,
  publicDots,
  dotById,
  publicDotBySlug,
  dotCard,
  ownedDotCard,
  queryScore,
  fee,
  balance,
  save,
  route,
  go,
  btn,
  iconBtn,
  wordmark,
  avatar,
  footer,
  shell,
  explore,
  modal,
  closeModal,
  confirmModal,
  cancelButton,
  submitButton,
  formError,
  toast,
  debit,
  creditEntry,
  copy,
  render,
  syncPanels,
  kinds,
  scheduleProcessing,
  sidebarToggle,
  userSettingsLink,
  sidebarAccountFooter,
  sendMessage,
  chatById,
  messageHTML,
  updateCompose,
});
// Keep owner role marks current across already-open prototype views without
// replacing another tab's balances, drafts, messages or knowledge edits.
window.addEventListener("storage", event => {
  if (event.key !== storageKey || !event.newValue) return;
  let incoming;
  try { incoming = JSON.parse(event.newValue); } catch { return; }
  if (incoming?.roleData?.version !== 1 || !state.roleData) return;
  const before = JSON.stringify([state.role, state.console.users.map(u => [u.id,u.role]), state.roleData.requests]);
  if (Date.parse(incoming.roleChangedAt || "") >= Date.parse(state.roleChangedAt || "1970-01-01")) {
    state.role = incoming.role; state.roleChangedAt = incoming.roleChangedAt;
  }
  for (const user of state.console.users) {
    const latest = incoming.console?.users?.find(u => u.id === user.id);
    if (latest && Date.parse(latest.roleChangedAt || "") >= Date.parse(user.roleChangedAt || "1970-01-01")) {
      user.role = latest.role; user.roleChangedAt = latest.roleChangedAt;
    }
  }
  for (const request of incoming.roleData.requests || []) {
    const index = state.roleData.requests.findIndex(r => r.id === request.id);
    if (index < 0) state.roleData.requests.push(request);
    else if (Date.parse(request.decidedAt || request.createdAt) >= Date.parse(state.roleData.requests[index].decidedAt || state.roleData.requests[index].createdAt)) state.roleData.requests[index] = request;
  }
  for (const record of incoming.console?.audits || []) if (/^(user\.role\.|verification\.)/.test(record.action) && !state.console.audits.some(a => a.id === record.id)) state.console.audits.unshift(record);
  if (!ui.busy && !ui.modal && before !== JSON.stringify([state.role, state.console.users.map(u => [u.id,u.role]), state.roleData.requests])) render();
});
if (!location.hash) history.replaceState(null, "", "#/");
render();
