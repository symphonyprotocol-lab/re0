import { createUserRoles } from "./user-roles.js";
import { createRolePages } from "./role-pages.js";
import { createAdminRecords } from "./admin-records.js";
import { adminRecordBackPath } from "./admin-scale.js";
import { createOwnedRees } from "./owned-rees.js";
import { createWorkspaceDetails } from "./workspace-details.js";
import { createDotStatistics } from "./dot-statistics.js";
import { createStatisticsCalendar } from "./statistics-calendar.js";
import { createDotAvatar } from "./dot-avatar.js";
import { createDotClassification } from "./dot-classification.js";
import { createDotSetup } from "./dot-setup.js";
import { createDotConversation } from "./dot-conversation.js";
import { createPublicDot } from "./public-dot.js";
import { createDiscovery } from "./discovery.js";
import { createAdminRees } from "./admin-ree.js";
import { createAdminReeDetail, adminReeDetailPath } from "./admin-ree-detail.js";
import { createAdminReeSource, adminReeSourceRoute } from "./admin-ree-source.js";
import { createAdminReeStatistics } from "./admin-ree-statistics.js";
import { toggleInlineFullscreen } from "./inline-video.js";
import { hasVideoIntroduction, hasPublicVideoIntroduction, publicVideoSource, discoveryVideoStyle, renderVideoPlaceholder } from "./discovery-video.js";
import { createWorkspace } from "./workspace.js";
import {
  createManualKyc,
  normalizeManualKyc,
  recordPayoutResult,
} from "./manual-kyc.js";
import { createUsage } from "./usage.js";
import { createProfile } from "./profile.js";
import { createChatRoom } from "./chat-room.js";
import { createExperience } from "./experience.js";
import { createKnowledge } from "./knowledge.js";
import { createConversations } from "./conversations.js";
// Keep persisted audit event codes compatible while presenting the current name.
export const auditActionLabel = (action) =>
  String(action ?? "").replace(/^dot\./i, "ree.");
// Complete website and operations prototype. All service calls are local simulations.
export function createSuite(ctx) {
  const {
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
    sidebarToggle,
  } = ctx;
  const userRoles = createUserRoles(ctx);
  ctx.userRoles = userRoles;
  const profile = createProfile(ctx);
  const dotAvatar = createDotAvatar(ctx);
  const classification = createDotClassification(ctx);
  const experience = createExperience(ctx);
  ctx.experience = experience;
  const chatRoom = createChatRoom(ctx);
  ctx.chatRoom = chatRoom;
  const knowledge = createKnowledge(ctx);
  const dotSetup = createDotSetup({ ...ctx, dotAvatar, classification, knowledge });
  const dotConversation = createDotConversation(ctx);
  const publicDotPage = createPublicDot({ ...ctx, classification, inlineVideo: inlinePublicVideo, marketingHeader, discoveryCover, getOwnedRees: () => ownedRees.catalog() });
  const usage = createUsage(ctx);
  ctx.usage = usage;
  const conversations = createConversations(ctx);
  const ownedRees = createOwnedRees(ctx);
  const workspaceContext = { ...ctx, getOwnedRees: ownedRees.catalog };
  const discovery = createDiscovery(workspaceContext);
  const workspace = createWorkspace(workspaceContext);
  const workspaceDetails = createWorkspaceDetails(workspaceContext);
  const dotStatistics = createDotStatistics(ctx);
  const statisticsCalendar = createStatisticsCalendar(ctx);
  const S = () => ctx.getState(),
    U = () => ctx.getUi();
  const L = (path, label, cls = "btn secondary") =>
    `<a class="${cls}" href="#${path}">${label}</a>`;
  const field = (id, label, input, hint = "") =>
    `<div class="field"><label for="${id}">${label}</label>${input}${hint ? `<small>${hint}</small>` : ""}</div>`;
  const input = (id, name, value = "", extra = "") =>
    `<input id="${id}" name="${name}" value="${esc(value)}" ${extra}>`;
  const money = (v) => "$" + Number(v).toFixed(2);
  const date = () =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kuching",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  const labels = {
    pending: ["审核中", "Pending"],
    paid: ["已支付", "Paid"],
    rejected: ["已驳回", "Rejected"],
    failed: ["失败", "Failed"],
    approved: ["待人工打款", "Awaiting manual payment"],
    verified: ["已通过", "Verified"],
    none: ["未开始", "Not started"],
    reset: ["待重新验证", "Reverification required"],
    processing: ["进行中", "In progress"],
    refunded: ["已退款", "Refunded"],
    chargeback: ["拒付", "Chargeback"],
    active: ["有效", "Active"],
    cancelled: ["周期末取消", "Cancels at period end"],
    expired: ["已过期", "Expired"],
    enabled: ["启用中", "Active"],
    disabled: ["已停用", "Disabled"],
    inactive: ["未启用", "Inactive"],
    running: ["重算中", "Rebuilding"],
    done: ["已完成", "Completed"],
  };
  const tag = (status) =>
    `<span class="tag ${["paid", "verified", "active", "enabled", "done"].includes(status) ? "green" : ["rejected", "failed", "chargeback"].includes(status) ? "red" : ["pending", "running", "processing", "cancelled"].includes(status) ? "orange" : ""}"><i class="dot"></i>${labels[status] ? t(...labels[status]) : esc(status)}</span>`;
  const sectionHead = (heading, subtitle = "", action = "") =>
    `<div class="page-head"><div><p class="eyebrow section-kicker">${route().path.startsWith("/admin") ? "OPERATIONS / RE0" : "YOUR KNOWLEDGE, CONNECTED"}</p><h1>${esc(heading)}</h1>${subtitle ? `<p>${subtitle}</p>` : ""}</div>${action}</div>`;
  const table = (
    heads,
    rows,
    emptyText = t("没有符合条件的记录", "No matching records"),
  ) =>
    `<div class="table-wrap"><table><thead><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${heads.length}" class="table-empty">${I("search")}<p>${emptyText}</p></td></tr>`}</tbody></table></div>`;
  const stats = (items) =>
    `<div class="suite-stats">${items.map(([label, value, note, ic]) => `<article class="card suite-stat"><div class="between"><span>${label}</span>${I(ic || "layers")}</div><strong class="mono">${value}</strong><small>${note || t("当前演示数据", "Current demo data")}</small></article>`).join("")}</div>`;
  const rolePages = createRolePages(ctx);
  const adminRees = createAdminRees({
    ...ctx, table: dotsTable, sectionHead,
    ownerText: (dot) => {
      if (dot.adminDemo) return "";
      const owner = user(ownerId(dot));
      return [owner?.name, owner?.email].join(" ");
    },
  });
  const adminKindLabel = kind => ({document:t("文档","Document"),audio:t("音频","Audio"),github:"GitHub",page:t("单个网页","Web page"),site:t("整站","Website"),text:t("粘贴文本","Text")}[kind] || kind);
  const adminReeDetail = createAdminReeDetail({
    ...ctx, renderTable: table, auditTable,
    statisticsPage: (dot, query) => adminStatistics.page(dot, query),
    owner: dot => user(ownerId(dot)),
    categoryLabel: dot => classification.categoryLabel(dot),
    kindLabel: adminKindLabel,
  });
  const adminReeSource = createAdminReeSource({...ctx,reeRecord:adminReeDetail.record,kindLabel:adminKindLabel});
  const adminStatistics = createAdminReeStatistics({...ctx,reeRecord:adminReeDetail.record});
  function consoleSeed() {
    return {
      installed: true,
      adminEmail: "admin@example.com",
      admins: [
        { name: "RE0 Admin", email: "admin@example.com", role: "Owner" },
      ],
      users: [
        {
          id: "u-lin",
          name: "林舟",
          email: "linzhou@example.com",
          status: "active",
          plan: 82400,
          pack: 100000,
          earned: 620000,
          kyc: "verified",
          tax: "W-8BEN",
          subscription: "active",
          created: "2026-10-12",
        },
        {
          id: "u-alex",
          name: "Alex Chen",
          email: "alex@example.com",
          status: "active",
          plan: 46000,
          pack: 0,
          earned: 510000,
          kyc: "verified",
          tax: "W-9",
          subscription: "active",
          created: "2026-10-18",
        },
        {
          id: "u-mia",
          name: "Mia",
          email: "mia@example.com",
          status: "active",
          plan: 0,
          pack: 26000,
          earned: 18000,
          kyc: "processing",
          tax: "W-8BEN",
          subscription: "cancelled",
          created: "2026-10-21",
        },
        {
          id: "u-ethan",
          name: "Ethan",
          email: "ethan@example.com",
          status: "active",
          plan: 68800,
          pack: 100000,
          earned: 24000,
          kyc: "rejected",
          tax: "W-8BEN",
          subscription: "active",
          created: "2026-10-24",
        },
        {
          id: "u-chuan",
          name: "小川",
          email: "chuan@example.com",
          status: "disabled",
          plan: 0,
          pack: 18000,
          earned: 30000,
          kyc: "none",
          tax: "—",
          subscription: "expired",
          created: "2026-10-26",
        },
      ],
      models: [
        {
          id: "gen-a",
          kind: "generation",
          name: "日常问答",
          model: "openai/gpt-4.1-mini",
          transport: "gateway",
          base: "https://ai-gateway.vercel.sh/v1",
          tail: "4f8a",
          timeout: 60,
          enabled: true,
        },
        {
          id: "gen-b",
          kind: "generation",
          name: "备用生成端点",
          model: "demo-generation",
          transport: "compatible",
          base: "https://api.example.com/v1",
          tail: "1a2b",
          timeout: 60,
          enabled: false,
        },
        {
          id: "emb-a",
          kind: "embedding",
          name: "当前向量模型",
          model: "openai/text-embedding-3-small",
          transport: "gateway",
          base: "https://ai-gateway.vercel.sh/v1",
          tail: "4f8a",
          timeout: 30,
          enabled: true,
        },
        {
          id: "emb-b",
          kind: "embedding",
          name: "候选向量模型",
          model: "text-embedding-3-large",
          transport: "compatible",
          base: "https://api.example.com/v1",
          tail: "9c2e",
          timeout: 45,
          enabled: false,
        },
        {
          id: "tra-a",
          kind: "transcription",
          name: "音频转写",
          model: "openai/whisper-1",
          transport: "gateway",
          base: "https://ai-gateway.vercel.sh/v1",
          tail: "4f8a",
          timeout: 180,
          enabled: true,
        },
      ],
      kyc: [
        {
          id: "kyc-lin",
          user: "u-lin",
          status: "verified",
          provider: "Persona",
          session: "inq_demo_a19f",
          tax: "W-8BEN",
          declared: true,
          submitted: "2026-10-24",
          decided: "2026-10-24",
          reason: "",
        },
        {
          id: "kyc-alex",
          user: "u-alex",
          status: "verified",
          provider: "Persona",
          session: "inq_demo_b62c",
          tax: "W-9",
          declared: true,
          submitted: "2026-10-26",
          decided: "2026-10-26",
          reason: "",
        },
        {
          id: "kyc-mia",
          user: "u-mia",
          status: "processing",
          provider: "Persona",
          session: "inq_demo_d91a",
          tax: "W-8BEN",
          declared: true,
          submitted: "2026-10-30",
          decided: "—",
          reason: "",
        },
        {
          id: "kyc-ethan",
          user: "u-ethan",
          status: "rejected",
          provider: "Persona",
          session: "inq_demo_f82d",
          tax: "W-8BEN",
          declared: true,
          submitted: "2026-10-29",
          decided: "2026-10-29",
          reason: "演示：提供的信息与验证记录不一致。",
        },
      ],
      purchases: [
        {
          id: "txn_demo_24y",
          user: "me",
          kind: "plan",
          amount: 10,
          credits: 100000,
          status: "paid",
          created: "2026-10-24",
        },
        {
          id: "txn_demo_28p",
          user: "me",
          kind: "pack",
          amount: 10,
          credits: 100000,
          status: "paid",
          created: "2026-10-28",
        },
        {
          id: "txn_demo_l01",
          user: "u-lin",
          kind: "plan",
          amount: 10,
          credits: 100000,
          status: "paid",
          created: "2026-10-24",
        },
        {
          id: "txn_demo_a02",
          user: "u-alex",
          kind: "pack",
          amount: 10,
          credits: 100000,
          status: "refunded",
          created: "2026-10-27",
        },
        {
          id: "txn_demo_m03",
          user: "u-mia",
          kind: "plan",
          amount: 10,
          credits: 100000,
          status: "paid",
          created: "2026-10-26",
        },
        {
          id: "txn_demo_e04",
          user: "u-ethan",
          kind: "pack",
          amount: 10,
          credits: 100000,
          status: "chargeback",
          created: "2026-10-29",
        },
      ],
      historyPayouts: [
        {
          id: "paid01",
          user: "u-lin",
          name: "林舟",
          email: "linzhou@example.com",
          credits: 550000,
          status: "paid",
          tax: "W-8BEN",
          created: "2026-10-20",
          reviewer: "admin@example.com",
          batch: "DEMO-PAYOUT-001",
          fee: 1.2,
        },
        {
          id: "reject02",
          user: "u-alex",
          name: "Alex Chen",
          email: "alex@example.com",
          credits: 500000,
          status: "rejected",
          tax: "W-9",
          created: "2026-10-22",
          reviewer: "admin@example.com",
          batch: "—",
          fee: 0,
        },
      ],
      audits: [
        {
          id: "audit-1",
          actor: "admin@example.com",
          action: "model.create",
          target: "gen-a",
          before: null,
          after: { model: "openai/gpt-4.1-mini", enabled: true },
          created: "2026-10-24 09:15",
        },
        {
          id: "audit-2",
          actor: "admin@example.com",
          action: "user.disable",
          target: "u-chuan",
          before: "active",
          after: "disabled",
          created: "2026-10-29 16:22",
        },
        {
          id: "audit-3",
          actor: "admin@example.com",
          action: "payout.approve",
          target: "paid01",
          before: "pending",
          after: "paid",
          created: "2026-10-20 11:30",
        },
      ],
      notices: [],
      job: null,
    };
  }
  function ensure() {
    if (!S().console) {
      S().console = consoleSeed();
      save();
    }
    if (!S().console.users.some((u) => u.id === "u-june"))
      S().console.users.push({
        id: "u-june",
        name: "Studio June",
        email: "june@example.com",
        status: "active",
        plan: 100000,
        pack: 0,
        earned: 21000,
        kyc: "none",
        tax: "—",
        subscription: "active",
        created: "2026-10-25",
      });
    if (!S().console.payoutPageExamples) {
      for (const [id, userId, status] of [
        ["p-review-demo", "u-lin", "pending"],
        ["p-payment-demo", "u-alex", "approved"],
      ]) {
        const u = S().console.users.find((u) => u.id === userId);
        if (
          u &&
          u.earned >= 500000 &&
          !S().console.historyPayouts.some((p) => p.id === id)
        ) {
          S().console.historyPayouts.unshift({
            id,
            user: userId,
            name: u.name,
            email: u.email,
            tax: u.tax,
            credits: 500000,
            status,
            created: date(),
            reviewer:
              status === "approved" ? S().console.adminEmail : undefined,
            reviewedAt:
              status === "approved" ? new Date().toISOString() : undefined,
          });
          u.earned -= 500000;
        }
      }
      S().console.payoutPageExamples = true;
      save();
    }
    if (normalizeManualKyc(S())) save();
    S().adminPayouts.forEach((p) => (p.created ??= "2026-10-30"));
    U().consoleFilters ??= {};
    U().detailTab ??= "summary";
    U().videoTime ??= 0;
    userRoles.ensure();
  }
  function users() {
    return [
      {
        id: "me",
        role: userRoles.roleFor("me"),
        roleChangedAt: S().roleChangedAt,
        name: S().displayName || "Yu Zhao",
        email: "yu@example.com",
        status: S().disabled ? "disabled" : "active",
        plan: S().planCredits,
        pack: S().packCredits,
        earned: S().earnedCredits,
        kyc: S().kyc,
        tax: S().tax,
        subscription: S().plan
          ? S().cancelled
            ? "cancelled"
            : "active"
          : "expired",
        created: "2026-10-24",
      },
      ...S().console.users,
    ];
  }
  const user = (id) => users().find((u) => u.id === id);
  const ownerId = (b) =>
    b.owner === "me"
      ? "me"
      : S().console.users.find((u) => u.name === b.owner)?.id || "u-lin";
  function payouts() {
    return [
      ...S().payouts.map((p) => ({
        ...p,
        user: "me",
        name: S().displayName || "Yu Zhao",
        tax: S().tax,
        created: p.created || date(),
      })),
      ...S().adminPayouts.map((p, i) => ({
        ...p,
        user: i === 0 ? "u-lin" : "u-alex",
        created: p.created || "2026-10-30",
      })),
      ...S().console.historyPayouts,
    ];
  }
  function audit(action, target, before, after) {
    ensure();
    S().console.audits.unshift({
      id: uid(),
      actor: S().console.adminEmail,
      action,
      target,
      before,
      after,
      created:
        date() +
        " " +
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Kuching",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date()),
    });
    save();
  }
  function notice(text, target = "me") {
    S().console.notices.unshift({ id: uid(), text, user: target });
  }
  const manualKyc = createManualKyc(ctx, {
    audit,
    notice,
    user,
    tag,
    table,
    filterBar,
    filtered,
    sectionHead,
    userLink,
  });
  const adminRecords = createAdminRecords({
    ...ctx, tag, table, sectionHead, download,
    actualRows: kind => kind === "users" ? users() : kind === "kyc" ? kycRows() : kind === "purchases" ? S().console.purchases : kind === "audit" ? S().console.audits : payouts().map(row => {
      const original = findPayout(row.id);
      return {...row, adminTimeUnknown: !!original && !original.created && !original.createdAt};
    }),
  });
  function marketingHeader(active = "", { signInPath = "/login" } = {}) {
    return `<header class="marketing-header"><div class="marketing-nav">${wordmark()}<nav aria-label="${t("官网导航", "Website navigation")}">${[
      ["/", t("首页", "Home")],
      ["/explore", t("发现 Ree", "Discover")],
      ["/pricing", t("价格与购买", "Pricing")],
    ]
      .map(([url, label]) => L(url, label, active === url ? "current" : ""))
      .join(
        "",
      )}</nav><div class="flex">${btn(stateLanguage(), "language", "ghost sm", `aria-label="${t("切换语言", "Switch language")}"`)}${L(S().signed ? "/dashboard" : signInPath, S().signed ? t("进入", "Open ") + experience.label() : t("登录", "Sign in"), "btn secondary")}${L(S().signed ? "/dots" : "/login?next=%2Fdots", `${t("创建你的 Ree", "Create your Ree")} ${I("arrow")}`, "btn marketing-cta")}</div></div></header>`;
  }
  function stateLanguage() {
    return S().lang === "zh" ? "中 / EN" : "EN / 中";
  }
  function marketingFooter() {
    return `<footer class="marketing-footer"><div class="marketing-wrap"><div class="footer-top"><div>${wordmark()}<p>${t("让你的知识，拥有自己的声音。", "Give your knowledge a voice of its own.")}<br><span class="mono">A LITTLE KNOWLEDGE. A NEW POSSIBILITY.</span></p></div><div><strong>${t("产品", "Product")}</strong>${L("/explore", t("发现知识", "Discover"), "")}${L("/pricing", t("价格与购买", "Pricing"), "")}${L("/dashboard", t("我的工作台", "Workspace"), "")}</div><div><strong>${t("你的空间", "Your space")}</strong>${L("/dots", t("我的 Ree", "My Rees"), "")}${L("/chats", t("我的对话", "Conversations"), "")}${L("/settings?tab=billing", t("余额与收入", "Credits & earnings"), "")}</div><div><strong>${t("关于 RE0", "About RE0")}</strong>${L("/legal/terms", t("服务条款", "Terms"), "")}${L("/legal/privacy", t("隐私政策", "Privacy"), "")}${L("/admin/login", t("管理后台", "Administration"), "")}</div></div><div class="footer-bottom"><span>© 2026 RE0. ${t("知识，值得被认真对待。", "Knowledge deserves care.")}</span><span class="flex"><i class="dot"></i>${t("交互设计原型 · 本地演示", "Interactive prototype · Local demo")}</span>${btn(t("查看全站导览", "Site map"), "guide", "ghost sm")}</div></div></footer>`;
  }
  function marketingShell(content, active = "") {
    return `<div class="marketing-site">${marketingHeader(active)}<main id="main" tabindex="-1">${content}</main>${marketingFooter()}</div>`;
  }
  function demoVisual() {
    return `<div class="hero-demo"><div class="demo-window-head"><span><i></i><i></i><i></i></span><span>my-knowledge / design-partner</span>${I("shield")}</div><div class="demo-window-body"><div class="demo-source-panel"><p class="eyebrow">KNOWLEDGE</p>${[
      ["file", "设计系统手册.pdf", "24 pages"],
      ["github", "design / components", "GitHub"],
      ["audio", "上周的灵感讨论.m4a", "18:24"],
      ["globe", "design.re0.ai", "12 pages"],
    ]
      .map(
        ([ic, name, note]) =>
          `<div class="demo-source">${I(ic)}<div><strong>${name}</strong><small>${note}</small></div><span class="dot"></span></div>`,
      )
      .join(
        "",
      )}<div class="demo-add">${I("plus")} ${t("一些知识，新的可能", "A little knowledge. New possibilities.")}</div></div><div class="demo-conversation"><div class="flex">${avatar(dotById("design"), true)}<span>${t("产品设计顾问", "Design partner")}<small>${t("知识已就绪", "Knowledge ready")}</small></span><span class="demo-online"></span></div><div class="demo-user">${t("设计系统，应该从哪里开始？", "Where should a design system begin?")}</div><div class="demo-answer" id="home-demo-answer"><span class="demo-answer-icon">${I("sparkle")}</span><p>${t("从一套共同的语言开始。<br>先统一颜色、字体和间距，再让组件把它们连接起来。", "Start with a shared language.<br>Unify colors, typography, and spacing, then connect them through components.")} <sup>1</sup></p><button class="citation-chip" data-action="home-citation">${I("file")} 1 · ${t("设计系统手册 · 第 24 页", "Design systems · Page 24")} ${I("external")}</button></div><div class="demo-compose">${t("每个好问题，都有它的来处。", "Every good question has a source.")}<span>${I("send")}</span></div></div></div><div class="demo-float-label">${I("file")}${t("每个回答，都有据可依。", "Every answer, grounded in knowledge.")}</div></div>`;
  }
  function home() {
    return marketingShell(
      `<section class="home-hero marketing-wrap"><div class="home-hero-copy"><div class="launch-pill"><i class="dot"></i>${t("你的知识，现在可以对话。", "Your knowledge is ready for a conversation.")}${I("arrow")}</div><h1>${t("让知识，<br>成为<em>懂你的伙伴。</em>", "Your knowledge.<br><em>A voice of its own.</em>")}</h1><p>${t("创建一个 Ree，给它一些知识。<br>从此，文档、灵感和经验，都能开口回答。", "Create a Ree. Give it some knowledge.<br>Let documents, ideas, and experience answer back.")}</p><div class="home-hero-actions">${L(S().signed ? "/dots" : "/login?next=%2Fdots", `${t("创建你的第一个 Ree", "Create your first Ree")} ${I("arrow")}`, "btn large")}${btn(`${I("play")}${t("看看它如何回答", "See how it answers")}`, "home-demo", "secondary large")}</div><div class="home-trial"><span>${I("check")}${t("注册赠送 2,000 credits", "2,000 welcome credits")}</span><span>${I("check")}${t("只回答它知道的", "Answers within its knowledge")}</span></div></div>${demoVisual()}<span class="hero-index mono">01 — KNOWLEDGE, GIVEN A VOICE</span></section><section class="source-strip"><div class="marketing-wrap"><span>${t("你熟悉的知识，都能成为起点", "Start with the knowledge you already have")}</span><div>${[
        ["file", "PDF / Word"],
        ["text", "Markdown / TXT"],
        ["audio", t("音频", "Audio")],
        ["github", "GitHub"],
        ["globe", t("网页与整站", "Pages & websites")],
        ["text", t("你的笔记", "Your notes")],
      ]
        .map(([ic, name]) => `<span>${I(ic)}${name}</span>`)
        .join(
          "",
        )}</div></div></section><section class="marketing-wrap home-section"><div class="section-intro"><p class="eyebrow">A SMALL IDEA. A COMPLETE EXPERIENCE.</p><h2>${t("把知识留在身边，<br>让答案走近一点。", "Keep knowledge close.<br>Bring answers closer.")}</h2><p>${t("把熟悉的资料与经验连接起来，<br>在需要的时候，得到有出处的回答。", "Make the knowledge you already have<br>ready to help when you need it.")}</p></div><div class="home-feature-grid"><article class="feature-knowledge"><div class="feature-illustration"><div class="feature-file">${I("file")}<span>product-notes.md</span><i class="dot"></i></div><div class="feature-file">${I("audio")}<span>team-conversation.m4a</span><i class="dot"></i></div><div class="feature-file">${I("github")}<span>your-repository</span><i class="dot"></i></div></div><span class="eyebrow">01 / TEACH</span><h3>${t("给它知识，不用写代码。", "Teach it without writing code.")}</h3><p>${t("上传文档、音频，连接仓库或网站。处理进度和失败原因，始终清楚可见。", "Add documents, audio, repositories, or websites. Processing and errors are always visible.")}</p></article><article class="feature-citation"><div class="feature-quote">“${t("每一个结论，<br>都能回到原来的那一页。", "Every conclusion.<br>Back to its original source.")}”<span class="feature-cite">1</span><span>${I("file")} ${t("第 24 页 · 原文引用", "Page 24 · Original source")}</span></div><span class="eyebrow">02 / ASK</span><h3>${t("答案有依据，不确定就说不知道。", "Grounded answers. Honest limits.")}</h3><p>${t("页码、时间戳、代码行号，跟着答案一起出现。不在知识范围内，就不作答、不收费。", "Pages, timestamps, and code lines travel with the answer. No relevant knowledge means no charge.")}</p></article><article class="feature-group"><div class="feature-avatars">${["design", "code", "read"].map((id) => avatar(dotById(id))).join("<span>+</span>")}<div>${t("一个问题，不同视角。", "One question. Different perspectives.")}</div></div><span class="eyebrow">03 / CONNECT</span><h3>${t("把不同的知识，带进同一场对话。", "Bring different knowledge together.")}</h3><p>${t("最多 5 个 Ree 独立作答。需要更专注的时候，@ 它一个就好。", "Invite up to five Rees. Each answers independently. Use @ when you want just one perspective.")}</p></article></div></section><section class="home-workflow"><div class="marketing-wrap"><div class="between home-section-head"><div><p class="eyebrow">LESS SETUP. MORE CONVERSATION.</p><h2>${t("从一份知识开始，<em>三步就好。</em>", "From a source to a conversation.<em>Three simple steps.</em>")}</h2></div>${L("/login?next=%2Fdots", t("现在开始", "Start now") + I("arrow"), "text-link")}</div><div class="workflow-steps">${[
        [
          "01",
          t("创建一个 Ree", "Create a Ree"),
          t(
            "起个名字，告诉它应该如何回答。",
            "Give it a name and a way to answer.",
          ),
          "dot",
        ],
        [
          "02",
          t("添加你的知识", "Add your knowledge"),
          t(
            "从一份文档、一个链接或一段文字开始。",
            "Start with a document, a link, or a note.",
          ),
          "file",
        ],
        [
          "03",
          t("问一个好问题", "Ask a good question"),
          t(
            "得到回答，沿着引用找到它的依据。",
            "Get an answer and follow its sources.",
          ),
          "chat",
        ],
      ]
        .map(
          ([num, h, p, ic]) =>
            `<article><span class="mono">${num}</span>${I(ic)}<h3>${h}</h3><p>${p}</p></article>`,
        )
        .join(
          "",
        )}</div></div></section><section class="marketing-wrap home-section"><div class="between home-section-head"><div><p class="eyebrow">A COMPANION FOR EVERY CURIOSITY</p><h2>${t("有些问题，<em>它们刚好知道。</em>", "Some questions.<em>The right companions.</em>")}</h2><span class="tiny muted">${t("以下为可体验的示例 Ree", "Illustrative Rees you can explore")}</span></div><div class="home-dot-row">${publicDots()
        .slice(0, 3)
        .map(
          (b) =>
            `<article class="card home-dot-card"><div class="between">${avatar(b)}${btn(I("play") + " 15s", "play-video", "ghost sm", `data-id="${b.id}"`)}</div><h3>${esc(title(b))}</h3><p>${esc(desc(b))}</p><div class="between"><span class="mono">${fee(b)} <small>credits / ${t("次", "answer")}</small></span>${L("/d/" + b.slug, t("查看详情", "View details") + I("arrow"), "text-link")}</div></article>`,
        )
        .join(
          "",
        )}</div><div class="home-center-link">${L("/explore", t("发现更多知识同伴", "Discover more companions") + I("arrow"), "text-link")}</div></section><section class="home-price-section"><div class="marketing-wrap"><div><p class="eyebrow">SIMPLE CREDITS. CLEAR VALUE.</p><h2>${t("为真正有帮助的回答，<br>支付清楚的价格。", "Clear prices.<br>Only for helpful answers.")}</h2><p>${t("成功作答才收费。<br>你的知识带来的查询收入，100% 回到你手中。", "Only successful answers incur a charge.<br>The entire owner query fee becomes your earned credits.")}</p>${L("/pricing", t("了解价格与 Credits", "Explore pricing & credits") + I("arrow"), "btn secondary")}</div><div class="home-price-preview"><div class="between"><span>PLAN</span><span class="tag blue">${t("按月订阅", "Monthly")}</span></div><p><strong>$10</strong> / ${t("月", "month")}</p><h3>100,000 credits</h3><div class="rule"></div><span>${I("check")}${t("当期额度，用来探索和创造", "Credits for learning and creating")}</span><span>${I("check")}${t("可购买永久有效的 Pack", "Unlock non-expiring packs")}</span><span>${I("check")}${t("随时取消，使用至周期末", "Cancel anytime, use until period end")}</span></div></div></section><section class="marketing-wrap home-section home-faq"><div><p class="eyebrow">A FEW THINGS YOU MIGHT WONDER</p><h2>${t("好奇，<br>就从这里开始。", "A little curiosity<br>starts here.")}</h2></div><div>${faqItems()
        .slice(0, 4)
        .map(
          ([q, a]) =>
            `<details><summary>${q}${I("plus")}</summary><p>${a}</p></details>`,
        )
        .join(
          "",
        )}</div></section><section class="marketing-wrap final-cta"><p class="eyebrow">YOUR KNOWLEDGE. A NEW POSSIBILITY.</p><h2>${t("你的知识，<em>值得被听见。</em>", "Your knowledge.<em>Ready to be heard.</em>")}</h2>${L("/login?next=%2Fdots", t("创建你的第一个 Ree", "Create your first Ree") + I("arrow"), "btn large")}<p>${t("注册赠送 2,000 credits，让第一个问题开始。", "Start your first question with 2,000 welcome credits.")}</p></section>`,
      "/",
    );
  }
  function faqItems() {
    return [
      [
        t(
          "Ree 和普通 AI 聊天有什么区别？",
          "How is a Ree different from general AI chat?",
        ),
        t(
          "每个 Ree 只根据自己绑定的知识回答，答案包含具体来源。没有相关知识时，它会明确说明，并且不收费。",
          "A Ree only answers from its own sources and includes citations. No relevant knowledge means no answer and no charge.",
        ),
      ],
      [
        t("我的知识会直接公开吗？", "Will my knowledge become public?"),
        t(
          "新建 Ree 默认私有。公开后展示简介和知识来源标题，完整知识正文不会直接公开；回答中的引用只展示相关片段。",
          "New Rees are private. Public pages show descriptions and source titles, not full source text; citations contain relevant excerpts.",
        ),
      ],
      [
        t(
          "Plan 和 Pack 有什么区别？",
          "What is the difference between Plan and Pack?",
        ),
        t(
          "Plan 每月 $10，提供当期有效的 100,000 credits。有效订阅期间可购买 $10 的 Pack，每份 100,000 credits 永不过期，取消 Plan 后仍可使用。",
          "Plan costs $10/month for 100,000 credits that expire each cycle. An active Plan unlocks $10 packs of 100,000 non-expiring credits.",
        ),
      ],
      [
        t(
          "多个 Ree 一起回答，如何收费？",
          "How are multi-Ree conversations charged?",
        ),
        t(
          "发送前会显示并预留最高可能费用。每个实际作答的 Ree 收取 20 credits 基本费，加上其查询费；未作答部分会退回。",
          "The maximum cost is shown and reserved before sending. Each answering Ree charges 20 base credits plus its owner fee. Unused reservations are released.",
        ),
      ],
      [
        t("创作者收入可以提现吗？", "Can creators withdraw earnings?"),
        t(
          "查询费全额进入收入 credits。通过身份验证并填写税务声明、绑定 PayPal 后，收入达到 500,000 credits（$50）可申请提现。",
          "Owner fees become earned credits. With identity and tax verification and PayPal setup, earnings of at least 500,000 credits ($50) may be withdrawn.",
        ),
      ],
      [
        t("视频介绍如何收费？", "How much does a video introduction cost?"),
        t(
          "固定 15 秒；生成脚本 20 credits。每个 Ree 首次导出免费，之后每次 50 credits。缓存命中、在线播放和分享链接免费。",
          "Videos last 15 seconds. Scripts cost 20 credits. The first export per Ree is free, later exports cost 50 credits. Cached exports, playback, and sharing are free.",
        ),
      ],
    ];
  }
  function pricing() {
    return marketingShell(
      `<div class="marketing-wrap pricing-page"><div class="pricing-intro"><p class="eyebrow">SMALL PRICE. A WORLD OF KNOWLEDGE.</p><h1>${t("简单的价格，<em>清楚的价值。</em>", "Simple pricing.<em>Clear value.</em>")}</h1><p>${t("一份订阅，开启知识的更多可能。按实际使用计费，随时知道每一笔消耗。", "One plan to explore more. Pay for actual use and see where every credit goes.")}</p><span class="price-rate mono">1 CREDIT = $0.0001</span></div><div class="purchase-plans"><article class="purchase-plan"><span class="eyebrow">EXPLORE FIRST</span><h2>${t("先试试看", "Start exploring")}</h2><p class="purchase-amount">$0</p><p class="plan-grant">2,000 <span>credits</span></p><p>${t("新用户注册赠送，不设有效期。", "Welcome credits for new users. No expiration.")}</p>${L(S().signed ? "/dashboard" : "/login", t("免费开始", "Get started free"), "btn secondary full")}<ul><li>${I("check")}${t("创建自己的 Ree", "Create your own Rees")}</li><li>${I("check")}${t("添加六种知识来源", "Add six kinds of knowledge")}</li><li>${I("check")}${t("体验带引用的回答", "Try source-based answers")}</li></ul></article><article class="purchase-plan recommended"><span class="plan-ribbon">${t("让好奇心持续发生", "KEEP YOUR CURIOSITY GOING")}</span><span class="eyebrow">YOUR EVERYDAY KNOWLEDGE</span><h2>Plan</h2><p class="purchase-amount">$10 <small>/ ${t("月", "month")}</small></p><p class="plan-grant">100,000 <span>credits / ${t("周期", "cycle")}</span></p><p>${t("当期有效，周期结束后余额失效。", "Valid for this cycle. Unused credits expire.")}</p>${S().plan && S().signed ? L("/settings?tab=billing", t("管理当前 Plan", "Manage current Plan"), "btn full") : btn(t("订阅 Plan", "Subscribe to Plan") + I("arrow"), "start-purchase", "full", 'data-kind="plan"')}<ul><li>${I("check")}${t("先消耗 Plan 当期额度", "Plan credits are spent first")}</li><li>${I("check")}${t("可购买永久有效的 Pack", "Unlock non-expiring Pack credits")}</li><li>${I("check")}${t("随时取消，使用至周期末", "Cancel anytime, keep access until period end")}</li></ul></article><article class="purchase-plan"><span class="eyebrow">A LITTLE EXTRA, WHEN YOU NEED IT</span><h2>Pack</h2><p class="purchase-amount">$10 <small>/ ${t("份", "pack")}</small></p><p class="plan-grant">100,000 <span>credits</span></p><p>${t("一次购买，永久有效，可多次补充。", "One-time purchase. Never expire. Buy as needed.")}</p>${btn(S().signed && !S().plan ? t("订阅 Plan 后可购买", "Available with a Plan") : t("购买 Pack", "Buy a Pack"), "start-purchase", "secondary full", `data-kind="pack" ${S().signed && !S().plan ? "disabled" : ""}`)}<ul><li>${I("check")}${t("需要当前有效的 Plan", "Requires an active Plan")}</li><li>${I("check")}${t("已有 Pack 在取消订阅后仍可用", "Purchased packs survive cancellation")}</li><li>${I("check")}${t("支持一次购买多份", "Buy multiple packs at once")}</li></ul></article></div><section class="pricing-costs card"><div class="between"><div><p class="eyebrow">EVERY CREDIT, EXPLAINED</p><h2>${t("Credits 会用在哪里？", "Where do credits go?")}</h2></div><span class="tag blue">${t("无回答，不收费", "No answer, no charge")}</span></div>${table(
        [
          t("使用场景", "Activity"),
          t("消耗规则", "Credit cost"),
          t("说明", "Details"),
        ],
        [
          [
            t("向 Ree 提问", "Ask a Ree"),
            "20 credits / " + t("实际作答", "answer"),
            t(
              "他人的 Ree 另加其查询费；自己的 Ree 不加查询费。",
              "Other Rees add their owner fee; your own Ree only charges the base fee.",
            ),
          ],
          [
            t("文档、网页等知识处理", "Process knowledge"),
            "1 credit / 1,000 " + t("字符", "characters"),
            t(
              "按提取文本量结算，处理失败全额退回。",
              "Settled by extracted text. Full refund on failure.",
            ),
          ],
          [
            t("音频转写", "Audio transcription"),
            "100 credits / " + t("分钟", "minute"),
            t(
              "另加文本处理费用；音频会发送给转写服务。",
              "Plus text-processing costs. Audio is sent to a transcription provider.",
            ),
          ],
          [
            t("视频脚本", "Video script"),
            "20 credits / " + t("次", "generation"),
            t(
              "生成或重新生成 4 镜头脚本。",
              "Generate or regenerate a four-scene script.",
            ),
          ],
          [
            t("15 秒视频导出", "15-second export"),
            t("首次免费，之后 50 credits", "First free, then 50 credits"),
            t(
              "每个 Ree 单独计算首次；缓存命中免费。",
              "First-export allowance is per Ree. Cached exports are free.",
            ),
          ],
        ],
      )}</section><section class="pricing-estimator card"><div><h2>${t("把费用，换成更直观的数字。", "Make the numbers feel tangible.")}</h2><p>${t("以问自己的 Ree 为例，100 次成功回答消耗 2,000 credits。", "For your own Ree, 100 successful answers cost 2,000 credits.")}</p></div><div><label for="question-range">${t("成功回答次数", "Successful answers")}<strong id="estimate-count">100</strong></label><input id="question-range" type="range" min="10" max="1000" step="10" value="100"><p><strong class="mono" id="estimate-credit">2,000</strong> credits <span id="estimate-dollar">≈ $0.20</span></p></div></section><section class="home-faq pricing-faq"><div><p class="eyebrow">NO SMALL PRINT, JUST CLARITY</p><h2>${t("关于价格，<br>你可能还想知道。", "A few more<br>pricing questions.")}</h2></div><div>${faqItems()
        .slice(2)
        .map(
          ([q, a]) =>
            `<details><summary>${q}${I("plus")}</summary><p>${a}</p></details>`,
        )
        .join("")}</div></section></div>`,
      "/pricing",
    );
  }
  function checkout() {
    const kind = route().query.get("kind") === "pack" ? "pack" : "plan",
      quantity =
        kind === "pack"
          ? Math.max(
              1,
              Math.min(10, Number(route().query.get("quantity")) || 1),
            )
          : 1;
    U().checkoutQuantity = quantity;
    const locked = kind === "pack" && !S().plan;
    return marketingShell(
      `<div class="checkout-page marketing-wrap"><div class="checkout-breadcrumb"><span>01 / ${t("确认订单", "Review order")} <i>—</i> 02 / ${t("完成购买", "Complete purchase")}</span></div><div class="checkout-grid"><section><p class="eyebrow">MAKE ROOM FOR YOUR NEXT QUESTION</p><h1>${t("为下一次好奇，<br>准备一些 Credits。", "Make room for<br>your next question.")}</h1><div class="card checkout-account"><div class="between"><h3>${t("你的账号", "Your account")}</h3>${tag(S().signed ? "active" : "none")}</div>${S().signed ? `<div class="flex mt24"><span class="avatar user">YZ</span><div><strong>${esc(S().displayName || "Yu Zhao")}</strong><p>yu@example.com</p></div></div>` : `<p class="muted mt16">${t("登录后，Credits 将充值到你的个人账号。", "Sign in so your credits reach the right account.")}</p>${L("/login?next=" + encodeURIComponent(route().path + "?kind=" + kind), t("登录并继续", "Sign in to continue") + I("arrow"), "btn mt24")}`}</div><div class="info-strip mt24">${I("shield")}<span>${t("正式产品由 Paddle 托管结账并处理税费与发票。当前为本地原型，点击确认只会更新演示余额，不产生真实付款。", "Production checkout is hosted by Paddle, which handles tax and invoices. This prototype only updates demo credits and never charges you.")}</span></div></section><aside class="card order-summary"><span class="eyebrow">ORDER SUMMARY</span><div class="between mt24"><h2>${kind === "plan" ? "RE0 Plan" : "RE0 Pack"}</h2><span class="tag blue">${kind === "plan" ? t("按月订阅", "Monthly subscription") : t("一次性购买", "One-time purchase")}</span></div><p>${kind === "plan" ? t("每个计费周期 100,000 credits", "100,000 credits every billing cycle") : t("每份 100,000 credits，永久有效", "100,000 non-expiring credits per pack")}</p>${kind === "pack" ? `<div class="quantity-row"><label for="pack-quantity">${t("购买数量", "Quantity")}</label><select id="pack-quantity">${Array.from({ length: 10 }, (_, i) => `<option value="${i + 1}" ${quantity === i + 1 ? "selected" : ""}>${i + 1} ${t("份", "pack(s)")}</option>`).join("")}</select></div>` : ""}<div class="order-line"><span>${t("商品金额", "Subtotal")}</span><strong id="order-subtotal">${money(quantity * 10)}</strong></div><div class="order-line"><span>${t("税费", "Taxes")}</span><span>${t("结账时计算", "Calculated at checkout")}</span></div><div class="rule"></div><div class="order-total"><span>${t("合计（税前）", "Total before tax")}</span><strong id="order-total">${money(quantity * 10)}</strong></div><p id="order-credit">${n(quantity * 100000)} credits${kind === "plan" ? " / " + t("周期", "cycle") : ""}</p><form id="suite-order-form" data-kind="${kind}"><label class="order-consent"><input type="checkbox" name="consent" required>${t("我了解这是模拟购买，不会真实付款。", "I understand this is a simulated purchase without a real charge.")}</label>${locked ? `<div class="form-error">${t("购买 Pack 需要有效 Plan。请先订阅。", "An active Plan is required to buy a Pack.")}</div>${L("/checkout?kind=plan", t("先订阅 Plan", "Subscribe to Plan first"), "btn full")}` : S().plan && kind === "plan" ? L("/settings?tab=billing", t("你已有有效 Plan · 管理订阅", "You have an active Plan · Manage"), "btn full") : `<button class="btn full large" type="submit" ${S().signed ? "" : "disabled"}>${t("确认模拟购买", "Confirm demo purchase")} ${I("arrow")}</button>`}</form><span class="order-secure">${I("lock")}${t("不收集银行卡或真实支付信息", "No payment details collected")}</span></aside></div></div>`,
      "/pricing",
    );
  }
  function login() {
    return `<div class="suite-login"><section class="suite-login-story">${wordmark()}<div><p class="eyebrow">A SPACE FOR YOUR KNOWLEDGE</p><h1>${t("让你知道的，<br>成为<em>更多的可能。</em>", "What you know.<br><em>What comes next.</em>")}</h1><p>${t("一份笔记，一段对话，一个新的灵感。<br>从你的第一个 Ree 开始。", "A note, a conversation, a new idea.<br>Start with your first Ree.")}</p><div class="login-story-card"><div class="flex">${avatar(dotById("design"))}<div><strong>${t("知识，总能找到新的连接。", "Knowledge always finds a new connection.")}</strong><small>${t("只回答它知道的，每个答案都有来处。", "Answers within its knowledge. Every answer has a source.")}</small></div></div><div class="login-source-chain">${I("file")}<i></i>${I("dot")}<i></i>${I("chat")}<i></i>${I("light")}</div></div></div><span class="mono">RE0 / YOUR KNOWLEDGE. A NEW VOICE.</span></section><main id="main" tabindex="-1" class="suite-login-form"><div><div class="login-top-link">${L("/", I("arrow") + t("返回首页", "Back home"), "text-link")}${btn(stateLanguage(), "language", "ghost sm")}</div><p class="eyebrow">WELCOME TO RE0</p><h2>${t("你好，<br>新的知识伙伴。", "Hello,<br>knowledge companion.")}</h2><p>${t("登录或注册，选择从对话或创作开始。", "Sign in or join. Start with conversations or creation.")}</p><div class="oauth-buttons">${btn('<span class="google-letter" aria-hidden="true">G</span>' + t("使用 Google 继续", "Continue with Google"), "sign-in", "secondary full", 'data-provider="Google"')}${btn(I("github") + t("使用 GitHub 继续", "Continue with GitHub"), "sign-in", "secondary full", 'data-provider="GitHub"')}</div><div class="login-welcome">${I("sparkle")}<div><strong>2,000 credits</strong><span>${t("新用户注册礼，给第一个好问题。", "A welcome gift for your first good question.")}</span></div></div><p class="login-terms">${t("继续即表示同意", "By continuing, you accept our")} ${L("/legal/terms", t("服务条款", "Terms"), "text-link")} ${t("与", "and")} ${L("/legal/privacy", t("隐私政策", "Privacy"), "text-link")}。</p><div class="demo-label">${t("本地交互原型：按钮进入演示账号，不会联系 Google 或 GitHub。管理员使用独立入口登录。", "Local prototype: sign-in opens a demo account without contacting Google or GitHub. Administrators use a separate sign-in.")}</div><div class="login-other">${L("/explore", t("先发现一些 Ree", "Explore Rees first"), "text-link")}${L("/admin/login", t("管理员登录", "Admin sign-in"), "text-link")}</div></div></main></div>`;
  }
  function trendChart(
    series = [15, 24, 18, 33, 27, 41, 36, 52, 44, 60, 49, 72, 66, 80],
  ) {
    return `<div class="trend-chart"><div class="chart-y"><span>100</span><span>75</span><span>50</span><span>25</span></div><svg viewBox="0 0 700 150" preserveAspectRatio="none" aria-label="${t("最近周期的演示趋势", "Illustrative activity trend")}" role="img"><defs><linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#127ee3" stop-opacity=".15"/><stop offset="100%" stop-color="#127ee3" stop-opacity="0"/></linearGradient></defs>${[15, 50, 85, 120].map((y) => `<path d="M0 ${y}H700" stroke="#e9edf5" stroke-dasharray="3 5" fill="none"/>`).join("")}<path d="M0 150 ${series.map((v, i) => `L${(i * 700) / (series.length - 1)} ${145 - v * 1.3}`).join(" ")} L700 150Z" fill="url(#trend-fill)"/><path d="${series.map((v, i) => `${i ? "L" : "M"}${(i * 700) / (series.length - 1)} ${145 - v * 1.3}`).join(" ")}" stroke="#127ee3" stroke-width="2.5" fill="none" stroke-linejoin="round"/></svg><div class="chart-x"><span>10.01</span><span>10.08</span><span>10.15</span><span>10.22</span><span>10.31</span></div></div>`;
  }
  function dashboard() { return workspace.page(); }
  const adminNav = [
    ["overview", "layers", "概览", "Overview"],
    ["models", "code", "模型", "Models"],
    ["users", "users", "用户", "Users"],
    ["verifications", "shield", "认证申请", "Verification requests"],
    ["kyc", "shield", "KYC 记录", "KYC records"],
    ["purchases", "wallet", "充值记录", "Purchases"],
    ["payouts", "check", "提现审核", "Payout review"],
    ["payout-history", "clock", "提现记录", "Payout history"],
    ["dots", "dot", "Ree", "Rees"],
    ["audit", "file", "审计", "Audit log"],
  ];
  const userDetailTabs = [
    ["summary", "账户总览", "Account"],
    ["roles", "角色与认证", "Role & verification"],
    ["credits", "Credit 流水", "Credits"],
    ["kyc", "KYC 记录", "KYC"],
    ["purchases", "充值与订阅", "Purchases"],
    ["payouts", "提现记录", "Payouts"],
    ["dots", "名下 Ree", "Rees"],
  ];
  function consoleHeader(key) {
    const roleHeader = rolePages.header(route().path);
    if (roleHeader) return roleHeader;
    const recordHeader = adminRecords.header(route().path);
    if (recordHeader) return recordHeader;
    const section = t(
      ...(
        adminNav.find((entry) => entry[0] === key) || [
          "",
          "",
          "概览",
          "Overview",
        ]
      ).slice(2),
    );
    const detailUser =
      key === "users" && route().path.split("/")[3]
        ? user(route().path.split("/")[3])
        : null;
    const reeId = key === "dots" && route().path.split("/")[3];
    const detailRee = reeId && adminReeDetail.record(reeId);
    const sourceRoute = key === "dots" && adminReeSourceRoute(route().path);
    const detailSource = sourceRoute && adminReeSource.record(sourceRoute.reeId,sourceRoute.sourceId);
    const payoutId = key === "payouts" && route().path.split("/")[3];
    const payoutRecord = payoutId && payouts().find((p) => p.id === payoutId);
    const payoutListLabel =
      payoutBackPath().startsWith("/admin/payout-history")
        ? t("提现记录", "Payout history")
        : t("提现审核", "Payout review");
    const kycId = key === "kyc" && route().path.split("/")[3];
    const kycRecord = kycId && S().console.kyc.find((k) => k.id === kycId);
    const pathLink = (path, label) => `<a href="#${path}" title="${esc(label)}">${esc(label)}</a>`;
    const parts = [
      pathLink("/admin/overview", t("管理后台", "Console")),
      reeId
        ? pathLink(adminReeDetail.backPath(detailRee), adminReeDetail.backPath(detailRee).startsWith("/admin/users/") ? t("名下 Ree", "User’s Rees") : t("Ree 管理", "Rees"))
        : payoutId
        ? pathLink(payoutBackPath(), payoutListLabel)
        : detailUser
          ? pathLink(adminRecordBackPath(route().query.get("from"), "users"), t(...adminNav.find(entry=>entry[0]===adminRecordBackPath(route().query.get("from"), "users").split("/")[2].split("?")[0]).slice(2)))
          : kycId
            ? pathLink(adminRecordBackPath(route().query.get("from"), "kyc"), section)
            : `<span aria-current="page">${section}</span>`,
    ];
    if (sourceRoute && detailRee) {
      parts.push(pathLink(adminReeDetailPath(detailRee,adminReeDetail.backPath(detailRee)),title(detailRee)));
      parts.push(pathLink(adminReeSource.returnPath(detailRee),t("知识来源","Sources")));
      parts.push(`<span aria-current="page">${esc(detailSource?.source.title || t("来源预览","Source preview"))}</span>`);
    } else if (reeId) parts.push(`<span aria-current="page">${esc(detailRee ? title(detailRee) : t("Ree 详情", "Ree details"))}</span>`);
    if (detailUser)
      parts.push(`<span aria-current="page">${esc(detailUser.name)}</span>`);
    if (payoutId)
      parts.push(
        `<span aria-current="page">${esc(user(payoutRecord?.user)?.name || t("提现详情", "Payout details"))}</span>`,
      );
    if (kycId)
      parts.push(
        `<span aria-current="page">${esc(user(kycRecord?.user)?.name || t("人工审核", "Manual review"))}</span>`,
      );
    return {
      breadcrumbs: `<nav class="header-breadcrumbs" aria-label="${t("页面路径", "Breadcrumb")}">${parts.map((part, index) => `${index ? I("chevron") : ""}${part}`).join("")}</nav>`,
      actions: sourceRoute ? adminReeSource.navigation(sourceRoute.reeId,sourceRoute.sourceId) : reeId ? adminReeDetail.navigation(reeId) : "",
      context: detailUser
            ? `<div class="context-nav-row"><nav class="header-tabs console-detail-tabs" aria-label="${t("用户详情功能", "User detail sections")}">${userDetailTabs.map(([tab, zh, en]) => `<a href="#/admin/users/${detailUser.id}?tab=${tab}${route().query.get("from") ? "&from=" + encodeURIComponent(adminRecordBackPath(route().query.get("from"), "users")) : ""}" class="${U().detailTab === tab ? "active" : ""}" ${U().detailTab === tab ? 'aria-current="page"' : ""}>${t(zh, en)}</a>`).join("")}</nav></div>`
            : "",
    };
  }
  function adminShell(content, key) {
    const header = consoleHeader(key);
    return `<div class="console-app"><aside class="console-sidebar" id="sidebar"><div class="console-brand">${wordmark()}<span>CONSOLE</span></div>${iconBtn("close", t("关闭导航", "Close navigation"), "mobile-menu", 'class="sidebar-close"')}<div class="console-workspace"><span>${I("shield")}</span><div><strong>${t("平台运营中心", "Platform operations")}</strong><small>${t("本地演示环境", "LOCAL DEMO ENVIRONMENT")}</small></div></div><p class="nav-label">PLATFORM</p><nav aria-label="${t("后台导航", "Console navigation")}">${adminNav.map(([id, ic, zh, en], i) => `${i === 4 ? '<p class="nav-label">TRUST & COMMERCE</p>' : i === 8 ? '<p class="nav-label">GOVERNANCE</p>' : ""}${L("/admin/" + id, `${I(ic)}<span>${t(zh, en)}</span>${id === "verifications" ? `<small>${n(userRoles.adminRequests().filter(r=>r.status==="pending").length)}</small>` : ""}${id === "payouts" ? `<small>${n(adminRecords.rows("payouts").filter((p) => ["pending", "approved"].includes(p.status)).length)}</small>` : ""}`, key === id ? "active" : "")}`).join("")}</nav><div class="console-sidebar-bottom"><div class="console-status"><i class="dot"></i>${t("所有服务 · 模拟就绪", "All services · Demo ready")}</div>${L("/", I("external") + t("返回网站", "Back to website"), "console-back")}<div class="console-user"><span class="avatar">AD</span><div><strong>RE0 Admin</strong><small>${esc(S().console.adminEmail)}</small></div>${iconBtn("logout", t("退出管理员", "Sign out of admin"), "admin-logout")}</div></div></aside><div class="console-main ${header.context ? "has-context-nav" : ""}"><header class="console-topbar"><div class="topbar-main"><div class="topbar-location">${iconBtn("menu", t("展开后台导航", "Open console navigation"), "mobile-menu", 'class="mobile-menu"')}${sidebarToggle()}${header.breadcrumbs}</div><div class="flex console-header-tools ${header.actions ? "has-page-actions" : ""}">${header.actions || ""}<span class="console-environment"><i class="dot"></i> DEMO</span>${btn(stateLanguage(), "language", "ghost sm")}${btn(I("users") + `<span class="admin-manage-label">${t("管理员", "Administrators")}</span>`, "manage-admins", "secondary sm", `aria-label="${t("管理员", "Administrators")}"`)}</div></div>${header.context}</header><main id="main" tabindex="-1" class="console-content">${content}<div class="console-foot"><span>RE0 CONSOLE · ${t("所有指标与操作均为演示", "All metrics and operations are illustrative")}</span>${btn(t("全站导览", "Site map"), "guide", "ghost sm")}</div></main></div></div>`;
  }
  function adminLogin(setup = false) {
    return `<main id="main" tabindex="-1" class="admin-login-page"><div class="admin-login-top">${wordmark()}${L("/", t("返回网站", "Back to website") + I("external"), "text-link")}</div><section class="admin-login-card"><div class="admin-lock">${I("shield")}</div><p class="eyebrow">RE0 / PLATFORM CONSOLE</p><h1>${setup ? t("初始化管理后台", "Initialize your console") : t("欢迎回到控制中心。", "Welcome back to the console.")}</h1><p>${setup ? t("当前演示为空安装，第一个管理员将在这里创建。", "This demo is an empty installation. Create the first administrator here.") : t("使用管理员账号与双重验证登录。", "Sign in with your administrator account and two-factor code.")}</p><form id="${setup ? "admin-setup-form" : "admin-login-form"}">${setup ? field("admin-name", t("管理员名称", "Administrator name"), input("admin-name", "name", "", 'required maxlength="40" placeholder="RE0 Admin"')) : ""}${field("admin-email", t("管理员邮箱", "Administrator email"), input("admin-email", "email", "", 'type="email" required placeholder="admin@example.com" autocomplete="username"'))}${field("admin-password", t("密码", "Password"), input("admin-password", "password", "", 'type="password" required minlength="8" autocomplete="off" placeholder="' + t("输入演示密码", "Enter demo password") + '"'))}${setup ? `<div class="setup-totp"><div class="fake-qr" aria-hidden="true">${I("shield")}</div><div><strong>${t("启用 TOTP 双重验证", "Enable TOTP verification")}</strong><p>${t("此处模拟扫码绑定，不包含真实密钥。", "Simulated authenticator setup. No real secrets.")}</p><code>DEMO-TOTP-ONLY</code></div></div>` : ""}${field("admin-totp", t("动态验证码", "Authenticator code"), input("admin-totp", "totp", "", 'inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required placeholder="000 000" autocomplete="one-time-code"'), t("输入验证器中的 6 位数字", "Enter the six-digit authenticator code"))}<button class="btn full large" type="submit">${setup ? t("创建首位管理员", "Create first administrator") : t("登录管理后台", "Sign in to console")} ${I("arrow")}</button><div id="admin-form-error"></div></form><div class="admin-demo-credentials"><div><strong>${t("演示账号", "Demo credentials")}</strong><p>admin@example.com · demo-re0-admin · 123456</p></div>${btn(t("填入", "Fill demo"), "fill-admin", "secondary sm")}</div><p class="admin-auth-separation">${I("lock")}${t("管理员会话与用户会话独立，用户 OAuth 无法登录后台。", "Administrator sessions are separate from user OAuth sessions.")}</p><div class="between admin-login-bottom">${L("/login", t("用户登录", "User sign-in"), "text-link")}${setup ? L("/admin/login", t("已有管理员？去登录", "Existing administrator? Sign in"), "text-link") : ""}</div></section><p class="admin-login-caption">${t("原型只校验演示凭据；不创建真实账号或安全凭据。", "This prototype validates demo credentials only and never creates real credentials.")}</p></main>`;
  }
  function adminOverview() {
    return `${sectionHead(t("平台概览", "Platform overview"), t("从知识到对话，关注平台正在发生的每一步。", "Understand how knowledge becomes conversations across the platform."), `<span class="console-date">${I("clock")} 2026.10.31 · ${t("近 30 天", "Last 30 days")}</span>`)}${stats(
      [
        [
          t("用户总数", "Users"),
          adminRecords.rows("users").length,
          t(
            "已停用 " +
              adminRecords.rows("users").filter((u) => u.status === "disabled").length +
              " 个账号",
            adminRecords.rows("users").filter((u) => u.status === "disabled").length +
              " disabled accounts",
          ),
          "users",
        ],
        [
          t("Ree", "Rees"),
          S().dots.length,
          S().dots.filter((b) => b.public).length +
            " " +
            t("个已公开", "public"),
          "dot",
        ],
        [
          t("知识条数", "Knowledge sources"),
          S().dots.reduce((s, b) => s + b.knowledge.length, 0),
          t("文档、网页、音频与更多", "Documents, pages, audio & more"),
          "file",
        ],
        [
          t("近 30 天提问", "Questions in 30 days"),
          n(S().dots.reduce((s, b) => s + b.answers, 0)),
          t("回答与用量演示数据", "Illustrative answers and usage"),
          "chat",
        ],
      ],
    )}<div class="console-overview-grid"><section class="card console-chart"><div class="between"><div><h2>${t("知识正在被更多次连接。", "Knowledge, connected through conversation.")}</h2><p>${t("近 30 天提问趋势 · 演示", "Questions over the last 30 days · Demo")}</p></div><span class="tag blue">${t("按日统计", "Daily")}</span></div>${trendChart()}<div class="chart-legend"><i class="dot"></i>${t("成功回答", "Answers")}<span>${t("数据来源：当前原型示例，不代表实际平台运营。", "Illustrative prototype data, not live platform metrics.")}</span></div></section><aside class="card console-actions"><p class="eyebrow">NEEDS YOUR ATTENTION</p><h2>${t("今天，需要关注。", "Worth your attention.")}</h2>${[
      [
        "payouts",
        adminRecords.rows("payouts").filter((p) => ["pending", "approved"].includes(p.status))
          .length,
        t("笔提现待审核", "payouts to review"),
        "wallet",
      ],
      [
        "kyc",
        adminRecords.rows("kyc").filter((k) => k.status === "pending").length,
        t("条身份验证进行中", "identity checks in progress"),
        "shield",
      ],
      [
        "verifications",
        userRoles.adminRequests().filter(r => r.status === "pending").length,
        t("条认证申请待审核", "verification requests to review"),
        "shield",
      ],
      [
        "models",
        S().console.job?.status === "running" ? 1 : 0,
        t("个向量重算任务", "embedding rebuild jobs"),
        "refresh",
      ],
    ]
      .map(([path, count, label, ic]) =>
        L(
          "/admin/" + path,
          `${I(ic)}<strong>${count}</strong><span>${label}</span>${I("chevron")}`,
          "attention-row",
        ),
      )
      .join(
        "",
      )}<div class="console-income"><span>${t("近 30 天收入 credits · 演示", "Earned credits this month · Demo")}</span><strong class="mono">${n(users().reduce((s, u) => s + u.earned, 0))}</strong></div></aside></div><section class="card console-model-cost"><div class="between"><div><h2>${t("模型调用与估算成本", "Model usage & estimated cost")}</h2><p>${t("仅用于运营观察，用户账单仍按固定 credits 收费。下列成本为示例。", "Operational estimates only. User billing remains fixed-credit based. Costs below are illustrative.")}</p></div>${L("/admin/models", t("管理模型", "Manage models") + I("arrow"), "text-link")}</div>${table(
      [
        t("模型用途", "Kind"),
        t("当前启用模型", "Active model"),
        t("本月调用次数", "Calls this month"),
        t("估算成本 · 示例", "Estimated cost · Demo"),
      ],
      ["generation", "embedding", "transcription"].map((kind, i) => [
        t(...kindLabels[kind]),
        `<code>${esc(S().console.models.find((m) => m.kind === kind && m.enabled)?.model || t("环境变量回退", "Environment fallback"))}</code>`,
        n([2864, 6412, 18][i]),
        money([4.28, 0.18, 1.46][i]),
      ]),
    )}</section><section class="card mt24"><div class="console-table-head"><h2>${t("最近的管理操作", "Recent management actions")}</h2>${L("/admin/audit", t("查看审计", "View audit log"), "text-link")}</div>${auditTable(S().console.audits.slice(0, 4))}</section>`;
  }
  const kindLabels = {
    generation: ["生成模型", "Generation"],
    embedding: ["向量化模型", "Embedding"],
    transcription: ["转写模型", "Transcription"],
  };
  function jobHTML() {
    const job = S().console.job;
    if (!job) return "";
    return `<section class="reembed-job card"><div class="between"><div class="flex"><span class="${job.status === "running" ? "spinner" : "blue"}">${job.status === "running" ? "" : I("check")}</span><div><h3>${t("全量重向量化任务", "Full embedding rebuild")}</h3><p>${esc(job.from)} → ${esc(job.to)}</p></div></div>${tag(job.status)}</div><div class="progress"><span id="job-progress" style="width:${job.progress}%"></span></div><div class="between"><span id="job-count">${Math.round((job.total * job.progress) / 100)} / ${job.total} ${t("条知识", "sources")}</span><span id="job-percent">${job.progress}%</span></div><p>${job.status === "running" ? t("新旧两套向量并存，检索仍使用旧模型。完成后一次性切换；任务期间不能再次切换。", "Old and new vectors coexist. Search stays on the old model until the rebuild finishes. Another switch is blocked while running.") : job.status === "failed" ? t("重算失败，旧模型继续服务。请检查候选模型后重试。", "Rebuild failed. The old model remains active. Check the candidate model and retry.") : t("重算完成，检索已统一切换到新模型。", "Rebuild complete. Retrieval has switched to the new model.")}</p></section>`;
  }
  function modelsPage() {
    return `${sectionHead(t("模型配置", "Model configuration"), t("三类模型，各自保持一条启用。配置为空时回退环境变量。", "One active model per kind. Empty configuration falls back to environment variables."), btn(I("plus") + t("添加模型", "Add model"), "add-model"))}<div class="info-strip mb16">${I("info")}<span>${t("生成与转写模型切换后用于下一次请求。向量模型必须通过全量重算切换。本原型的连通测试和重算均为模拟，不发送真实请求。", "Generation and transcription switches affect the next request. Embeddings require a full rebuild. Probes and jobs here are simulations and do not send requests.")}</span></div>${jobHTML()}<div class="model-kind-grid">${Object.entries(
      kindLabels,
    )
      .map(
        ([kind, l]) =>
          `<section class="card model-kind"><div class="model-kind-head"><span class="model-kind-icon">${I(kind === "generation" ? "sparkle" : kind === "embedding" ? "layers" : "audio")}</span><div><h2>${t(...l)}</h2><p>${kind === "generation" ? t("带引用的流式回答", "Source-based streaming answers") : kind === "embedding" ? t("知识与问题的向量检索", "Knowledge and query retrieval") : t("音频转为带时间戳的文字", "Audio to timestamped text")}</p></div></div>${S()
            .console.models.filter((m) => m.kind === kind)
            .map(
              (m) =>
                `<article class="model-config ${m.enabled ? "enabled" : ""}"><div class="between"><strong>${esc(m.name)}</strong>${tag(m.enabled ? "enabled" : "inactive")}</div><code>${esc(m.model)}</code><p>${m.transport === "gateway" ? "AI Gateway" : "OpenAI compatible"} · ${m.timeout}s</p><p class="model-endpoint">${esc(m.base)}</p><div class="between model-key"><span>${I("lock")} •••• ${esc(m.tail)}</span>${iconBtn("settings", t("编辑模型", "Edit model"), "edit-model", `data-id="${m.id}"`)}</div>${m.probe ? `<div class="probe-result ${m.probe === "failed" ? "error" : ""}">${m.probe === "failed" ? t("演示：连通失败，请检查端点。", "Demo: failed. Check endpoint.") : t("演示：连通成功 · 238 ms", "Demo: connected · 238 ms")}</div>` : ""}<div class="flex">${btn(t("测试连通", "Test connection"), "probe-model", "secondary sm", `data-id="${m.id}"`)}${!m.enabled ? btn(kind === "embedding" ? t("重算并切换", "Rebuild & switch") : t("启用", "Activate"), "activate-model", "sm", `data-id="${m.id}" ${kind === "embedding" && S().console.job?.status === "running" ? "disabled" : ""}`) : `<span class="small muted">${I("check")}${t("当前使用", "In use")}</span>`}</div></article>`,
            )
            .join(
              "",
            )}${btn(I("plus") + t("添加配置", "Add configuration"), "add-model", "ghost full", `data-kind="${kind}"`)}</section>`,
      )
      .join("")}</div>`;
  }
  const filters = (key) =>
    U().consoleFilters[key] ||
    (U().consoleFilters[key] = {
      q: "",
      status: "all",
      period: "all",
      tab: "all",
    });
  function filterBar(key, statuses = [], options = {}) {
    const f = filters(key);
    return `<form class="console-filterbar" id="console-filter" data-key="${key}"><div class="search-small">${I("search")}<input name="q" aria-label="${t("搜索记录", "Search records")}" placeholder="${options.placeholder || t("搜索名称、邮箱或编号…", "Search name, email, or ID…")}" value="${esc(f.q)}"></div>${statuses.length ? `<select name="status" aria-label="${t("状态筛选", "Filter by status")}"><option value="all">${t("全部状态", "All statuses")}</option>${statuses.map((v) => `<option value="${v}" ${f.status === v ? "selected" : ""}>${labels[v] ? t(...labels[v]) : esc(v)}</option>`).join("")}</select>` : ""}${options.period ? `<select name="period" aria-label="${t("时间筛选", "Filter by date")}"><option value="all">${t("全部时间", "All dates")}</option><option value="7" ${f.period === "7" ? "selected" : ""}>${t("近 7 天", "Last 7 days")}</option><option value="30" ${f.period === "30" ? "selected" : ""}>${t("近 30 天", "Last 30 days")}</option></select>` : ""}<button class="btn secondary sm" type="submit">${t("筛选", "Apply filters")}</button>${f.q || f.status !== "all" || f.period !== "all" ? btn(t("重置", "Reset"), "clear-filters", "ghost sm", `data-key="${key}"`) : ""}<div class="grow"></div>${options.export ? btn(I("download") + t("导出 CSV", "Export CSV"), "export-csv", "secondary sm", `data-key="${key}"`) : ""}</form>`;
  }
  function filtered(key, rows) {
    const f = filters(key);
    return rows.filter(
      (r) =>
        (f.status === "all" || r.status === f.status) &&
        (!f.q || JSON.stringify(key === "audit" ? { ...r, action: auditActionLabel(r.action) } : r).toLowerCase().includes(f.q.toLowerCase())) &&
        (f.period === "all" ||
          !r.created ||
          r.created.slice(0, 10) >=
            (f.period === "7" ? "2026-10-25" : "2026-10-02")),
    );
  }
  function userLink(u) {
    return L(
      "/admin/users/" + u.id,
      `<span class="table-person"><span class="avatar">${esc(u.name.slice(0, 1))}</span><span><strong>${esc(u.name)}</strong><small>${esc(u.email)}</small></span></span>`,
      "",
    );
  }
  function usersPage() {
    const rows = filtered("users", users());
    return `${sectionHead(t("用户管理", "User management"), t("查看账号状态、完整账户信息与余额，所有管理操作写入审计。", "Review accounts and balances. Every management action is audited."))}${stats(
      [
        [t("用户数", "Users"), users().length, "", "users"],
        [
          t("有效订阅", "Active subscriptions"),
          users().filter((u) => u.subscription === "active").length,
          "",
          "wallet",
        ],
        [
          t("已完成 KYC", "Verified users"),
          users().filter((u) => u.kyc === "verified").length,
          "",
          "shield",
        ],
        [
          t("已停用", "Disabled accounts"),
          users().filter((u) => u.status === "disabled").length,
          "",
          "lock",
        ],
      ],
    )}<section class="card">${filterBar("users", ["active", "disabled"])}${table(
      [
        t("用户", "User"),
        t("账号状态", "Account"),
        t("总余额", "Total credits"),
        t("KYC 状态", "KYC"),
        t("加入时间", "Joined"),
        t("操作", "Actions"),
      ],
      rows.map((u) => [
        userLink(u),
        tag(u.status),
        `<span class="mono">${n(u.plan + u.pack + u.earned + (u.id === "me" ? S().welcomeCredits : 0))}</span>`,
        tag(u.kyc),
        u.created,
        `<div class="flex">${L("/admin/users/" + u.id, t("查看详情", "Details"), "text-link")}${btn(u.status === "active" ? t("停用", "Disable") : t("恢复", "Restore"), "toggle-user", "ghost sm", `data-id="${u.id}"`)}</div>`,
      ]),
    )}<div class="table-count">${t("共", "Total")} ${rows.length} ${t("个用户", "users")}</div></section>`;
  }
  function userDetail(id) {
    const u = user(id);
    if (!u)
      return `<div class="card empty"><h2>${t("用户不存在", "User not found")}</h2>${L("/admin/users", t("返回用户列表", "Back to users"), "btn secondary mt16")}</div>`;
    const active = U().detailTab;
    let body = "";
    if (active === "summary")
      body = `<div class="user-detail-overview"><section class="card settings-card"><h2>${t("账户与订阅", "Account & subscription")}</h2>${[
        ["Email", u.email],
        [t("账号状态", "Account status"), tag(u.status)],
        [t("Plan 订阅", "Plan subscription"), tag(u.subscription)],
        [t("当前周期", "Current cycle"), "2026.10.24 — 2026.11.24"],
        [t("KYC 状态", "KYC status"), tag(u.kyc)],
        [t("税务表单", "Tax form"), esc(u.tax)],
      ]
        .map(
          ([l, v]) =>
            `<div class="detail-line"><span>${l}</span><strong>${v}</strong></div>`,
        )
        .join(
          "",
        )}</section><section class="card settings-card"><h2>${t("管理操作", "Account actions")}</h2><p class="muted mt16">${t("手动调整 credits 时必须填写原因。赠送额度不会变为可提现收入。", "Credit adjustments require a reason. Granted credits do not become withdrawable earnings.")}</p>${btn(I("plus") + t("调整 Credits", "Adjust credits"), "adjust-credits", "full mt24", `data-id="${u.id}"`)}${btn(u.status === "active" ? t("停用账号", "Disable account") : t("恢复账号", "Restore account"), "toggle-user", "secondary full mt16", `data-id="${u.id}"`)}<p class="form-hint mt16">${t("停用后无法继续使用用户工作台，账号资料与历史保留。", "Disabled users cannot use the workspace. Profile and history are retained.")}</p></section></div>`;
    if (active === "summary") body += rolePages.adminUser(u);
    if (active === "roles") body = rolePages.adminUser(u,true);
    if (active === "credits") {
      const entries =
        u.id === "me"
          ? S().entries
          : u.entries || [
              {
                title: "Plan · " + t("周期到账", "Cycle grant"),
                amount: 100000,
                type: "purchase",
                time: "2026-10-24",
              },
              {
                title: t("知识处理", "Knowledge processing"),
                amount: -18,
                type: "knowledge",
                time: "2026-10-28",
              },
            ];
      body = `<section class="card">${table(
        [
          t("事项", "Activity"),
          t("时间", "Date"),
          t("原因", "Reason"),
          "Credits",
        ],
        entries.map((e) => [
          esc(e.title),
          esc(e.time),
          esc(e.reason || "—"),
          `<span class="mono ${e.amount > 0 ? "positive" : ""}">${e.amount > 0 ? "+" : ""}${n(e.amount)}</span>`,
        ]),
      )}</section>`;
    }
    if (active === "kyc")
      body = `<section class="card">${kycTable(kycRows().filter((k) => k.user === id))}</section>`;
    if (active === "purchases")
      body = `<section class="card"><div class="console-table-head"><h2>${t("充值记录", "Purchase history")}</h2>${tag(u.subscription)}</div>${purchaseTable(S().console.purchases.filter((p) => p.user === id))}</section>`;
    if (active === "payouts")
      body = `<section class="card">${payoutTable(payouts().filter((p) => p.user === id))}</section>`;
    if (active === "dots")
      body = `<section class="card">${dotsTable(S().dots.filter((b) => ownerId(b) === id))}</section>`;
    if (active === "summary") {
      const notes = S().console.notices.filter(
        (x) => (x.user || "me") === u.id,
      );
      if (notes.length)
        body += `<section class="card settings-card mt24"><h2>${t("账户提示", "Account notices")}</h2>${notes.map((x) => `<p class="form-hint mt16">${esc(x.text)}</p>`).join("")}</section>`;
    }
    return `<div class="user-detail-head"><span class="avatar">${esc(u.name.slice(0, 1))}</span><div class="grow"><h1>${esc(u.name)}</h1><p>${esc(u.email)} · ID ${u.id}</p></div>${tag(u.status)}${userRoles.badge(u.role,true)}</div>${stats(
      [
        [t("Plan 当期", "Plan credits"), n(u.plan), "", "wallet"],
        [
          t("Pack 余额", "Pack credits"),
          n(u.pack),
          t("不过期", "Never expire"),
          "layers",
        ],
        [
          t("收入余额", "Earned credits"),
          n(u.earned),
          userRoles.roleFor(id) === "official" ? t("官方账号 · 不提供提现", "Official account · No withdrawals") : t("仅该部分可提现", "Only these credits may be withdrawn"),
          "sparkle",
        ],
      ],
    )}${body}`;
  }
  function kycRows() {
    const rows = [...S().console.kyc];
    for (const u of users())
      if (!rows.some((k) => k.user === u.id))
        rows.push({
          id: "none-" + u.id,
          user: u.id,
          status: "none",
          provider: "—",
          session: "—",
          tax: u.tax || "—",
          declared: false,
          submitted: "—",
          decided: "—",
          reason: "",
        });
    return rows;
  }
  function kycTable(rows) {
    return manualKyc.table(rows);
  }
  function kycPage() {
    return manualKyc.page(kycRows());
  }
  function purchaseTable(rows) {
    return table(
      [
        t("用户", "User"),
        t("类型", "Type"),
        t("金额", "Amount"),
        "Credits",
        t("交易号", "Paddle transaction"),
        t("状态", "Status"),
        t("时间", "Date"),
      ],
      rows.map((p) => [
        userLink(user(p.user)),
        `<span class="tag">${p.kind === "plan" ? "Plan" : "Pack"}</span>`,
        money(p.amount),
        `<span class="mono">${n(p.credits)}</span>`,
        `<code>${esc(p.id)}</code>`,
        tag(p.status),
        p.created,
      ]),
    );
  }
  function purchasesPage() {
    const f = filters("purchases");
    return `${sectionHead(t("充值与订阅", "Purchases & subscriptions"), t("交易记录只读。退款在 Paddle 后台处理，此处显示回调冲回结果。", "Transactions are read-only. Refunds happen in Paddle; webhook results are reflected here."))}<div class="info-strip mb16">${I("lock")}<span>${t("套餐价格、credit 单价和 Plan / Pack 规则为代码常量，不在后台配置。", "Plan pricing, credit value, and purchase rules are code constants and cannot be edited here.")}</span></div><section class="card"><div class="tab-row">${[
      ["all", t("充值交易", "Transactions")],
      ["subscriptions", t("Plan 订阅", "Plan subscriptions")],
    ]
      .map(
        ([v, l]) =>
          `<button data-action="purchase-tab" data-value="${v}" class="${f.tab === v ? "active" : ""}">${l}</button>`,
      )
      .join(
        "",
      )}</div>${filterBar("purchases", f.tab === "subscriptions" ? ["active", "cancelled", "expired"] : ["paid", "refunded", "chargeback"], { period: true, export: true })}${
      f.tab === "subscriptions"
        ? table(
            [
              t("用户", "User"),
              t("状态", "Status"),
              t("当前周期", "Current period"),
              t("自动续费", "Renewal"),
              t("取消状态", "Cancellation"),
            ],
            filtered(
              "purchases",
              users().map((u) => ({ ...u, status: u.subscription })),
            ).map((u) => [
              userLink(u),
              tag(u.subscription),
              "2026.10.24 — 2026.11.24",
              u.subscription === "active" ? t("开启", "On") : t("关闭", "Off"),
              u.subscription === "cancelled"
                ? t("周期末结束", "Ends at period end")
                : "—",
            ]),
          )
        : purchaseTable(
            filtered(
              "purchases",
              S().console.purchases.map((p) => ({
                ...p,
                name: user(p.user)?.name,
                email: user(p.user)?.email,
              })),
            ),
          )
    }</section>`;
  }
  function payoutTable(rows, review = false) {
    return table(
      [
        t("申请人", "Applicant"),
        t("金额 / 手续费", "Amount / fee"),
        t("身份与税务", "Identity & tax"),
        t("PayPal 收款邮箱", "PayPal email"),
        t("状态", "Status"),
        review
          ? t("审核操作", "Review")
          : t("审核与支付信息", "Review & payment"),
      ],
      rows.map((p) => [
        userLink(user(p.user) || users()[0]),
        `<strong class="mono">${money(p.credits / 10000)}</strong><small class="cell-subline">${p.status === "paid" ? t("实付", "Net paid") + " " + money(p.actual ?? p.credits / 10000 - (p.fee || 0)) + " · " + t("手续费", "Fee") + " " + money(p.fee || 0) : t("实付与手续费待登记", "Payment and fee pending")}</small>`,
        `${tag((user(p.user) || {}).kyc || "verified")}<small class="cell-subline">${esc(p.tax || "W-8BEN")} · ${t("已声明提交", "Declaration submitted")}</small>`,
        esc(p.email),
        `${tag(p.status)}<small class="cell-subline">${p.created}</small>`,
        review
          ? btn(
              p.status === "approved"
                ? t("登记打款结果", "Record payment")
                : t("审核申请", "Review request"),
              "review-payout",
              "secondary sm",
              `data-id="${p.id}"`,
            )
          : `<span>${t("审核", "Reviewed by")} ${esc(p.reviewer || "—")}</span><small class="cell-subline">${t("打款", "Paid by")} ${esc(p.paidBy || "—")}${p.paidAt ? " · " + esc(new Date(p.paidAt).toLocaleString(S().lang === "zh" ? "zh-CN" : "en-GB")) : ""}</small><small class="cell-subline mono">${esc(p.transferId || p.batch || "—")}</small>${p.note ? `<small class="cell-subline">${esc(p.note)}</small>` : ""}${L("/admin/payouts/" + p.id + (p.status === "approved" ? "/payment" : "") + "?from=history", t("查看详情", "View details"), "text-link cell-subline")}`,
      ]),
    );
  }
  function payoutsPage(review = false) {
    let rows = review
      ? payouts().filter((p) => ["pending", "approved"].includes(p.status))
      : payouts();
    rows = filtered(review ? "review" : "payout-history", rows);
    return `${sectionHead(review ? t("提现审核", "Payout review") : t("提现记录", "Payout history"), review ? t("待审核申请先批准或驳回；待打款申请在 PayPal 人工转账后登记结果。", "Review requests, then record the result after a manual PayPal transfer.") : t("每一笔申请、审核与支付结果，都在这里保留。", "A complete history of requests, reviews, and payment results."))}${review ? `<div class="review-summary"><span>${I("wallet")} ${t("待处理", "Awaiting action")} <strong>${rows.length}</strong> ${t("笔", "requests")}</span><span>${t("冻结总额", "Total held")} <strong class="mono">${money(rows.reduce((s, p) => s + p.credits / 10000, 0))}</strong></span>${L("/admin/payout-history", t("查看全部记录", "View all records") + I("arrow"), "text-link")}</div>` : ""}<section class="card">${filterBar(review ? "review" : "payout-history", review ? ["pending", "approved"] : ["pending", "approved", "paid", "failed", "rejected"], { period: true, export: !review })}${payoutTable(rows, review)}</section>`;
  }
  function dotsTable(rows) {
    const detailPath = dot => adminReeDetailPath(dot, route().path + (route().query.size ? "?" + route().query : ""));
    return table(
      [
        "Ree",
        t("所有者", "Owner"),
        t("状态", "Visibility"),
        t("知识来源", "Sources"),
        t("查询费", "Owner fee"),
        t("累计成功回答", "Successful answers"),
        t("操作", "Actions"),
      ],
      rows.map((b) => [
        `<a class="table-person admin-ree-name-link" href="#${esc(detailPath(b))}" aria-label="${esc(t("查看 Ree 详情：", "View Ree details: ") + title(b))}">${avatar(b, true)}<span><strong>${esc(title(b))}</strong><small>${esc(b.slug)}</small></span></a>`,
        b.adminDemo ? `<strong>${esc(b.owner)}</strong><small class="cell-subline">${esc(b.ownerEmail)}</small>` : userLink(user(ownerId(b))),
        `<span class="tag ${b.moderated ? "orange" : b.public ? "blue" : ""}">${b.moderated ? t("已下架", "Taken down") : b.public ? t("公开", "Public") : t("私有", "Private")}</span>`,
        b.knowledge.length,
        `<span class="mono">${b.fee}</span> credits`,
        n(b.answers),
        `<div class="flex">${L(detailPath(b), t("详情", "Details"), "text-link")}${b.adminDemo ? `<span class="muted small">${t("只读示例", "Read-only sample")}</span>` : `${b.public && !b.moderated ? L("/d/" + b.slug, I("external"), "icon-btn") : ""}${b.public || b.moderated ? btn(b.moderated ? t("恢复公开", "Restore") : t("下架", "Take down"), "moderate-dot", "secondary sm", `data-id="${b.id}"`) : ""}`}</div>`,
      ]),
    );
  }
  function dotsAdminPage() {
    return adminRees.page();
  }
  function auditTable(rows) {
    return table(
      [
        t("时间", "Time"),
        t("管理员", "Administrator"),
        t("操作", "Action"),
        t("对象", "Target"),
        t("详情", "Details"),
      ],
      rows.map((a) => [
        esc(a.created),
        esc(a.actor),
        `<code>${esc(auditActionLabel(a.action))}</code>`,
        `<code>${esc(a.target)}</code>`,
        btn(
          t("查看变更", "View changes"),
          "audit-details",
          "ghost sm",
          `data-id="${a.id}"`,
        ),
      ]),
    );
  }
  function auditPage() {
    return `${sectionHead(t("审计日志", "Audit log"), t("只读、可追溯：谁，在何时，改变了什么。", "Read-only and traceable: who changed what, and when."))}<section class="card">${filterBar("audit", [], { period: true })}${auditTable(filtered("audit", S().console.audits))}</section>`;
  }
  function videoExample(b) {
    const question =
      (b.samples || []).find((q) => Array.from(q).length <= 30) ||
      t("你知道哪些内容？", "What do you know?");
    const examples = {
      mine: "文档、音频、GitHub、网页、整站与文本，都能成为 Ree 的知识。",
      design: "先统一颜色、字体、间距，再把常用交互沉淀为组件。",
      code: "把设计变量映射成 CSS 自定义属性，让组件统一引用。",
      read: "每张笔记只表达一个想法，再连接到已有的知识。",
      growth: "先访谈真实用户，再用小原型验证具体问题。",
    };
    const content = b.knowledge.find((k) => k.content)?.content || "";
    const first = content.split(/[。！？]/)[0];
    const answer =
      S().lang === "en"
        ? "Start with shared knowledge and follow its sources."
        : examples[b.id] ||
          (first && Array.from(first).length < 49
            ? first + "。"
            : "根据已有知识，先明确问题，再把想法付诸实践。");
    return { question, answer };
  }
  function videoData(b) {
    if (!b.video)
      b.video = {
        generated: b.owner !== "me",
        template: "editorial",
        accent: "#127ee3",
        aspect: "16:9",
        music: true,
        revision: 1,
        exports: 0,
        cache: {},
        scenes: [
          {
            name:
              Array.from(title(b)).length <= 20
                ? title(b)
                : t("我的知识伙伴", "My knowledge partner"),
            position: t(
              "让你的知识，随时开口回答。",
              "Knowledge, ready to talk",
            ),
          },
          {
            sources: b.knowledge
              .slice(0, 4)
              .map((k, i) =>
                Array.from(k.title).length <= 20
                  ? k.title
                  : t("知识来源 ", "Source ") + (i + 1),
              )
              .join("\n"),
          },
          videoExample(b),
          {
            cta: t("问一个好问题，从这里开始。", "Ask this Ree"),
          },
        ],
      };
    return b.video;
  }
  const publicVideoData = b => videoData(publicVideoSource(b));
  const playbackVideoData = b => U().videoSurface === "detail:" + b.id ? publicVideoData(b) : videoData(b);
  const sceneLengths = [3, 4, 5, 3];
  const sceneNames = () => [
    t("开场", "Introduction"),
    t("它知道什么", "Its knowledge"),
    t("一个真实问答", "A real question"),
    t("结尾", "Call to action"),
  ];
  function sceneAt(time) {
    return time < 3 ? 0 : time < 7 ? 1 : time < 12 ? 2 : 3;
  }
  function stageContent(b, v, index) {
    const s = v.scenes[index];
    return index === 0
      ? `<span class="video-scene-eyebrow">MEET YOUR KNOWLEDGE COMPANION</span>${avatar(b)}<h2>${esc(s.name)}</h2><p>${esc(s.position)}</p>`
      : index === 1
        ? `<span class="video-scene-eyebrow">KNOWLEDGE, WITH REAL SOURCES</span><h2>${t("我知道的，从这里来。", "My knowledge starts here.")}</h2><div class="video-source-list">${s.sources
            .split("\n")
            .filter(Boolean)
            .slice(0, 4)
            .map(
              (name, i) =>
                `<div style="--delay:${i * 100}ms">${I(["file", "github", "audio", "globe"][i])}<span>${esc(name)}</span>${I("check")}</div>`,
            )
            .join(
              "",
            )}${b.knowledge.length > 4 ? `<small>${t("等", "and")} ${b.knowledge.length - 4} ${t("项知识", "more sources")}</small>` : ""}</div>`
        : index === 2
          ? `<span class="video-scene-eyebrow">ONE QUESTION. A GROUNDED ANSWER.</span><div class="video-question">${esc(s.question)}</div><div class="video-answer">${I("sparkle")}<p>${esc(s.answer)}<sup>1</sup></p></div><span class="video-demo-citation">${I("file")}${esc(b.knowledge[0]?.title || t("知识来源", "Knowledge source"))}</span>`
          : `<span class="video-scene-eyebrow">YOUR NEXT QUESTION STARTS HERE</span>${avatar(b)}<h2>${esc(s.cta)}</h2><p class="video-price">${fee(b)} <small>credits / ${t("成功回答", "answer")}</small></p>${U().videoSurface?.startsWith("detail:") ? `<span class="video-call">${t("加入对话，开启下一次好奇。", "Add this Ree to a chat and keep exploring.")}</span>` : `<a href="#/d/${b.slug}" class="video-call">${t("查看 Ree 详情", "View Ree details")} ${I("arrow")}</a>`}<span class="mono video-share-path">re0.ai / d / ${esc(b.slug)}</span>`;
  }
  function videoStage(b, v) {
    return `<div class="video-stage template-${v.template} ${v.aspect === "9:16" ? "portrait" : ""}" id="video-stage" data-dot="${b.id}" style="--video-accent:${v.accent}"><div class="video-stage-grid"></div><div class="video-watermark">RE0<span>YOUR KNOWLEDGE. A NEW VOICE.</span></div><div class="video-scene" id="video-scene">${stageContent(b, v, sceneAt(U().videoTime))}</div><div class="video-stage-footer"><span class="mono">${t("固定 15 秒", "15 SECONDS")} / 24 FPS</span><span>${v.music ? I("audio") + " " + t("内置配乐", "Music") : t("静音预览", "Muted")}</span></div></div>`;
  }
  function discoveryCoverContent(b, owned = false) {
    const available = owned ? hasVideoIntroduction(b) : hasPublicVideoIntroduction(b);
    if (!available) {
      const placeholder = renderVideoPlaceholder(b, { t, I, esc, title, avatar });
      if (owned && b.ownedDemo) return `<button class="discovery-cover-poster is-static is-video-placeholder" data-action="owned-ree-preview" data-id="${esc(b.id)}" aria-label="${esc(t("预览演示 Ree：", "Preview sample Ree: ") + title(b))}">${placeholder}</button>`;
      return `<a class="discovery-cover-poster is-static is-video-placeholder" href="#${esc(owned ? "/dots/" + b.id : publicDotPage.path(b))}" aria-label="${esc((owned ? t("打开工作台：", "Open studio: ") : t("查看详情：", "View details: ")) + title(b))}">${placeholder}</a>`;
    }
    const identity = `<span class="discovery-cover-kicker">${available ? "MEET YOUR KNOWLEDGE COMPANION" : "KNOWLEDGE, READY TO TALK"}</span><span class="discovery-cover-identity">${avatar(b)}<strong>${esc(title(b))}</strong></span><span class="discovery-cover-tagline">${esc(available ? (owned ? videoData(b) : publicVideoData(b)).scenes[0].position : t("真实知识，让好问题有回声。", "Real knowledge. Thoughtful answers."))}</span>`;
    const play = `<span class="discovery-cover-play">${I("play")}<span>${t("视频介绍", "Watch intro")}</span></span>`;
    const duration = `<span class="discovery-cover-duration">00:15</span>`;
    if (owned && b.ownedDemo) return `<button class="discovery-cover-poster is-static" data-action="owned-ree-preview" data-id="${esc(b.id)}" aria-label="${esc(t("预览演示 Ree：", "Preview sample Ree: ") + title(b))}">${identity}<span class="discovery-cover-static">${t("只读预览", "Read-only preview")}${I("arrow")}</span></button>`;
    if (!owned) {
      const link = `<a class="discovery-cover-poster" href="#${esc(publicDotPage.path(b))}" aria-label="${esc(t("查看详情：", "View details: ") + title(b))}">${identity}${available ? `<span class="discovery-cover-label">${I("film")}${t("含视频介绍", "Video introduction")}</span>${duration}` : `<span class="discovery-cover-static" aria-hidden="true">${I("arrow")}</span>`}</a>`;
      return link;
    }
    return available ? `<button class="discovery-cover-poster" data-action="discovery-video-play" data-id="${esc(b.id)}" aria-label="${esc(t("播放视频介绍：", "Play introduction: ") + title(b))}">${identity}${play}${duration}</button>` : `<a class="discovery-cover-poster is-static" href="#/dots/${esc(b.id)}" aria-label="${esc(t("打开工作台：", "Open studio: ") + title(b))}">${identity}<span class="discovery-cover-static">${t("打开工作台", "Open studio")}${I("arrow")}</span></a>`;
  }
  function discoveryCover(b, { owned = false } = {}) {
    const style = discoveryVideoStyle(b);
    const available = owned ? hasVideoIntroduction(b) : hasPublicVideoIntroduction(b);
    const status = b.moderated ? t("已下架", "Taken down") : b.public ? t("公开", "Public") : t("仅自己", "Private");
    return `<div class="discovery-cover template-${style.template}${!available ? " is-video-placeholder" : ""}" data-discovery-cover="${esc(b.id)}" style="--video-accent:${style.accent}">${discoveryCoverContent(b, owned)}${b.discoveryDemo || (!owned && b.ownedDemo) ? `<span class="creator-cover-status">${b.ownedDemo ? t("测试 Ree", "Test Ree") : t("演示 Ree", "Sample Ree")}</span>` : ""}${owned ? `<span class="creator-cover-status">${I(b.public && !b.moderated ? "globe" : "lock")}${status}</span>` : ""}</div>`;
  }
  function inlinePublicVideo(b) {
    const key = "detail:" + b.id;
    if (U().videoSurface !== key) {
      U().videoSurface = key;
      U().videoTime = 0;
      U().playing = false;
    }
    return `<div class="dot-inline-player" id="dot-intro-player" role="region" aria-label="${esc(t("视频介绍：", "Introduction: ") + title(b))}" tabindex="-1"><div class="dot-inline-canvas">${videoStage(b, publicVideoData(b))}<button type="button" class="dot-inline-start" data-action="video-play" aria-label="${t("播放视频介绍", "Play introduction")}" ${U().playing ? "hidden" : ""}>${I("play")}</button></div>${playerControls(true)}</div><p class="dot-inline-note">${t("15 秒示例动画 · 播放不消耗 credits", "15-second demo animation · Playback is free")}</p>`;
  }
  function playerControls(fullscreen = false) {
    return `<div class="player-controls">${iconBtn(U().playing ? "pause" : "play", t("播放或暂停", "Play or pause"), "video-play", `aria-pressed="${!!U().playing}"`)}<span class="mono" id="video-clock">00:${String(Math.floor(U().videoTime)).padStart(2, "0")} / 00:15</span><input type="range" id="video-seek" aria-label="${t("视频进度", "Video progress")}" min="0" max="15" value="${U().videoTime}" step="0.1"><span class="tag">720p</span>${fullscreen ? iconBtn("fullscreen", t("全屏播放", "Play fullscreen"), "inline-video-fullscreen", 'aria-controls="dot-intro-player" aria-pressed="false"') : ""}</div>`;
  }
  function syncInlinePlayer() {
    const player = document.querySelector(".dot-inline-player");
    if (!player) return;
    const overlay = player.querySelector(".dot-inline-start");
    overlay.hidden = !!U().playing;
    overlay.innerHTML = I(U().videoTime >= 15 ? "refresh" : "play");
    overlay.setAttribute("aria-label", U().videoTime >= 15 ? t("重新播放视频介绍", "Replay introduction") : t("播放视频介绍", "Play introduction"));
    const expanded = document.fullscreenElement === player || player.classList.contains("is-page-fullscreen");
    const control = player.querySelector('[data-action="inline-video-fullscreen"]');
    control.innerHTML = I(expanded ? "minimize" : "fullscreen");
    control.setAttribute("aria-pressed", String(expanded));
    const label = expanded ? t("退出全屏", "Exit fullscreen") : t("全屏播放", "Play fullscreen");
    control.setAttribute("aria-label", label);
    control.title = label;
  }
  // Keep viewport expansion usable when embedded hosts immediately leave native fullscreen.
  document.addEventListener("fullscreenchange", syncInlinePlayer);
  document.addEventListener("keydown", async (event) => {
    const player = document.querySelector(".dot-inline-player.is-page-fullscreen");
    if (event.key === "Tab" && player) {
      const controls = [...player.querySelectorAll('button, a[href], input')].filter((element) => !element.disabled && element.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    }
    if (event.key === "Escape" && player) {
      event.preventDefault();
      await toggleInlineFullscreen(player);
      syncInlinePlayer();
      player.querySelector('[data-action="inline-video-fullscreen"]').focus({ preventScroll: true });
    }
  });
  function syncPlaybackControls() {
    for (const toggle of document.querySelectorAll('[data-action="video-play"]')) {
      toggle.innerHTML = I(U().playing ? "pause" : "play");
      toggle.setAttribute("aria-pressed", String(!!U().playing));
    }
    syncInlinePlayer();
  }
  function videoEditor(b) {
    U().videoSurface = "editor:" + b.id;
    const v = videoData(b);
    const available = hasVideoIntroduction(b);
    if (!available) {
      U().playing = false;
      U().videoTime = 0;
    }
    const preview = available
      ? `<div class="card video-player-card">${videoStage(b, v)}${playerControls()}</div><div class="video-timeline">${sceneNames()
        .map(
          (name, i) =>
            `<button class="${sceneAt(U().videoTime) === i ? "active" : ""}" data-action="video-scene" data-value="${i}"><span class="mono">0${i + 1} <small>${sceneLengths[i]}s</small></span><strong>${name}</strong><i></i></button>`,
        )
        .join(
          "",
        )}</div>`
      : `<div class="card video-player-card">${renderVideoPlaceholder(b, { t, I, esc, title, avatar })}</div><p class="form-hint">${t("生成视频脚本后，即可预览和播放视频介绍。", "Generate a video script to preview and play the introduction.")}</p>`;
    return shell(
      `<div class="page video-editor-page">${sectionHead(t("让它，被更多人看见。", "Give your Ree a moment in the spotlight."), esc(title(b)) + " · " + t("固定 15 秒 · 4 个镜头 · 无配音", "15 seconds · 4 scenes · No voiceover"), btn(I("sparkle") + t(v.generated ? "重新生成脚本 · 20 credits" : "生成脚本 · 20 credits", v.generated ? "Regenerate · 20 credits" : "Generate script · 20 credits"), "generate-video", "secondary", `data-id="${b.id}"`))}<div class="video-editor-grid"><section class="video-preview-column">${preview}<div class="video-export-panel card"><div class="between"><div><h3>${t("导出与分享", "Export & share")}</h3><p>${v.exports === 0 ? t("这个 Ree 的首次 MP4 导出免费。", "This Ree’s first MP4 export is free.") : t("后续导出每次 50 credits；同版本缓存命中免费。", "Later exports cost 50 credits. Cached versions are free.")}</p></div><span class="tag blue">${v.exports === 0 ? t("首次免费", "First export free") : "50 credits"}</span></div><div class="flex mt16">${btn(I("download") + t("模拟导出 MP4", "Simulate MP4 export"), "export-video", "", `data-id="${b.id}" ${!v.generated ? "disabled" : ""}`)}${btn(I("link") + t("复制分享链接", "Copy share link"), "copy-video-link", "secondary", `data-id="${b.id}" ${!b.public ? "disabled" : ""}`)}${btn(I("download") + t("下载脚本", "Download script"), "download-script", "ghost sm", `data-id="${b.id}"`)}</div>${!b.public ? `<p class="form-hint mt16">${t("先在 Ree 设置中开启公开，再分享介绍。", "Make this Ree public in settings to share its introduction.")}</p>` : ""}<div id="export-status">${v.lastExport ? `<div class="export-complete">${I("check")}${t("上次模拟导出已完成", "Last demo export completed")} · ${v.lastExport.aspect} · ${v.lastExport.cost} credits</div>` : ""}</div><div class="demo-label mt16">${t("本原型用浏览器动画演示播放器与导出流程，不执行 Remotion 编码、上传或生成真实 MP4。脚本 JSON 可以实际下载。", "This prototype uses browser animation for playback and simulates export without Remotion encoding or uploads. Script JSON is downloadable.")}</div></div></section><aside class="card video-edit-panel"><form id="video-edit-form" data-id="${b.id}"><div class="video-edit-header"><h2>${t("镜头与风格", "Scenes & style")}</h2><span class="tag">${v.generated ? t("脚本已生成", "Script ready") : t("预览草稿", "Preview draft")}</span></div><label class="field-label">${t("模板", "Template")}</label><div class="video-templates">${[
        ["editorial", "简洁叙事", "Editorial"],
        ["blueprint", "知识蓝图", "Blueprint"],
        ["spotlight", "聚光时刻", "Spotlight"],
      ]
        .map(
          ([key, zh, en]) =>
            `<label><input type="radio" name="template" value="${key}" ${v.template === key ? "checked" : ""}><span class="template-swatch template-${key}">${I("layers")}</span><small>${t(zh, en)}</small></label>`,
        )
        .join(
          "",
        )}</div><div class="two-col"><div class="field"><label for="video-accent">${t("主题色", "Accent color")}</label><input type="color" id="video-accent" name="accent" value="${v.accent}"></div><div class="field"><label for="video-aspect">${t("画面比例", "Aspect ratio")}</label><select name="aspect" id="video-aspect"><option value="16:9" ${v.aspect === "16:9" ? "selected" : ""}>16:9 ${t("横版", "Landscape")}</option><option value="9:16" ${v.aspect === "9:16" ? "selected" : ""}>9:16 ${t("竖版", "Portrait")}</option></select></div></div>${sceneNames()
        .map(
          (name, i) =>
            `<details class="scene-editor" ${i === 0 ? "open" : ""}><summary><span class="mono">0${i + 1}</span>${name}<small>${sceneLengths[i]}s</small>${I("down")}</summary>${i === 0 ? field("scene-name", t("名字 · 最多 20 字符", "Name · 20 characters"), input("scene-name", "name", v.scenes[0].name, 'required maxlength="20"')) + field("scene-position", t("定位 · 最多 24 字符", "Position · 24 characters"), input("scene-position", "position", v.scenes[0].position, 'required maxlength="24"')) : i === 1 ? field("scene-sources", t("最多 4 条，每条 20 字符", "Up to 4 sources, 20 characters each"), `<textarea name="sources" id="scene-sources" rows="4" required>${esc(v.scenes[1].sources)}</textarea>`) : i === 2 ? field("scene-question", t("问题 · 最多 30 字符", "Question · 30 characters"), `<textarea name="question" id="scene-question" maxlength="30" required rows="2">${esc(v.scenes[2].question)}</textarea>`) + field("scene-answer", t("答案 · 最多 50 字符", "Answer · 50 characters"), `<textarea name="answer" id="scene-answer" maxlength="50" required rows="3">${esc(v.scenes[2].answer)}</textarea>`) : field("scene-cta", t("号召 · 最多 16 字符", "Call to action · 16 characters"), input("scene-cta", "cta", v.scenes[3].cta, 'required maxlength="16"'))}</details>`,
        )
        .join(
          "",
        )}<label class="video-music"><input type="checkbox" name="music" ${v.music ? "checked" : ""}>${I("audio")}${t("内置免版税配乐 · 正式版本", "Built-in royalty-free music · Production")}</label><button class="btn full" type="submit">${I("check")}${t("保存脚本与样式", "Save script & style")}</button></form></aside></div>${footer()}</div>`,
    );
  }
  function videoLibrary() {
    return shell(
      `<div class="page">${sectionHead(t("视频工作室", "Video studio"), t("15 秒，让别人认识你的知识伙伴。", "Fifteen seconds to introduce your knowledge companion."))}<div class="video-library">${mine()
        .map((b) => {
          const v = videoData(b);
          return `<article class="card video-library-card"><a class="video-library-poster template-${v.template}" href="#/dots/${b.id}/video">${avatar(b)}<h2>${esc(title(b))}</h2><span>${I("play")} 00:15</span></a><div class="between"><div><strong>${esc(title(b))}</strong><p>${v.generated ? t("脚本已生成 · 4 镜头", "Script ready · 4 scenes") : t("等待生成脚本", "Ready for its first script")}</p></div>${L("/dots/" + b.id + "/video", t("编辑介绍", "Edit introduction") + I("arrow"), "text-link")}</div></article>`;
        })
        .join(
          "",
        )}</div>${!mine().length ? `<div class="card empty">${I("film")}<h3>${t("先创建一个 Ree，再讲它的故事。", "Create a Ree, then tell its story.")}</h3>${btn(t("创建 Ree", "Create Ree"), "create-dot")}</div>` : ""}<div class="info-strip mt24">${I("info")}<span>${t("脚本生成 20 credits / 次。每个 Ree 首次导出免费，之后 50 credits / 次；缓存命中和在线播放免费。", "Scripts cost 20 credits. First export per Ree is free, later exports cost 50 credits. Cache hits and playback are free.")}</span></div>${footer()}</div>`,
    );
  }
  function legalPage(kind) {
    return marketingShell(
      `<article class="marketing-wrap legal-prototype"><p class="eyebrow">RE0 / ${kind.toUpperCase()}</p><h1>${kind === "privacy" ? t("隐私政策 · 原型说明", "Privacy · Prototype note") : t("服务条款 · 原型说明", "Terms · Prototype note")}</h1><p class="legal-lede">${t("本页面用于设计评审，正式上线文案需单独审阅。", "This page supports design review. Production policies require separate review.")}</p>${(kind ===
      "privacy"
        ? [
            [
              t("你的知识由你决定", "You control your knowledge"),
              t(
                "Ree 默认私有。公开页面展示来源标题，回答仅引用相关片段，不直接开放完整知识正文。",
                "Rees are private by default. Public pages show titles; answers cite relevant passages without exposing full sources.",
              ),
            ],
            [
              t("第三方处理", "Third-party processing"),
              t(
                "正式产品的模型生成、向量化与音频转写使用配置的服务商。音频来源在提交前提示第三方转写。",
                "Production uses configured providers for generation, embeddings, and transcription. Audio processing is disclosed before submission.",
              ),
            ],
            [
              t("人工身份与提现审核", "Manual identity and payout review"),
              t(
                "身份资料仅用于身份与提现审核。正式产品的证件照和手持自拍存入私有 Blob，仅授权管理员可通过短时签名链接查看，每次访问记审计；通过审核 30 天后删除原图，保留必要证件信息和审核记录。此原型仅演示流程，所选图片留在当前页面内存，刷新即丢失。",
                "Identity documents are used only for identity and payout review. Production stores images in private Blob storage with audited, time-limited access for authorized admins. Originals are deleted 30 days after approval, retaining necessary metadata and review records. This prototype keeps selected images in page memory only, until refresh.",
              ),
            ],
            [
              t("本地原型数据", "Local prototype data"),
              t(
                "本原型的数据保存在当前浏览器，不上传文件、不请求模型、不调用登录和支付服务。",
                "Prototype data stays in this browser. Files, models, sign-in, and payments do not contact external services. Reset through the site map.",
              ),
            ],
          ]
        : [
            [
              t("服务范围", "Service scope"),
              t(
                "RE0 让用户创建 Ree、添加知识并获得带引用的回答。Ree 不回答知识范围以外的问题。",
                "RE0 lets users create Rees, add sources, and receive cited answers within their knowledge.",
              ),
            ],
            [
              t("Credits 与计费", "Credits & billing"),
              t(
                "按成功回答与实际知识处理收费。Plan 当期有效；Pack 与收入 credits 不过期。充值和提现在本原型中仅模拟。",
                "Successful answers and processed knowledge incur credits. Plan credits expire per cycle; Pack and earnings do not. Purchases and payouts here are simulated.",
              ),
            ],
            [
              t("知识与内容责任", "Knowledge & content"),
              t(
                "用户应有权添加所提交的知识。整站需要域名确权；私有仓库需要账号授权。公开内容可能经管理员治理而转为私有。",
                "Users must have rights to submit sources. Website crawls require domain ownership; private repositories require authorization. Administrators may make public content private.",
              ),
            ],
          ]
      )
        .map(([h, p]) => `<section><h2>${h}</h2><p>${p}</p></section>`)
        .join("")}</article>`,
    );
  }
  function resolve(path, query) {
    ensure();
    if (path === "/settings/identity" && userRoles.roleFor("me") === "official") return {redirect:"/settings?tab=role"};
    const experiencePage = experience.resolve(path, query);
    if (experiencePage) return experiencePage;
    const setupPage = dotSetup.resolve(path, query);
    if (setupPage) return setupPage;
    const workspacePage = workspaceDetails.resolve(path,query);
    if (workspacePage) return workspacePage;
    const statisticsPage = dotStatistics.resolve(path, query);
    if (statisticsPage) return statisticsPage;
    const knowledgePage = knowledge.resolve(path);
    if (knowledgePage) return knowledgePage;
    if (path.startsWith("/admin")) {
      if (path === "/admin/login")
        return {
          html: adminLogin(),
          title: t("管理员登录", "Administrator sign-in"),
        };
      if (path === "/admin/setup") {
        if (S().console.installed) return { redirect: "/admin/login" };
        return {
          html: adminLogin(true),
          title: t("初始化管理员", "Initialize administrator"),
        };
      }
      if (!S().admin)
        return { redirect: "/admin/login?next=" + encodeURIComponent(path + (query.size ? "?" + query : "")) };
      if (path === "/admin") return { redirect: "/admin/overview" };
      const rolePage = rolePages.admin(path, query);
      if (rolePage?.redirect) return rolePage;
      if (rolePage) return {html:adminShell(rolePage.body,rolePage.key),title:rolePage.title};
      const recordPage = adminRecords.resolve(path, query);
      if (recordPage?.redirect) return recordPage;
      if (recordPage) return {html: adminShell(recordPage.body, recordPage.key), title: recordPage.title};
      let key = path.split("/")[2],
        body;
      if (key === "overview") body = adminOverview();
      else if (key === "models") body = modelsPage();
      else if (key === "users") {
        const tab = query.get("tab");
        U().detailTab = userDetailTabs.some(([id]) => id === tab)
          ? tab
          : "summary";
        body = path.split("/")[3]
          ? userDetail(path.split("/")[3])
          : usersPage();
      } else if (key === "kyc") {
        const id = path.split("/")[3];
        body = id ? manualKyc.reviewPage(id) : kycPage();
        if (body === null) return { redirect: "/admin/kyc" };
      } else if (key === "purchases") body = purchasesPage();
      else if (key === "payouts") {
        const id = path.split("/")[3],
          payment = path.split("/")[4] === "payment";
        if (!id) body = payoutsPage(true);
        else {
          const payout = payouts().find((p) => p.id === id);
          if (!payout) return { redirect: "/admin/payouts" };
          if (payout.status === "pending" && payment)
            return { redirect: "/admin/payouts/" + id + payoutOriginQuery() };
          if (payout.status === "approved" && !payment)
            return {
              redirect:
                "/admin/payouts/" + id + "/payment" + payoutOriginQuery(),
            };
          body = payoutDetailPage(id, payment);
        }
      } else if (key === "payout-history") body = payoutsPage();
      else if (key === "dots") {
        const source = adminReeSourceRoute(path);
        body = source ? adminReeSource.page(source.reeId,source.sourceId) : path.split("/")[3] ? adminReeDetail.page(path.split("/")[3]) : dotsAdminPage();
      }
      else if (key === "audit") body = auditPage();
      else return { redirect: "/admin/overview" };
      return {
        html: adminShell(body, key),
        title:
          key === "dots" && adminReeSourceRoute(path)
            ? t("知识来源预览","Source preview")
            : key === "dots" && path.split("/")[3]
            ? (adminReeDetail.record(path.split("/")[3]) ? title(adminReeDetail.record(path.split("/")[3])) : t("Ree 详情", "Ree details"))
            : key === "payouts" && path.split("/")[3]
            ? t("提现处理", "Payout processing")
            : key === "kyc" && path.split("/")[3]
              ? t("人工身份审核", "Manual identity review")
              : t(...adminNav.find((x) => x[0] === key).slice(2)),
      };
    }
    if (path === "/")
      return {
        html: home(),
        title: t("让知识，成为懂你的伙伴", "Give knowledge a voice"),
      };
    if (path === "/pricing")
      return { html: pricing(), title: t("价格与购买", "Pricing") };
    if (path === "/checkout")
      return { html: checkout(), title: t("确认购买", "Review purchase") };
    if (path === "/login")
      return { html: login(), title: t("登录 / 注册", "Sign in") };
    if (path.startsWith("/legal/"))
      return {
        html: legalPage(path.endsWith("privacy") ? "privacy" : "terms"),
        title: t("条款与隐私", "Terms & privacy"),
      };
    if (path === "/explore" && !S().signed)
      return {
        html: marketingShell(explore(), "/explore"),
        title: t("发现 Ree", "Discover Rees"),
      };
    if (S().signed && S().disabled && !path.startsWith("/d/"))
      return {
        html: marketingShell(
          `<div class="marketing-wrap"><div class="card empty"><h2>${t("当前账号已停用", "This account has been disabled")}</h2><p>${t("账号资料与历史仍保留。可在管理后台恢复演示账号。", "Your profile and history remain. Restore the demo account from the console.")}</p>${L("/", t("返回首页", "Back home"), "btn secondary")}</div></div>`,
        ),
        title: t("账号状态", "Account status"),
      };
    if (path === "/settings/identity")
      return {
        html: shell(manualKyc.userPage()),
        title: t("身份验证", "Identity verification"),
      };
    if (
      ["/dashboard", "/videos"].includes(path) ||
      /\/dots\/[^/]+\/video$/.test(path)
    ) {
      if (!S().signed)
        return { redirect: "/login?next=" + encodeURIComponent(path) };
      if (path === "/dashboard")
        return { html: dashboard(), title: t("工作台", "Dashboard") };
      if (path === "/videos")
        return { html: videoLibrary(), title: t("视频工作室", "Video studio") };
      const b = dotById(path.split("/")[2]);
      return b?.owner === "me"
        ? { html: videoEditor(b), title: t("视频介绍", "Video introduction") }
        : { redirect: "/dots" };
    }
    return null;
  }
  function error(form, msg) {
    form.querySelector(".form-error")?.remove();
    form.insertAdjacentHTML(
      "afterbegin",
      `<div class="form-error" role="alert">${esc(msg)}</div>`,
    );
  }
  function modelModal(id = null, kind = "generation") {
    const m = S().console.models.find((x) => x.id === id);
    modal(
      m ? t("编辑模型配置", "Edit model") : t("添加模型配置", "Add model"),
      t(
        "原型只保存演示密钥尾号，不存储真实 API Key。",
        "Only a demo key suffix is stored, never a real API key.",
      ),
      `<form id="model-form" data-id="${m?.id || ""}">${field("model-label", t("配置名称", "Configuration name"), input("model-label", "name", m?.name || "", 'required maxlength="50"'))}${field(
        "model-kind",
        t("用途", "Model kind"),
        `<select id="model-kind" name="kind" ${m ? "disabled" : ""}>${Object.entries(
          kindLabels,
        )
          .map(
            ([v, label]) =>
              `<option value="${v}" ${(m?.kind || kind) === v ? "selected" : ""}>${t(...label)}</option>`,
          )
          .join("")}</select>`,
      )}${field("model-transport", t("接入方式", "Connection type"), `<select id="model-transport" name="transport"><option value="gateway" ${m?.transport === "gateway" ? "selected" : ""}>AI Gateway</option><option value="compatible" ${m?.transport === "compatible" ? "selected" : ""}>OpenAI compatible endpoint</option></select>`)}${field("model-base", t("Base URL", "Base URL"), input("model-base", "base", m?.base || "https://ai-gateway.vercel.sh/v1", 'type="url" required'))}${field("model-name", t("模型标识", "Model identifier"), input("model-name", "model", m?.model || "", 'required maxlength="120" placeholder="provider/model"'))}${field("model-key", t("演示 API Key", "Demo API key"), input("model-key", "key", "demo-key-" + (m?.tail || "0000"), 'type="password" required autocomplete="off"'), t("请使用演示值。正式产品会加密保存并仅展示尾号。", "Use a demo value. Production encrypts the key and displays its suffix only."))}${field("model-timeout", t("超时（秒）", "Timeout (seconds)"), input("model-timeout", "timeout", m?.timeout || 60, 'type="number" required min="5" max="600" step="1"'))}<div class="info-strip">${I("info")}<span>${t("新增配置默认不启用。已启用配置的连接参数不能直接修改，请新增候选配置并按切换流程启用。", "New configurations start inactive. Active connection parameters cannot be edited directly; create a candidate and activate it through the switching flow.")}</span></div></form>`,
      cancelButton() +
        submitButton(t("保存配置", "Save configuration"), "model-form"),
    );
  }
  function adjustModal(id) {
    const u = user(id);
    modal(
      t("调整用户 Credits", "Adjust user credits"),
      esc(u.name) + " · " + esc(u.email),
      `<form id="adjust-form" data-id="${id}">${field("credit-direction", t("调整方式", "Adjustment"), `<select id="credit-direction" name="direction"><option value="grant">${t("赠送额度", "Grant credits")}</option><option value="debit">${t("扣回额度", "Deduct credits")}</option></select>`)}${field("credit-bucket", t("余额类型", "Credit bucket"), `<select id="credit-bucket" name="bucket"><option value="pack">${t("Pack / 非提现额度", "Pack / non-withdrawable credits")}</option><option value="plan">${t("Plan 当期额度", "Plan credits")}</option></select>`)}${field("credit-amount", t("Credits 数量", "Credit amount"), input("credit-amount", "amount", 1000, 'type="number" required min="1" max="10000000" step="1"'))}${field("credit-reason", t("调整原因（必填）", "Reason (required)"), `<textarea id="credit-reason" name="reason" rows="3" required minlength="3" maxlength="300" placeholder="${t("例如：知识处理异常补偿", "e.g. Compensation for a processing issue")}"></textarea>`)}<div class="info-strip">${I("shield")}<span>${t("本次操作写入用户流水及管理员审计。收入余额不会因为赠送而增加。", "This action appears in the user ledger and audit log. Grants do not increase withdrawable earnings.")}</span></div></form>`,
      cancelButton() +
        submitButton(t("确认调整", "Apply adjustment"), "adjust-form"),
    );
  }
  function download(name, content, type = "text/plain;charset=utf-8") {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function csvCell(v) {
    let text = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  }
  function exportCSV(key) {
    let headers, rows;
    if (key === "purchases" && filters(key).tab === "subscriptions") {
      headers = ["User", "Email", "Status", "Current period", "Auto renewal"];
      rows = filtered(
        "purchases",
        users().map((u) => ({ ...u, status: u.subscription })),
      ).map((u) => [
        u.name,
        u.email,
        u.subscription,
        "2026-10-24 / 2026-11-24",
        u.subscription === "active",
      ]);
    } else if (key === "purchases") {
      headers = [
        "User",
        "Type",
        "USD",
        "Credits",
        "Paddle transaction",
        "Status",
        "Date",
      ];
      rows = filtered(
        key,
        S().console.purchases.map((p) => ({
          ...p,
          name: user(p.user)?.name,
          email: user(p.user)?.email,
        })),
      ).map((p) => [
        user(p.user)?.name,
        p.kind,
        p.amount,
        p.credits,
        p.id,
        p.status,
        p.created,
      ]);
    } else {
      headers = [
        "User",
        "Credits",
        "USD",
        "Fee",
        "PayPal",
        "Status",
        "Reviewer",
        "PayPal transfer ID",
        "Net paid USD",
        "Paid by",
        "Paid at",
        "Date",
      ];
      rows = filtered("payout-history", payouts()).map((p) => [
        p.name,
        p.credits,
        p.credits / 10000,
        p.fee || "",
        p.email,
        p.status,
        p.reviewer,
        p.transferId || p.batch,
        p.actual ?? "",
        p.paidBy || "",
        p.paidAt || "",
        p.created,
      ]);
    }
    download(
      "re0-" + key + "-demo.csv",
      "\ufeff" +
        [headers, ...rows]
          .map((row) => row.map(csvCell).join(","))
          .join("\r\n"),
      "text/csv;charset=utf-8",
    );
    toast(t("已导出当前筛选结果", "Filtered records exported"));
  }
  function findPayout(id) {
    return [
      ...S().payouts,
      ...S().adminPayouts,
      ...S().console.historyPayouts,
    ].find((p) => p.id === id);
  }
  const payoutBackPath = () =>
    route().query.get("from") === "history" ? "/admin/payout-history" : adminRecordBackPath(route().query.get("from"), "payouts");
  const payoutOriginQuery = () => route().query.get("from") ? "?from=" + encodeURIComponent(payoutBackPath()) : "";
  function payoutDetailPage(id, payment = false) {
    const p = payouts().find((p) => p.id === id);
    if (!p) return null;
    const applicant = user(p.user),
      allowed = applicant?.kyc === "verified" && userRoles.roleFor(p.user) !== "official",
      finished = !["pending", "approved"].includes(p.status);
    const kycRecord = S().console.kyc.find((k) => k.user === p.user);
    const heading = finished
      ? t("提现处理详情", "Payout details")
      : payment
        ? t("登记人工打款结果", "Record manual payment")
        : t("提现申请审核", "Review payout request");
    const rows = (items) =>
      `<div class="review-checklist">${items.map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("")}</div>`;
    const when = (value) =>
      value
        ? esc(
            new Date(value).toLocaleString(
              S().lang === "zh" ? "zh-CN" : "en-GB",
            ),
          )
        : "—";
    const identity = `<section class="card payout-detail-card"><div class="between"><h2>${t("身份与收款信息", "Identity & payout destination")}</h2>${kycRecord ? L("/admin/kyc/" + kycRecord.id, t("查看 KYC", "View KYC"), "text-link") : ""}</div>${rows(
      [
        [t("申请人", "Applicant"), esc(applicant?.name || p.name || "—")],
        [t("KYC 状态", "KYC status"), tag(applicant?.kyc || "none")],
        [
          t("税务声明", "Tax declaration"),
          esc(p.tax || "—") + " · " + t("已声明提交", "Declared submitted"),
        ],
        [t("PayPal 个人账户邮箱", "Personal PayPal email"), esc(p.email)],
      ],
    )}</section>`;
    let body;
    if (finished) {
      body = `<section class="card payout-detail-card"><h2>${t("处理结果", "Processing result")}</h2>${rows(
        [
          [t("状态", "Status"), tag(p.status)],
          [t("审核人", "Reviewed by"), esc(p.reviewer || "—")],
          [t("审核时间", "Reviewed at"), when(p.reviewedAt)],
          [
            t("实付金额", "Net paid"),
            p.status === "paid"
              ? money(p.actual ?? p.credits / 10000 - (p.fee || 0))
              : "—",
          ],
          [t("手续费", "Fee"), p.status === "paid" ? money(p.fee || 0) : "—"],
          [
            t("PayPal 转账 ID", "PayPal transfer ID"),
            esc(p.transferId || p.batch || "—"),
          ],
          [
            t("打款人 / 时间", "Paid by / time"),
            esc(p.paidBy || "—") + " / " + when(p.paidAt),
          ],
          [t("处理说明", "Note"), esc(p.note || "—")],
        ],
      )}<p class="form-hint mt16">${["failed", "rejected"].includes(p.status) ? t("冻结的收入 credits 已退回，此申请不可重复处理。", "Held earnings have been released. This request cannot be processed again.") : t("人工打款结果已登记，此申请不可重复处理。", "The manual payment result has been recorded. This request cannot be processed again.")}</p></section>`;
    } else if (payment) {
      body = `<section class="card payout-detail-card"><h2>${t("登记打款结果", "Record payment result")}</h2><div class="info-strip mb16">${I("info")}<span>${t("先在 PayPal 完成人工转账，再登记转账 ID 和实付金额。当前为本地演示，不会真实转账。", "Complete the manual PayPal transfer before recording its ID and net amount. This local demo does not transfer money.")}</span></div><form id="manual-payout-result" data-id="${id}"><div class="field"><label for="payout-transfer">${t("PayPal 转账 ID（已打款必填）", "PayPal transfer ID (required for payment)")}</label><input id="payout-transfer" name="transferId" maxlength="100" placeholder="DEMO-TXN-2048"></div><div class="field"><label for="payout-actual">${t("实付金额 · USD", "Net amount paid · USD")}</label><input id="payout-actual" name="actual" type="number" min="0.01" max="${p.credits / 10000}" step="0.01" placeholder="${(p.credits / 10000).toFixed(2)}"><small>${t("实付金额不得高于申请金额，差额将登记为手续费。", "Net payment cannot exceed the requested amount. The difference is recorded as the fee.")}</small></div><div class="payout-fee-estimate"><span>${t("预计手续费", "Calculated fee")}</span><strong id="payout-calculated-fee">—</strong></div><div class="rule"></div><div class="field"><label for="payout-failure">${t("失败原因（标记失败必填）", "Failure reason (required for failure)")}</label><textarea id="payout-failure" name="reason" rows="3" maxlength="300" placeholder="${t("如果转账失败或被退回，请说明原因", "Explain a failed or returned transfer")}"></textarea></div>${!allowed ? `<p class="form-error">${t("当前 KYC 未通过，暂停标记打款；仍可登记失败并解冻。", "Current KYC is not verified. Payment recording is paused; failure and release remain available.")}</p>` : ""}<div class="payout-page-actions"><button type="submit" name="result" value="failed" class="btn secondary" formnovalidate>${t("标记失败并解冻", "Mark failed & release")}</button><button type="submit" name="result" value="paid" class="btn" ${allowed ? "" : "disabled"}>${t("标记已打款", "Mark as paid")}${I("check")}</button></div></form></section>`;
    } else {
      body = `<section class="card payout-detail-card"><h2>${t("审核决定", "Review decision")}</h2><div class="info-strip mb16">${I("shield")}<span>${t("批准后进入待人工打款，收入 credits 继续冻结。驳回后全额退回收入余额。", "Approval moves the request to manual payment while earnings remain held. Rejection releases all held earnings.")}</span></div><form id="payout-review-form" data-id="${id}"><div class="field"><label for="review-note">${t("审核备注（驳回必填）", "Review note (required for rejection)")}</label><textarea id="review-note" name="note" rows="4" maxlength="300" placeholder="${t("填写审核依据或驳回原因", "Explain the review decision or rejection")}"></textarea></div>${!allowed ? `<p class="form-error">${t("KYC 未通过，不能批准此申请。", "KYC approval is required before approving this request.")}</p>` : ""}<div class="payout-page-actions">${btn(t("驳回申请", "Reject request"), "finish-review", "secondary", `type="button" data-id="${id}" data-value="rejected"`)}${btn(t("批准，进入待打款", "Approve for manual payment"), "finish-review", "", `type="button" data-id="${id}" data-value="approved" ${allowed ? "" : "disabled"}`)}</div></form></section>`;
    }
    return `<div class="payout-detail-page"><div class="kyc-page-intro"><div><h1>${heading}</h1><p>${esc(applicant?.name || p.name || "—")} · ${esc(applicant?.email || p.email)}</p></div>${tag(p.status)}</div><section class="card payout-amount-summary"><div><span>${t("申请提现金额", "Requested payout")}</span><strong>${money(p.credits / 10000)}</strong><small>${n(p.credits)} credits</small></div><div><span>${t("申请时间", "Requested")}</span><strong class="payout-summary-date">${esc(p.created || "—")}</strong><small>${finished ? t("处理已结束", "Processing complete") : t("收入 credits 已冻结", "Earned credits held")}</small></div></section><div class="payout-detail-grid"><div class="payout-detail-main">${body}</div><aside class="payout-detail-side">${identity}<section class="card payout-detail-card"><h2>${t("处理进度", "Processing progress")}</h2><ol class="payout-progress"><li class="done"><strong>${t("申请已提交", "Request submitted")}</strong><p>${t("收入 credits 已冻结", "Earned credits held")}</p></li><li class="${p.status === "pending" ? "current" : "done"}"><strong>${t("人工审核", "Manual review")}</strong><p>${p.status === "pending" ? t("核对身份、税务与收款信息", "Check identity, tax and destination") : esc(p.reviewer || "—")}</p></li><li class="${p.status === "approved" ? "current" : finished ? "done" : ""}"><strong>${t("人工打款与结果登记", "Manual transfer & result")}</strong><p>${p.status === "approved" ? t("等待在 PayPal 转账后登记结果", "Awaiting external transfer and result") : finished ? t("处理结果已记录", "Result recorded") : t("审核通过后进入此步骤", "Available after approval")}</p></li></ol><div class="rule"></div><p class="form-hint">${t("手续费由提现人承担。实付金额与申请金额的差额会记为手续费；失败或驳回只解冻一次。", "The recipient bears the fee. The difference from the requested amount is the fee. Failure or rejection releases credits only once.")}</p>${L("/admin/payout-history", t("查看全部提现记录", "View all payout records") + I("arrow"), "text-link mt16")}</section></aside></div></div>`;
  }
  let jobTimer = null,
    videoTimer = null,
    exportTimer = null,
    lastFrame = 0,
    lastScene = -1;
  function beginRebuild(m) {
    const current = S().console.models.find(
      (x) => x.kind === "embedding" && x.enabled,
    );
    S().console.job = {
      id: uid(),
      status: "running",
      from: current?.model || "Environment fallback",
      to: m.model,
      target: m.id,
      progress: 0,
      total: S().dots.reduce((s, b) => s + b.knowledge.length, 0) || 1,
    };
    audit("model.reembed.start", m.id, current?.model, m.model);
    save();
    render();
    startJobClock();
  }
  function startJobClock() {
    if (jobTimer || S().console.job?.status !== "running") return;
    jobTimer = setInterval(() => {
      const job = S().console.job;
      if (!job || job.status !== "running") {
        clearInterval(jobTimer);
        jobTimer = null;
        return;
      }
      job.progress = Math.min(100, job.progress + 10);
      const target = S().console.models.find((m) => m.id === job.target);
      if (job.progress === 100) {
        job.status = target?.base.includes(".invalid") ? "failed" : "done";
        if (job.status === "done")
          S()
            .console.models.filter((m) => m.kind === "embedding")
            .forEach((m) => (m.enabled = m.id === job.target));
        audit(
          "model.reembed." + job.status,
          job.id,
          job.from,
          job.status === "done" ? job.to : job.from,
        );
        clearInterval(jobTimer);
        jobTimer = null;
        save();
        if (
          route().path === "/admin/models" &&
          !document.querySelector(".modal")
        )
          render();
        toast(
          job.status === "done"
            ? t(
                "重算完成，已切换向量模型",
                "Rebuild complete. Embedding model switched.",
              )
            : t(
                "重算失败，继续使用旧模型",
                "Rebuild failed. Old model retained.",
              ),
        );
      } else {
        save();
        const bar = document.querySelector("#job-progress"),
          percent = document.querySelector("#job-percent"),
          count = document.querySelector("#job-count");
        if (bar) bar.style.width = job.progress + "%";
        if (percent) percent.textContent = job.progress + "%";
        if (count)
          count.textContent =
            Math.round((job.total * job.progress) / 100) +
            " / " +
            job.total +
            " " +
            t("条知识", "sources");
      }
    }, 650);
  }
  function videoCacheKey(b, v) {
    const text = JSON.stringify([
      b.name,
      b.description,
      b.fee,
      b.knowledge,
      v.scenes,
      v.template,
      v.accent,
      v.aspect,
    ]);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++)
      hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return "v" + (hash >>> 0);
  }
  function exportVideo(b) {
    const v = videoData(b);
    if (!v.generated)
      return toast(t("请先生成并保存脚本", "Generate and save a script first"));
    if (!("VideoEncoder" in window))
      return modal(
        t("请使用桌面浏览器导出", "Use a supported desktop browser"),
        "",
        `<p class="form-hint">${t("该浏览器未提供 WebCodecs 视频编码能力。正式版本需在桌面 Chrome 或 Edge 中导出；当前仍可在线播放、编辑和分享。", "This browser does not expose video encoding. Production exports require supported desktop Chrome or Edge. Playback, editing, and sharing remain available.")}</p>`,
        btn(t("知道了", "Got it"), "close-modal"),
      );
    const cache = videoCacheKey(b, v);
    if (v.cache[cache]) {
      toast(
        t(
          "命中当前版本缓存，免费且不占用首次次数",
          "Current-version cache hit. Free, with no export count used.",
        ),
      );
      return;
    }
    if (S().videoJob?.status === "running")
      return toast(t("已有导出正在进行", "An export is already running"));
    const cost = v.exports === 0 ? 0 : 50;
    confirmModal(
      t("开始模拟导出？", "Start a simulated export?"),
      `${v.aspect} · 720p · 24 fps · 15s<br>${cost === 0 ? t("这个 Ree 首次导出免费。", "First export for this Ree is free.") : t("预留 50 credits，成功后结算；取消则退回。", "Reserve 50 credits, settle on success, release on cancellation.")}<br>${t("此处不生成真实 MP4；请保持页面打开观察导出进度。", "No real MP4 is generated. Keep this tab open to see progress.")}`,
      t("开始模拟", "Start simulation"),
      () => {
        if (cost && !debit(cost))
          return toast(t("余额不足，请充值", "Insufficient credits"));
        S().videoJob = {
          dot: b.id,
          status: "running",
          progress: 0,
          cost,
          hold: cost ? U().lastDeduction : null,
          key: cache,
        };
        save();
        render();
        startExportClock();
      },
    );
  }
  function startExportClock() {
    if (exportTimer || S().videoJob?.status !== "running") return;
    exportTimer = setInterval(() => {
      const job = S().videoJob;
      if (!job || job.status !== "running") {
        clearInterval(exportTimer);
        exportTimer = null;
        return;
      }
      job.progress += 10;
      const target = dotById(job.dot);
      if (job.progress >= 100) {
        job.status = "done";
        const v = videoData(target);
        v.exports++;
        v.cache[job.key] = { aspect: v.aspect, created: date() };
        v.lastExport = { cost: job.cost, aspect: v.aspect };
        if (job.cost)
          creditEntry(
            title(target) + " · " + t("视频模拟导出", "Demo video export"),
            -job.cost,
            "video",
          );
        job.hold = null;
        save();
        clearInterval(exportTimer);
        exportTimer = null;
        if (route().path === "/dots/" + target.id + "/video") render();
        toast(
          t(
            "模拟导出完成，没有生成真实 MP4",
            "Demo export complete. No real MP4 generated.",
          ),
        );
      } else {
        save();
        paintExport();
      }
    }, 400);
  }
  function releaseExport() {
    const job = S().videoJob;
    if (job?.status !== "running") return;
    if (job.hold)
      for (const [bucket, amount] of Object.entries(job.hold))
        S()[bucket] += amount;
    job.status = "abandoned";
    job.hold = null;
    save();
    if (exportTimer) {
      clearInterval(exportTimer);
      exportTimer = null;
    }
    render();
    toast(
      t(
        "导出已取消，预留 credits 已释放",
        "Export cancelled. Reserved credits released.",
      ),
    );
  }
  function paintExport() {
    const container = document.querySelector("#export-status"),
      job = S().videoJob;
    if (container && job?.status === "running") {
      container.innerHTML = `<div class="export-running"><div class="between"><strong>${t("模拟渲染与上传", "Simulating render & upload")} · ${job.progress}%</strong>${btn(t("取消", "Cancel"), "cancel-export", "ghost sm")}</div><div class="progress"><span style="width:${job.progress}%"></span></div><small>${t("请保持此标签页打开 · 不会进行真实编码或上传", "Keep this tab open · No real encoding or upload")}</small></div>`;
    }
  }
  function tickVideo() {
    const stage = document.querySelector("#video-stage");
    if (!stage) {
      if (videoTimer) {
        clearInterval(videoTimer);
        videoTimer = null;
      }
      U().playing = false;
      lastFrame = 0;
      return;
    }
    if (document.hidden && U().playing) {
      U().playing = false;
      syncPlaybackControls();
    }
    if (!U().playing) {
      lastFrame = 0;
      return;
    }
    const now = performance.now();
    if (lastFrame) U().videoTime += (now - lastFrame) / 1000;
    lastFrame = now;
    if (U().videoTime >= 15) {
      U().videoTime = 15;
      U().playing = false;
      lastFrame = 0;
      syncPlaybackControls();
    }
    const b = dotById(stage.dataset.dot),
      v = playbackVideoData(b),
      scene = sceneAt(U().videoTime);
    if (scene !== lastScene) {
      const content = document.querySelector("#video-scene");
      if (content) content.innerHTML = stageContent(b, v, scene);
      lastScene = scene;
      document
        .querySelectorAll(".video-timeline button")
        .forEach((el, i) => el.classList.toggle("active", i === scene));
    }
    const clock = document.querySelector("#video-clock"),
      seek = document.querySelector("#video-seek");
    if (clock)
      clock.textContent =
        "00:" + String(Math.floor(U().videoTime)).padStart(2, "0") + " / 00:15";
    if (seek) seek.value = U().videoTime;
  }
  function afterRender() {
    ensure();
    rolePages.afterRender();
    ownedRees.afterRender();
    experience.afterRender();
    chatRoom.afterRender();
    dotConversation.afterRender();
    discovery.afterRender();
    adminRees.afterRender();
    adminRecords.afterRender();
    knowledge.afterRender();
    conversations.afterRender();
    if (route().path === "/settings" && route().query.get("tab") === "billing" && route().query.get("section") === "activity") requestAnimationFrame(()=>document.querySelector("#credit-activity")?.scrollIntoView({block:"start"}));
    manualKyc.afterRender();
    if (!document.querySelector(".dot-inline-player.is-page-fullscreen"))
      document.body.classList.remove("has-dot-fullscreen");
    lastFrame = 0;
    lastScene = -1;
    startJobClock();
    if (S().videoJob?.status === "running") startExportClock();
    paintExport();
    if (document.querySelector("#video-stage")) {
      tickVideo();
      syncPlaybackControls();
      if (!videoTimer) videoTimer = setInterval(tickVideo, 100);
    } else if (videoTimer) {
      clearInterval(videoTimer);
      videoTimer = null;
      U().playing = false;
    }
    for (const card of document.querySelectorAll(".dot-card")) {
      const link = card.querySelector('a[href^="#/d/"]');
      const b = link
        ? S().dots.find(
            (b) => link.getAttribute("href").split("?")[0] === "#/d/" + b.slug,
          )
        : null;
      const top = card.querySelector(".card-top");
      if (b && hasVideoIntroduction(b) && top && !card.querySelector(".discovery-cover") && !top.querySelector('[data-action="play-video"]'))
        top.insertAdjacentHTML(
          "beforeend",
          btn(
            I("play") + " 15s",
            "play-video",
            "ghost sm card-video-play",
            'data-id="' +
              b.id +
              '" aria-label="' +
              esc(t("播放介绍：", "Play introduction: ") + title(b)) +
              '"',
          ),
        );
    }
    const publicDot = route().path.startsWith("/d/")
      ? ctx.publicDotBySlug(route().path.split("/")[2])
      : null;
    if (
      publicDot &&
      hasPublicVideoIntroduction(publicDot) &&
      route().query.get("video") === "1" &&
      U().videoOpenedPath !== route().path
    ) {
      U().videoOpenedPath = route().path;
      U().playing = true;
      syncPlaybackControls();
      document.querySelector(".dot-inline-player")?.scrollIntoView({ block: "center" });
    }
    if (!publicDot) {
      U().videoOpenedPath = null;
      if (U().videoSurface?.startsWith("detail:")) U().videoSurface = null;
    }
    if (
      U().purchaseSuccess &&
      route().path === "/settings" &&
      route().query.get("tab") === "billing"
    ) {
      const purchase = U().purchaseSuccess;
      U().purchaseSuccess = null;
      modal(
        t("下一次好奇，已经准备好了。", "Ready for your next question."),
        t(
          "模拟购买成功 · 没有真实扣款",
          "Simulated purchase complete · No charge",
        ),
        '<div class="success-body"><div class="success-mark">' +
          I("check") +
          "</div><h3>+ " +
          n(purchase.credits) +
          " credits</h3><p>" +
          purchase.id +
          "<br>" +
          t(
            "余额和后台充值记录均已更新。",
            "Balance and console purchase records have been updated.",
          ) +
          "</p></div>",
        btn(t("查看我的余额", "View my balance"), "close-modal"),
      );
    }
  }
  function playVideoModal(b) {
    if (!hasVideoIntroduction(b)) return;
    lastFrame = 0;
    U().videoSurface = "modal:" + b.id;
    U().videoTime = 0;
    U().playing = true;
    lastScene = -1;
    const v = videoData(b);
    modal(
      t("15 秒，认识这个 Ree。", "Meet this Ree in 15 seconds."),
      esc(title(b)),
      `<div class="public-video-player">${videoStage(b, v)}${playerControls()}</div><p class="form-hint mt16">${t("介绍内容为示例动画，在线播放不收 credits。", "Illustrative animated introduction. Playback costs no credits.")}</p>`,
      L(b.owner === "me" ? "/dots/" + b.id : publicDotPage.path(b), (b.owner === "me" ? t("打开工作台", "Open studio") : t("查看 Ree 详情", "View Ree details")) + I("arrow"), "btn"),
      { wide: true, video: true },
    );
    afterRender();
  }
  async function onAction(a, d, el) {
    if (publicDotPage.onAction(a, d)) return true;
    ensure();
    if (await rolePages.onAction(a, d)) return true;
    if (adminRecords.onAction(a, d)) return true;
    if (ownedRees.onAction(a, d)) return true;
    if (discovery.onAction(a, d)) return true;
    if (await statisticsCalendar.onAction(a, d, el)) return true;
    if (await profile.onAction(a, d, el)) return true;
    if (await dotAvatar.onAction(a, d, el)) return true;
    if (await classification.onAction(a, d, el)) return true;
    if (await dotSetup.onAction(a, d, el)) return true;
    if (await dotConversation.onAction(a, d, el)) return true;
    if (await experience.onAction(a, d, el)) return true;
    if (await chatRoom.onAction(a, d, el)) return true;
    if (await knowledge.onAction(a, d, el)) return true;
    if (await conversations.onAction(a, d, el)) return true;
    if (await manualKyc.onAction(a, d, el)) return true;
    const adminActions = new Set([
      "manage-admins",
      "add-model",
      "edit-model",
      "probe-model",
      "activate-model",
      "toggle-user",
      "adjust-credits",
      "reset-kyc",
      "kyc-details",
      "moderate-dot",
      "review-payout",
      "finish-review",
      "audit-details",
      "export-csv",
      "purchase-tab",
      "clear-filters",
      "user-detail-tab",
    ]);
    if (adminActions.has(a) && !S().admin) {
      go("/admin/login");
      return true;
    }
    if (a === "home-demo") {
      modal(
        t("从一个问题，看见知识的价值。", "See knowledge answer a question."),
        t("示例回答 · 不消耗 credits", "Sample answer · No credits charged"),
        `<div class="home-demo-modal">${demoVisual()}</div>`,
        L(
          "/explore",
          t("发现自己的知识伙伴", "Find your next companion") + I("arrow"),
          "btn",
        ),
        { wide: true },
      );
      return true;
    }
    if (a === "home-citation") {
      modal(
        t("答案的出处", "The source behind the answer"),
        t("设计系统手册 · 第 24 页", "Design systems · Page 24"),
        `<div class="citation-preview">${t("先定义颜色、字体、间距等基础变量，再将常见交互沉淀成组件。每个组件应包含使用场景、完整状态和无障碍要求。", "Define colors, typography, and spacing before building components. Include usage, interaction states, and accessibility requirements.")}</div>`,
        btn(t("关闭", "Close"), "close-modal"),
      );
      return true;
    }
    if (a === "start-purchase") {
      go("/checkout?kind=" + d.kind);
      return true;
    }
    if (a === "dismiss-notice") {
      S().console.notices = S().console.notices.filter((x) => x.id !== d.id);
      save();
      render();
      return true;
    }
    if (a === "fill-admin") {
      document.querySelector("#admin-email").value = "admin@example.com";
      document.querySelector("#admin-password").value = "demo-re0-admin";
      document.querySelector("#admin-totp").value = "123456";
      if (document.querySelector("#admin-name"))
        document.querySelector("#admin-name").value = "RE0 Admin";
      return true;
    }
    if (a === "preview-setup") {
      confirmModal(
        t("体验空安装初始化", "Preview first-time setup"),
        t(
          "仅清除本地演示的管理员会话与安装标记，用户资料保留。接下来创建首位演示管理员。",
          "Only the local administrator session and installation flag are reset. User data stays.",
        ),
        t("进入初始化", "Open setup"),
        () => {
          S().admin = false;
          S().console.installed = false;
          save();
          go("/admin/setup");
        },
      );
      return true;
    }
    if (a === "admin-logout") {
      S().admin = false;
      save();
      go("/admin/login");
      return true;
    }
    if (a === "manage-admins") {
      modal(
        t("管理员", "Administrators"),
        t(
          "新管理员只能由已有管理员添加。",
          "Only existing administrators can invite another.",
        ),
        `${S()
          .console.admins.map(
            (ad) =>
              `<div class="settings-row"><div><h3>${esc(ad.name)}</h3><p>${esc(ad.email)}</p></div><span class="tag">${ad.role}</span></div>`,
          )
          .join(
            "",
          )}<div class="rule"></div><form id="add-admin-form">${field("new-admin-name", t("显示名称", "Name"), input("new-admin-name", "name", "", 'required maxlength="40"'))}${field("new-admin-email", t("邮箱", "Email"), input("new-admin-email", "email", "", 'type="email" required placeholder="colleague@example.com"'))}<div class="demo-label">${t("只添加本地演示管理员记录，不发送邀请，不生成真实密码或 TOTP。", "Creates a local demo administrator record only. No invitations or real credentials.")}</div></form>`,
        cancelButton() +
          submitButton(
            t("添加演示管理员", "Add demo administrator"),
            "add-admin-form",
          ),
      );
      return true;
    }
    if (a === "add-model" || a === "edit-model") {
      modelModal(d.id || null, d.kind || "generation");
      return true;
    }
    if (a === "probe-model") {
      const m = S().console.models.find((x) => x.id === d.id);
      el.disabled = true;
      el.innerHTML =
        '<i class="spinner"></i>' + t("模拟测试中", "Testing demo");
      setTimeout(() => {
        m.probe = m.base.includes(".invalid") ? "failed" : "success";
        audit("model.probe", m.id, null, m.probe);
        save();
        if (
          route().path === "/admin/models" &&
          !document.querySelector(".modal")
        )
          render();
        toast(
          m.probe === "success"
            ? t("模拟连通成功", "Demo connection succeeded")
            : t(
                "模拟连通失败，请检查端点",
                "Demo connection failed. Check endpoint.",
              ),
        );
      }, 800);
      return true;
    }
    if (a === "activate-model") {
      const m = S().console.models.find((x) => x.id === d.id);
      if (m.kind === "embedding") {
        if (S().console.job?.status === "running") {
          toast(
            t(
              "重算期间不能再次切换",
              "Cannot switch while a rebuild is running",
            ),
          );
          return true;
        }
        confirmModal(
          t("重算后切换向量模型？", "Rebuild before switching embeddings?"),
          t(
            "按知识逐条重算。完成前继续使用旧模型与旧向量，完成后统一切换。",
            "Knowledge is rebuilt source by source. The old model and vectors stay active until completion.",
          ),
          t("创建重算任务", "Start rebuild"),
          () => beginRebuild(m),
        );
      } else {
        const old = S().console.models.find(
          (x) => x.kind === m.kind && x.enabled,
        );
        S()
          .console.models.filter((x) => x.kind === m.kind)
          .forEach((x) => (x.enabled = x.id === m.id));
        audit("model.activate", m.id, old?.model, m.model);
        save();
        render();
        toast(t("已启用，下一次请求生效", "Activated for the next request"));
      }
      return true;
    }
    if (a === "clear-filters") {
      U().consoleFilters[d.key] = {
        q: "",
        status: "all",
        period: "all",
        tab: filters(d.key).tab,
      };
      render();
      return true;
    }
    if (a === "purchase-tab") {
      filters("purchases").tab = d.value;
      filters("purchases").status = "all";
      render();
      return true;
    }
    if (a === "user-detail-tab") {
      U().detailTab = d.value;
      render();
      return true;
    }
    if (a === "toggle-user") {
      const u = user(d.id);
      confirmModal(
        u.status === "active"
          ? t("停用这个用户？", "Disable this user?")
          : t("恢复这个用户？", "Restore this user?"),
        t(
          "账号资料与历史保留，操作将写入审计。",
          "Profile and history are retained. This action is audited.",
        ),
        t("确认", "Confirm"),
        () => {
          const next = u.status === "active" ? "disabled" : "active";
          if (u.id === "me") S().disabled = next === "disabled";
          else S().console.users.find((x) => x.id === u.id).status = next;
          audit(
            "user." + (next === "active" ? "restore" : "disable"),
            u.id,
            u.status,
            next,
          );
          save();
          render();
          toast(t("账号状态已更新", "Account status updated"));
        },
      );
      return true;
    }
    if (a === "adjust-credits") {
      adjustModal(d.id);
      return true;
    }
    if (a === "reset-kyc") {
      const k = kycRows().find((x) => x.id === d.id);
      modal(
        t("要求重新验证", "Require identity re-verification"),
        esc(user(k.user).name),
        `<form id="reset-kyc-form" data-id="${k.id}">${field("reset-kyc-reason", t("原因（必填）", "Reason (required)"), `<textarea id="reset-kyc-reason" name="reason" required minlength="3" maxlength="300" rows="3"></textarea>`)}<p class="form-hint">${t("原记录保留，新增一条待重新验证记录；用户的提现资格将暂停，并收到账户内提示。", "Keeps the old record and adds a re-verification entry. Payout eligibility is suspended and the user sees an account notice.")}</p></form>`,
        cancelButton() +
          submitButton(
            t("确认要求重新验证", "Require re-verification"),
            "reset-kyc-form",
          ),
      );
      return true;
    }
    if (a === "moderate-dot") {
      const b = dotById(d.id);
      modal(
        b.moderated
          ? t("恢复这个 Ree 的公开状态？", "Restore this Ree?")
          : t("将这个 Ree 下架？", "Take down this Ree?"),
        esc(title(b)),
        `<form id="moderate-form" data-id="${b.id}">${field("moderate-reason", t("操作原因（必填）", "Reason (required)"), `<textarea id="moderate-reason" name="reason" rows="3" required minlength="3" maxlength="300"></textarea>`)}<p class="form-hint">${t("下架后转为私有，退出公开发现与其他人的对话。已有历史回答保留，所有者会收到提示。", "A takedown makes the Ree private and removes it from discovery and others’ chats. Historical answers remain, and the owner is notified.")}</p></form>`,
        cancelButton() +
          submitButton(
            b.moderated
              ? t("恢复公开", "Restore visibility")
              : t("确认下架", "Take down"),
            "moderate-form",
          ),
      );
      return true;
    }
    if (a === "review-payout") {
      const p = payouts().find((p) => p.id === d.id);
      if (p)
        go(
          "/admin/payouts/" +
            p.id +
            (p.status === "approved" ? "/payment" : "") +
            (route().path === "/admin/payout-history" ? "?from=history" : ""),
        );
      return true;
    }
    if (a === "finish-review") {
      const p = findPayout(d.id),
        row = payouts().find((x) => x.id === d.id),
        note = document.querySelector("#review-note")?.value.trim() || "";
      if (!p || !row || route().path !== "/admin/payouts/" + d.id) return true;
      if (p.status !== "pending") {
        toast(t("这笔申请已处理", "Request already reviewed"));
        return true;
      }
      if (d.value === "rejected" && note.length < 3) {
        error(
          document.querySelector("#payout-review-form"),
          t(
            "请填写至少 3 个字符的驳回原因",
            "Enter a rejection reason of at least 3 characters",
          ),
        );
        return true;
      }
      if (!["approved", "rejected"].includes(d.value)) return true;
      if (d.value !== "rejected" && (user(row.user)?.kyc !== "verified" || userRoles.roleFor(row.user) === "official")) {
        toast(t("KYC 未通过，不能支付", "Verified KYC is required"));
        return true;
      }
      const before = p.status;
      p.status = d.value;
      p.reviewer = S().console.adminEmail;
      p.reviewedAt = new Date().toISOString();
      p.note = note;
      p.created ??= date();

      if (d.value === "rejected") {
        if (row.user === "me") {
          S().earnedCredits += p.credits;
          creditEntry(
            t("提现退回 · 解冻", "Payout released"),
            p.credits,
            "refund",
          );
        } else {
          const u = S().console.users.find((u) => u.id === row.user);
          if (u) u.earned += p.credits;
        }
      }
      audit("payout." + d.value, p.id, before, { status: p.status, note });
      save();
      if (d.value === "approved")
        go("/admin/payouts/" + p.id + "/payment" + payoutOriginQuery());
      else render();
      toast(
        d.value === "approved"
          ? t(
              "已批准，等待人工打款；额度继续冻结",
              "Approved for manual payment; credits remain held",
            )
          : t("已驳回，冻结额度已退回", "Rejected; held credits released"),
      );
      return true;
    }
    if (a === "audit-details") {
      const ad = S().console.audits.find((x) => x.id === d.id);
      modal(
        t("变更详情", "Audit details"),
        esc(auditActionLabel(ad.action)) + " · " + esc(ad.target),
        `<div class="two-col"><div><p class="field-label mb16">${t("变更前", "Before")}</p><pre class="code-block">${esc(JSON.stringify(ad.before, null, 2))}</pre></div><div><p class="field-label mb16">${t("变更后", "After")}</p><pre class="code-block">${esc(JSON.stringify(ad.after, null, 2))}</pre></div></div><p class="form-hint mt16">${esc(ad.actor)} · ${esc(ad.created)}</p>`,
        btn(t("关闭", "Close"), "close-modal"),
        { wide: true },
      );
      return true;
    }
    if (a === "export-csv") {
      exportCSV(d.key);
      return true;
    }
    if (a === "discovery-video-play") {
      playVideoModal(dotById(d.id));
      return true;
    }
    if (a === "play-video") {
      playVideoModal(dotById(d.id));
      return true;
    }
    if (a === "inline-video-fullscreen") {
      const player = document.querySelector(".dot-inline-player");
      try {
        const entered = await toggleInlineFullscreen(player);
        if (entered) {
          if (U().videoTime >= 15) U().videoTime = 0;
          U().playing = true;
          lastFrame = 0;
        }
        syncPlaybackControls();
      } catch {
        toast(t("浏览器暂时无法进入全屏，请重试。", "The browser could not enter fullscreen. Please try again."));
      }
      return true;
    }
    if (a === "video-play") {
      if (U().videoTime >= 15) U().videoTime = 0;
      U().playing = !U().playing;
      lastFrame = 0;
      syncPlaybackControls();
      return true;
    }
    if (a === "video-scene") {
      U().videoTime = [0, 3, 7, 12][Number(d.value)];
      lastScene = -1;
      const stage = document.querySelector("#video-stage"),
        b = dotById(stage.dataset.dot);
      document.querySelector("#video-scene").innerHTML = stageContent(
        b,
        videoData(b),
        Number(d.value),
      );
      document
        .querySelectorAll(".video-timeline button")
        .forEach((el, i) =>
          el.classList.toggle("active", i === Number(d.value)),
        );
      document.querySelector("#video-clock").textContent =
        "00:" + String(U().videoTime).padStart(2, "0") + " / 00:15";
      document.querySelector("#video-seek").value = U().videoTime;
      return true;
    }
    if (a === "generate-video") {
      const b = dotById(d.id);
      if (!b.knowledge.some((k) => k.status === "ready")) {
        toast(
          t("请先添加并处理知识", "Add and process a knowledge source first"),
        );
        return true;
      }
      confirmModal(
        t("生成 15 秒视频脚本？", "Generate a 15-second script?"),
        t(
          "根据 Ree 的简介、知识来源和示例问题模拟生成 4 个定长镜头，费用 20 credits。",
          "Simulates four timed scenes from the Ree’s profile, sources, and samples. Costs 20 credits.",
        ),
        t("生成 · 20 credits", "Generate · 20 credits"),
        () => {
          if (!debit(20))
            return toast(t("余额不足，请充值", "Insufficient credits"));
          const v = videoData(b);
          v.generated = true;
          v.revision++;
          creditEntry(
            title(b) + " · " + t("视频脚本", "Video script"),
            -20,
            "video",
          );
          save();
          render();
          toast(
            t(
              "演示脚本已生成，可逐镜头编辑",
              "Demo script generated. Edit each scene.",
            ),
          );
        },
      );
      return true;
    }
    if (a === "export-video") {
      exportVideo(dotById(d.id));
      return true;
    }
    if (a === "cancel-export") {
      releaseExport();
      return true;
    }
    if (a === "copy-video-link") {
      const b = dotById(d.id);
      if (!b.public) {
        toast(t("先开启 Ree 公开状态", "Make the Ree public first"));
        return true;
      }
      copy(location.href.split("#")[0] + "#/d/" + b.slug + "?video=1");
      return true;
    }
    if (a === "download-script") {
      const b = dotById(d.id),
        v = videoData(b);
      download(
        "re0-" + b.slug + "-script.json",
        JSON.stringify(
          {
            dot: title(b),
            duration: 15,
            fps: 24,
            resolution: "720p",
            aspect: v.aspect,
            template: v.template,
            accent: v.accent,
            music: v.music,
            scenes: v.scenes.map((s, i) => ({
              ...s,
              duration: sceneLengths[i],
            })),
          },
          null,
          2,
        ),
        "application/json",
      );
      toast(t("脚本已下载", "Script downloaded"));
      return true;
    }
    return false;
  }
  async function onSubmit(form, f, event) {
    if (ownedRees.onSubmit(form, f)) return true;
    if (discovery.onSubmit(form, f)) return true;
    ensure();
    if (await rolePages.onSubmit(form, f, event)) return true;
    if (adminRecords.onSubmit(form, f)) return true;
    if (adminRees.onSubmit(form, f)) return true;
    if (adminReeDetail.onSubmit(form, f)) return true;
    if (adminReeSource.onSubmit(form, f)) return true;
    if (await adminStatistics.onSubmit(form, f)) return true;
    if (dotAvatar.beforeSubmit(form)) return true;
    if (await dotSetup.onSubmit(form, f)) return true;
    if (await workspaceDetails.onSubmit(form,f)) return true;
    if (await dotStatistics.onSubmit(form, f)) return true;
    if (await experience.onSubmit(form, f)) return true;
    if (await knowledge.onSubmit(form, f)) return true;
    if (await conversations.onSubmit(form, f)) return true;
    if (await manualKyc.onSubmit(form, f, event)) return true;
    const id = form.id;
    const restricted = [
      "manual-payout-result",
      "model-form",
      "adjust-form",
      "reset-kyc-form",
      "moderate-form",
      "add-admin-form",
      "console-filter",
    ];
    if (restricted.includes(id) && !S().admin) {
      go("/admin/login");
      return true;
    }
    if (id === "manual-payout-result") {
      const p = findPayout(form.dataset.id),
        row = payouts().find((p) => p.id === form.dataset.id),
        result = event?.submitter?.value;
      if (!p || !row) return true;
      if (result === "paid" && (user(row.user)?.kyc !== "verified" || userRoles.roleFor(row.user) === "official")) {
        error(form, t("KYC 未通过，不能登记打款", "Verified KYC is required"));
        return true;
      }
      let release;
      try {
        release = recordPayoutResult(p, result, {
          actual: f.get("actual"),
          transferId: f.get("transferId"),
          reason: f.get("reason"),
          actor: S().console.adminEmail,
        });
      } catch {
        error(
          form,
          t(
            "请检查转账 ID、实付金额或至少 3 字的失败原因；仅可处理待打款记录。",
            "Check transfer ID, net amount or a failure reason of at least 3 characters. Only approved payouts may be processed.",
          ),
        );
        return true;
      }
      if (release) {
        if (row.user === "me") {
          S().earnedCredits += p.credits;
          creditEntry(
            t("提现失败 · 解冻", "Payout failed · Released"),
            p.credits,
            "refund",
          );
        } else {
          const u = S().console.users.find((u) => u.id === row.user);
          if (u) u.earned += p.credits;
        }
      }
      audit("payout." + result, p.id, "approved", {
        status: p.status,
        actual: p.actual,
        transferId: p.transferId,
        fee: p.fee,
        note: p.note,
      });
      save();
      closeModal();
      render();
      toast(
        release
          ? t(
              "失败已登记，冻结额度已退回",
              "Failure recorded; credits released",
            )
          : t("已登记人工打款结果", "Manual payment recorded"),
      );
      return true;
    }
    if (id === "admin-login-form") {
      const email = f.get("email").trim().toLowerCase(),
        password = f.get("password"),
        totp = f.get("totp");
      if (!S().console.installed) {
        error(
          form,
          t(
            "请先初始化首位管理员。",
            "Initialize the first administrator first.",
          ),
        );
        return true;
      }
      if (
        !S().console.admins.some((a) => a.email === email) ||
        password !== "demo-re0-admin" ||
        totp !== "123456"
      ) {
        error(
          form,
          t(
            "演示凭据不匹配。可点击「填入」使用演示账号。",
            "Demo credentials do not match. Use “Fill demo”.",
          ),
        );
        return true;
      }
      S().admin = true;
      S().console.adminEmail = email;
      audit("admin.login", email, null, "demo session");
      save();
      const next = route().query.get("next");
      go(
        next?.startsWith("/admin/") && next !== "/admin/login"
          ? next
          : "/admin/overview",
      );
      toast(t("已进入管理员演示会话", "Administrator demo session started"));
      return true;
    }
    if (id === "admin-setup-form") {
      if (S().console.installed) {
        error(
          form,
          t(
            "已有管理员，请登录或由其添加账号。",
            "An administrator already exists. Sign in or ask them to add an account.",
          ),
        );
        return true;
      }
      if (
        f.get("password") !== "demo-re0-admin" ||
        f.get("totp") !== "123456"
      ) {
        error(
          form,
          t(
            "原型初始化仅使用演示密码和验证码，可点击「填入」。",
            "Prototype setup uses demo credentials only. Click “Fill demo”.",
          ),
        );
        return true;
      }
      const email = f.get("email").trim().toLowerCase(),
        name = f.get("name").trim();
      if (!name) {
        error(form, t("请填写名称", "Enter a name"));
        return true;
      }
      S().console.admins = [{ email, name, role: "Owner" }];
      S().console.adminEmail = email;
      S().console.installed = true;
      S().admin = true;
      audit("admin.bootstrap", email, null, "first demo administrator");
      save();
      go("/admin/overview");
      toast(t("首位演示管理员已创建", "First demo administrator created"));
      return true;
    }
    if (id === "add-admin-form") {
      const email = f.get("email").trim().toLowerCase(),
        name = f.get("name").trim();
      if (!name || S().console.admins.some((x) => x.email === email)) {
        error(
          form,
          t(
            "名称不能为空，且邮箱不能重复。",
            "A name and a unique email are required.",
          ),
        );
        return true;
      }
      S().console.admins.push({ name, email, role: "Administrator" });
      audit("admin.create", email, null, { name, email });
      save();
      closeModal();
      render();
      toast(
        t(
          "本地演示管理员已添加，没有发送邀请",
          "Demo administrator added. No invitation sent.",
        ),
      );
      return true;
    }
    if (id === "console-filter") {
      const key = form.dataset.key,
        old = filters(key);
      U().consoleFilters[key] = {
        q: (f.get("q") || "").trim(),
        status: f.get("status") || "all",
        period: f.get("period") || "all",
        tab: old.tab,
      };
      render();
      return true;
    }
    if (id === "model-form") {
      const existing = S().console.models.find((m) => m.id === form.dataset.id),
        kind = existing?.kind || f.get("kind"),
        timeout = Number(f.get("timeout")),
        name = f.get("name").trim(),
        model = f.get("model").trim(),
        base = f.get("base").trim();
      if (
        !name ||
        !model ||
        !Number.isInteger(timeout) ||
        timeout < 5 ||
        timeout > 600
      ) {
        error(
          form,
          t(
            "请检查名称、模型标识和超时。",
            "Check name, identifier, and timeout.",
          ),
        );
        return true;
      }
      try {
        if (!["http:", "https:"].includes(new URL(base).protocol))
          throw Error();
      } catch {
        error(
          form,
          t("Base URL 必须是 http(s) 地址。", "Base URL must use HTTP(S)."),
        );
        return true;
      }
      if (
        existing?.enabled &&
        (existing.model !== model ||
          existing.transport !== f.get("transport") ||
          existing.base !== base)
      ) {
        error(
          form,
          t(
            "已启用配置不能直接修改模型或端点，请新增候选配置再切换。",
            "Create a candidate configuration before changing an active model or endpoint.",
          ),
        );
        return true;
      }
      if (
        existing?.kind === "embedding" &&
        S().console.job?.status === "running"
      ) {
        error(
          form,
          t(
            "重算运行期间不可修改向量配置。",
            "Embedding configurations cannot be edited during a rebuild.",
          ),
        );
        return true;
      }
      const before = existing ? { ...existing } : null,
        m = {
          id: existing?.id || uid(),
          kind,
          name,
          model,
          base,
          transport: f.get("transport"),
          tail: f.get("key").slice(-4),
          timeout,
          enabled: existing?.enabled || false,
        };
      if (existing) Object.assign(existing, m);
      else S().console.models.push(m);
      audit(existing ? "model.update" : "model.create", m.id, before, m);
      save();
      closeModal();
      render();
      toast(t("模型配置已保存", "Model configuration saved"));
      return true;
    }
    if (id === "adjust-form") {
      const u = user(form.dataset.id),
        amount = Number(f.get("amount")),
        reason = f.get("reason").trim(),
        bucket = f.get("bucket"),
        sign = f.get("direction") === "grant" ? 1 : -1;
      if (
        !Number.isInteger(amount) ||
        amount < 1 ||
        amount > 10000000 ||
        reason.length < 3
      ) {
        error(
          form,
          t(
            "请输入有效整数，并填写至少 3 个字符的原因。",
            "Enter a positive integer and a reason of at least 3 characters.",
          ),
        );
        return true;
      }
      if (sign < 0 && u[bucket] < amount) {
        error(
          form,
          t(
            "该类余额不足，不能扣为负数。",
            "This balance cannot be made negative.",
          ),
        );
        return true;
      }
      const before = u[bucket],
        delta = amount * sign;
      if (u.id === "me") {
        S()[bucket === "plan" ? "planCredits" : "packCredits"] += delta;
        creditEntry(
          t("管理员调整", "Administrator adjustment"),
          delta,
          "admin_adjust",
        );
        S().entries[0].reason = reason;
        notice(
          t(
            "管理员调整了你的 Credits：",
            "An administrator adjusted your credits: ",
          ) +
            (delta > 0 ? "+" : "") +
            n(delta) +
            " · " +
            reason,
        );
      } else {
        const actual = S().console.users.find((x) => x.id === u.id);
        actual[bucket] += delta;
        actual.entries ??= [];
        actual.entries.unshift({
          title: t("管理员调整", "Administrator adjustment"),
          amount: delta,
          time: date(),
          reason,
        });
      }
      audit(
        "user.credits.adjust",
        u.id,
        { bucket, balance: before },
        { bucket, balance: before + delta, reason },
      );
      save();
      closeModal();
      render();
      toast(t("Credits 与审计记录已更新", "Credits and audit record updated"));
      return true;
    }
    if (id === "reset-kyc-form") {
      const k = kycRows().find((k) => k.id === form.dataset.id),
        reason = f.get("reason").trim();
      if (reason.length < 3) {
        error(
          form,
          t(
            "请填写至少 3 个字符的原因",
            "Enter a reason of at least 3 characters",
          ),
        );
        return true;
      }
      S().console.kyc.unshift({
        id: uid(),
        user: k.user,
        status: "reset",
        provider: "manual",
        legalName: k.legalName,
        country: k.country,
        kind: k.kind,
        last4: k.last4,
        expires: k.expires,
        tax: k.tax,
        declared: false,
        submitted: date(),
        decided: "—",
        reason,
      });
      if (k.user === "me") {
        S().kyc = "reset";
        notice(
          t(
            "请重新完成身份验证：",
            "Please complete identity verification again: ",
          ) + reason,
        );
      } else {
        S().console.users.find((u) => u.id === k.user).kyc = "reset";
        notice(
          t(
            "请重新完成身份验证：",
            "Please complete identity verification again: ",
          ) + reason,
          k.user,
        );
      }
      audit("kyc.reset", k.user, k.status, { status: "reset", reason });
      save();
      closeModal();
      render();
      toast(
        t(
          "原记录已保留，新增了重新验证要求",
          "Previous record retained. Re-verification required.",
        ),
      );
      return true;
    }
    if (id === "moderate-form") {
      const b = dotById(form.dataset.id),
        reason = f.get("reason").trim();
      if (reason.length < 3) {
        error(
          form,
          t(
            "请填写至少 3 个字符的原因",
            "Enter a reason of at least 3 characters",
          ),
        );
        return true;
      }
      const restore = !!b.moderated,
        before = { public: b.public, moderated: !!b.moderated };
      b.moderated = !restore;
      b.public = restore;
      if (!restore)
        S().chats.forEach((c) => {
          if (b.owner !== "me") c.dots = c.dots.filter((id) => id !== b.id);
        });
      notice(
        (restore
          ? t("你的 Ree 已恢复公开：", "Your Ree is public again: ")
          : t("你的 Ree 已被转为私有：", "Your Ree has been made private: ")) +
          title(b) +
          " · " +
          reason,
        ownerId(b),
      );
      audit(restore ? "dot.restore" : "dot.takedown", b.id, before, {
        public: b.public,
        reason,
      });
      save();
      closeModal();
      render();
      toast(
        t(
          "公开状态已更新，所有者提示已记录",
          "Visibility updated and owner notice recorded",
        ),
      );
      return true;
    }
    if (id === "suite-order-form") {
      if (S().disabled) {
        error(
          form,
          t(
            "账号已停用，暂时无法购买。",
            "This account is disabled and cannot purchase.",
          ),
        );
        return true;
      }
      if (!S().signed) {
        go(
          "/login?next=" +
            encodeURIComponent(route().path + "?kind=" + form.dataset.kind),
        );
        return true;
      }
      const kind = form.dataset.kind,
        q =
          kind === "pack"
            ? Math.max(1, Math.min(10, U().checkoutQuantity || 1))
            : 1;
      if (kind === "plan" && S().plan) {
        error(
          form,
          t(
            "已有有效订阅，请到计费页管理。",
            "You already have an active Plan. Manage it in Billing.",
          ),
        );
        return true;
      }
      if (kind === "pack" && !S().plan) {
        error(
          form,
          t(
            "有效 Plan 订阅才能购买 Pack。",
            "An active Plan is required for a Pack.",
          ),
        );
        return true;
      }
      if (f.get("consent") !== "on") {
        error(
          form,
          t("请确认模拟购买说明", "Acknowledge the purchase simulation"),
        );
        return true;
      }
      if (kind === "plan") {
        S().plan = true;
        S().cancelled = false;
        S().planCredits += 100000;
      } else S().packCredits += 100000 * q;
      const purchase = {
        id: "txn_demo_" + uid().slice(0, 8),
        user: "me",
        kind,
        amount: 10 * q,
        credits: 100000 * q,
        status: "paid",
        created: date(),
      };
      S().console.purchases.unshift(purchase);
      creditEntry(
        (kind === "plan" ? "Plan" : "Pack") +
          " · " +
          t("模拟充值", "Demo purchase"),
        purchase.credits,
        "purchase",
      );
      save();
      U().purchaseSuccess = purchase;
      go("/settings?tab=billing");
      return true;
    }
    if (id === "video-edit-form") {
      const b = dotById(form.dataset.id),
        v = videoData(b),
        values = {
          name: f.get("name").trim(),
          position: f.get("position").trim(),
          sources: f
            .get("sources")
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
          question: f.get("question").trim(),
          answer: f.get("answer").trim(),
          cta: f.get("cta").trim(),
        };
      const limits = {
        name: 20,
        position: 24,
        question: 30,
        answer: 50,
        cta: 16,
      };
      if (
        Object.entries(limits).some(
          ([key, max]) => !values[key] || Array.from(values[key]).length > max,
        ) ||
        !values.sources.length ||
        values.sources.length > 4 ||
        values.sources.some((s) => Array.from(s).length > 20)
      ) {
        error(
          form,
          t(
            "请遵守各镜头字符上限：名字 20、定位 24、来源每条 20、问题 30、答案 50、号召 16。",
            "Check limits: name 20, position 24, source 20, question 30, answer 50, call to action 16.",
          ),
        );
        return true;
      }
      v.scenes = [
        { name: values.name, position: values.position },
        { sources: values.sources.join("\n") },
        { question: values.question, answer: values.answer },
        { cta: values.cta },
      ];
      v.template = f.get("template");
      v.accent = f.get("accent");
      v.aspect = f.get("aspect");
      v.music = f.get("music") === "on";
      v.revision++;
      save();
      render();
      toast(t("视频脚本与样式已保存", "Video script and style saved"));
      return true;
    }
    return false;
  }
  function guide() {
    ensure();
    const items = [
      ["/", t("网站首页", "Website home"), "globe"],
      ["/pricing", t("价格与购买", "Pricing"), "wallet"],
      ["/checkout?kind=plan", t("购买确认", "Checkout"), "check"],
      ["/login", t("用户登录", "User sign-in"), "lock"],
      ["/dashboard", t("工作台 · 空间概览与管理", "Dashboard · Workspace overview"), "layers"],
      ["/talk", t("新建对话", "New conversation"), "chat"],
      ["/dots", t("我的 Ree", "My Rees"), "dot"],
      [
        mine()[0] ? "/dots/" + mine()[0].id : "/dots",
        t("知识与问答工作台", "Knowledge & chat"),
        "file",
      ],
      ["/chats", t("搜索对话", "Search conversations"), "search"],
      ["/explore", t("发现 Ree", "Discover"), "compass"],
      ["/videos", t("视频工作室", "Video studio"), "film"],
      ["/billing", t("余额、订阅与提现", "Credits & payouts"), "wallet"],
      ["/settings", t("连接与域名", "Connections"), "settings"],
      ["/d/design-partner", t("Ree 公开页", "Public Ree"), "external"],
      ["/admin/login", t("后台独立登录", "Admin sign-in"), "shield"],
      ...adminNav.map(([path, ic, zh, en]) => [
        "/admin/" + path,
        t(zh, en),
        ic,
      ]),
    ];
    modal(
      t(
        "一个完整网站，每一条路径都能走。",
        "A complete website. Every path connected.",
      ),
      t(
        "官网 → 用户空间 → 管理后台 · 最新 rebuild-proposal.md",
        "Website → Workspace → Console · Updated proposal",
      ),
      `<div class="guide-domains"><span>01 ${t("官网", "WEBSITE")}</span><span>02 ${t("用户空间", "WORKSPACE")}</span><span>03 ${t("管理后台", "CONSOLE")}</span></div><div class="route-map">${items.map(([url, label, ic]) => L(url, `${I(ic)}<div><strong>${label}</strong><small>${esc(url)}</small></div>`, "guide-route")).join("")}</div><div class="demo-label mt16">${t("所有模型、登录、验证、支付、导出均为模拟。后台演示凭据：admin@example.com / demo-re0-admin / 123456。网页只保存本地演示数据，不使用现有业务系统。", "All models, authentication, verification, payments, and video exports are simulated. Admin: admin@example.com / demo-re0-admin / 123456. This site only uses local demo data.")}</div>`,
      btn(t("开始探索", "Explore"), "close-modal"),
      { wide: true },
    );
  }
  document.addEventListener("input", (e) => {
    if (e.target.id === "payout-actual") {
      const p = findPayout(e.target.closest("form").dataset.id),
        actual = Number(e.target.value),
        output = document.querySelector("#payout-calculated-fee");
      if (output)
        output.textContent =
          p && e.target.value && actual > 0 && actual <= p.credits / 10000
            ? money(p.credits / 10000 - actual)
            : "—";
    }

    if (e.target.id === "question-range") {
      const value = Number(e.target.value);
      document.querySelector("#estimate-count").textContent = n(value);
      document.querySelector("#estimate-credit").textContent = n(value * 20);
      document.querySelector("#estimate-dollar").textContent =
        "≈ " + money((value * 20) / 10000);
    }
    if (e.target.id === "video-seek") {
      U().videoTime = Number(e.target.value);
      U().playing = false;
      syncPlaybackControls();
      lastScene = -1;
      const stage = document.querySelector("#video-stage"),
        b = dotById(stage.dataset.dot);
      document.querySelector("#video-scene").innerHTML = stageContent(
        b,
        playbackVideoData(b),
        sceneAt(U().videoTime),
      );
      document.querySelector("#video-clock").textContent =
        "00:" + String(Math.floor(U().videoTime)).padStart(2, "0") + " / 00:15";
      document
        .querySelectorAll(".video-timeline button")
        .forEach((el, i) =>
          el.classList.toggle("active", i === sceneAt(U().videoTime)),
        );
    }
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "pack-quantity") {
      U().checkoutQuantity = Number(e.target.value);
      for (const id of ["order-subtotal", "order-total"])
        document.querySelector("#" + id).textContent = money(
          U().checkoutQuantity * 10,
        );
      document.querySelector("#order-credit").textContent =
        n(U().checkoutQuantity * 100000) + " credits";
    }

  });
  // Restore a cancelled browser export safely when the page is refreshed.
  ensure();
  if (S().videoJob?.status === "running") {
    const hold = S().videoJob.hold;
    if (hold)
      for (const [bucket, amount] of Object.entries(hold))
        S()[bucket] += amount;
    S().videoJob.status = "abandoned";
    S().videoJob.hold = null;
    save();
  }
  return {
    discoveryCover,
    userRoles,
    rolePages,
    dotAvatar,
    classification,
    dotSetup,
    dotConversation,
    publicDot: publicDotPage,
    discovery,
    usage,
    workspace,
    ownedRees,
    profile,
    experience,
    chatRoom,
    knowledge,
    conversations,
    resolve,
    afterRender,
    onAction,
    onSubmit,
    guide,
    audit,
    manualKyc,
  };
}
