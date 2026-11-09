import { activePayout } from "./manual-kyc.js";

const amount = (value) =>
  Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
export function sourceSummary(sources = []) {
  const result = {
    total: sources.length,
    ready: 0,
    processing: 0,
    failed: 0,
    paused: 0,
  };
  for (const source of sources) {
    if (source.enabled === false) result.paused++;
    else if (source.status === "ready") result.ready++;
    else if (source.status === "failed") result.failed++;
    else result.processing++;
  }
  return result;
}
export function workspaceSummary(state) {
  const dots = (state.dots || [])
    .filter((dot) => dot.owner === "me")
    .map((dot) => ({
      dot,
      sources: sourceSummary(dot.knowledge || []),
      answers: amount(dot.answers),
    }));
  const sources = sourceSummary(dots.flatMap((row) => row.dot.knowledge || []));
  return {
    dots,
    sources,
    publicDots: dots.filter((row) => row.dot.public && !row.dot.moderated)
      .length,
    privateDots: dots.filter((row) => !row.dot.public || row.dot.moderated)
      .length,
    answers: dots.reduce((sum, row) => sum + row.answers, 0),
    earned: amount(state.earnedCredits),
    held: (state.payouts || [])
      .filter(activePayout)
      .reduce((sum, p) => sum + amount(p.credits), 0),
  };
}
export function creatorPayoutStatus(state, now = Date.now()) {
  const active = (state.payouts || []).find(activePayout);
  if (active) return active.status === "approved" ? "payment" : "review";
  if (state.kyc === "pending") return "identity-pending";
  if (state.kyc !== "verified") return "identity-required";
  if (!state.paypal) return "paypal";
  if (state.paypalChanged > 0 && now - state.paypalChanged < 7 * 86400000)
    return "hold";
  return amount(state.earnedCredits) >= 500000 ? "eligible" : "threshold";
}

export function createWorkspace(ctx) {
  const { t, I, esc, n, title, avatar, btn, shell, footer } = ctx;
  const S = ctx.getState;
  const summary = () => workspaceSummary({ ...S(), dots: ctx.getOwnedRees?.() || S().dots });
  const reePath = dot => dot.ownedDemo
    ? "/dots?view=list&q=" + encodeURIComponent(title(dot))
    : "/dots/" + dot.id;
  const link = (path, label, cls = "text-link") =>
    `<a href="#${path}" class="${cls}">${label}</a>`;
  const dollars = (credits) => "$" + (credits / 10000).toFixed(2);
  function income(data) {
    if(ctx.userRoles?.roleFor("me")==="official")return `<section class="card creator-income"><h2>${t("官方账号", "Official account")}</h2><p class="muted">${t("官方账号无需 KYC，不提供提现。查询费收入在管理后台统计中查看。", "Official accounts do not need KYC or withdrawals. View income in the admin console.")}</p></section>`;
    const status = creatorPayoutStatus(S());
    const identity = ["identity-required", "identity-pending"].includes(status);
    const [heading, description, label] = {
      "identity-required": [
        t("完成身份验证", "Complete identity verification"),
        t(
          "提交身份资料与税务声明，人工审核通过后可绑定收款邮箱。",
          "Submit identity details and a tax declaration for manual review before connecting PayPal.",
        ),
        t(
          S().kyc === "rejected" || S().kyc === "reset"
            ? "重新提交资料"
            : "提交身份资料",
          "Submit identity details",
        ),
      ],
      "identity-pending": [
        t("身份资料待审核", "Identity review pending"),
        t(
          "你的资料已提交，等待管理员人工审核。",
          "Your identity submission is awaiting manual review.",
        ),
        t("查看提交资料", "View submission"),
      ],
      paypal: [
        t("完善收款方式", "Connect your payout destination"),
        t(
          "身份审核已通过，绑定 PayPal 个人账户邮箱后可申请提现。",
          "Identity verified. Connect a personal PayPal email to request a payout.",
        ),
        t("设置收款邮箱", "Set payout email"),
      ],
      hold: [
        t("收款邮箱保护期", "Payout email protection period"),
        t(
          "更换邮箱后 7 天内暂停提现。",
          "Payouts are paused for seven days after changing the email.",
        ),
        t("查看余额与计费", "View billing"),
      ],
      threshold: [
        t("收入持续积累中", "Your earnings are growing"),
        t(
          "收入达到 500,000 credits（$50）后可申请提现。",
          "Payouts become available at 500,000 earned credits ($50).",
        ),
        t("查看收入明细", "View earnings"),
      ],
      eligible: [
        t("已满足提现条件", "Ready to request a payout"),
        t(
          "身份与收款信息已就绪，可前往余额与计费申请提现。",
          "Identity and payout details are ready. Request a payout in billing.",
        ),
        t("前往申请提现", "Request a payout"),
      ],
      review: [
        t("提现申请待审核", "Payout awaiting review"),
        t(
          "申请金额已冻结，管理员审核后安排人工打款。",
          "Requested earnings are held for review and manual payment.",
        ),
        t("查看提现进度", "View payout status"),
      ],
      payment: [
        t("等待人工打款", "Awaiting manual payment"),
        t(
          "提现申请已批准，等待管理员完成 PayPal 转账。",
          "Your payout was approved and is awaiting a manual PayPal transfer.",
        ),
        t("查看提现进度", "View payout status"),
      ],
    }[status];
    return `<section class="card creator-income"><div class="creator-panel-heading"><h2>${t("收入与提现", "Earnings & payouts")}</h2>${I("wallet")}</div><div class="creator-income-balance"><span>${t("收入余额", "Earned balance")}</span><strong>${dollars(data.earned)}</strong><small>${n(data.earned)} credits</small></div>${data.held ? `<div class="creator-held">${t("提现冻结中", "Held for payout")}<strong>${n(data.held)} credits</strong></div>` : ""}<div class="creator-income-state"><span class="creator-state-icon">${I(identity ? "shield" : "wallet")}</span><div><h3>${heading}</h3><p>${description}</p></div></div>${link(identity ? "/settings/identity" : "/settings?tab=billing", label + I("arrow"), "btn secondary full")}<p class="creator-income-foot">${t("仅收入 credits 可提现，最低 $50。", "Only earned credits are withdrawable. Minimum $50.")}</p></section>`;
  }
  function attention(data) {
    const rows = data.dots.filter(
      (row) =>
        row.dot.moderated ||
        !row.sources.total ||
        row.sources.failed ||
        row.sources.processing,
    );
    return `<section class="card creator-attention"><div class="creator-panel-heading"><h2>${t("待处理事项", "Needs attention")}</h2><span class="creator-count">${rows.length}</span></div>${
      rows.length
        ? rows
            .slice(0, 5)
            .map(({ dot, sources }) => {
              const target = dot.ownedDemo ? reePath(dot) :
                "/dots/" +
                dot.id +
                "/knowledge" +
                (sources.failed
                  ? "?status=failed"
                  : sources.processing
                    ? "?status=processing"
                    : "");
              return link(
                target,
                `<div><strong>${esc(title(dot))}</strong><p>${dot.moderated ? t("公开状态需处理", "Public visibility needs attention") : !sources.total ? t("尚未添加知识来源", "No knowledge sources yet") : [sources.failed ? t(sources.failed + " 个来源失败", sources.failed + " failed sources") : "", sources.processing ? t(sources.processing + " 个来源处理中", sources.processing + " processing sources") : ""].filter(Boolean).join(" · ")}</p></div>${I("arrow")}`,
                "creator-attention-row",
              );
            })
            .join("")
        : `<div class="creator-attention-empty">${I("check")}<strong>${t("当前没有待处理事项", "You're all caught up")}</strong><p>${t("知识来源状态良好，随时可以继续完善。", "Your sources are in good shape and ready for continued improvements.")}</p></div>`
    }${rows.length > 5 ? link("/dots", t("还有 " + (rows.length - 5) + " 个 Ree 需要关注 · 查看全部", (rows.length - 5) + " more Rees need attention · View all"), "text-link creator-overview-more") : ""}</section>`;
  }
  function health(data) {
    const states = [
      ["ready", t("已就绪", "Ready")],
      ["processing", t("处理中", "Processing")],
      ["failed", t("处理失败", "Failed")],
      ["paused", t("已停用", "Disabled")],
    ];
    return `<section class="card creator-health"><div class="creator-panel-heading"><div><h2>${t("知识来源状态", "Source health")}</h2><p>${t("按当前处理状态统计", "Current processing state")}</p></div><strong>${n(data.sources.total)} <small>${t("个来源", "sources")}</small></strong></div>${data.sources.total ? `<div class="creator-health-bar" role="img" aria-label="${esc(states.map(([key, label]) => label + " " + data.sources[key]).join(", "))}">${states.map(([key]) => `<span class="${key}" style="width:${(data.sources[key] / data.sources.total) * 100}%"></span>`).join("")}</div><div class="creator-health-legend">${states.map(([key, label]) => `<div><i class="${key}"></i><span>${label}</span><strong>${n(data.sources[key])}</strong></div>`).join("")}</div>` : `<p class="creator-empty-note">${t("为 Ree 添加知识后，这里会展示处理状态。", "Add sources to your Rees to see their processing status here.")}</p>`}</section>`;
  }
  function distribution(data) {
    const rows = [...data.dots].sort((a, b) => b.answers - a.answers).slice(0, 5);
    const max = Math.max(1, ...rows.map((row) => row.answers));
    return `<section class="card creator-distribution"><div class="creator-panel-heading"><div><h2>${t(data.dots.length > 5 ? "回答最多的 5 个 Ree" : "回答分布", data.dots.length > 5 ? "Top 5 Rees by answers" : "Answers by Ree")}</h2><p>${t("累计成功回答 · 演示数据", "Cumulative successful answers · Demo data")}</p></div>${I("chat")}</div>${data.answers ? rows.map(({ dot, answers }) => `<div class="creator-answer-row"><div><span>${esc(title(dot))}</span><strong>${n(answers)}</strong></div><div class="creator-answer-bar"><span style="width:${(answers / max) * 100}%"></span></div></div>`).join("") : `<p class="creator-empty-note">${t("尚无成功回答。完善知识后，可以在 Ree 内测试回答效果。", "No successful answers yet. Add knowledge and test your Ree's responses.")}</p>`}</section>`;
  }
  function page() {
    const data = summary();
    const testCount = data.dots.filter(({ dot }) => dot.ownedDemo).length;
    const scopeNote = testCount
      ? t("统计范围：与「我的 Ree」一致，共 " + n(data.dots.length) + " 个 Ree（含 " + n(testCount) + " 个测试 Ree）。来源不含回收站，回答为累计统计；测试公开状态刷新后恢复。收入余额按账户流水统计。", "Scope: the same " + n(data.dots.length) + " Rees as My Rees, including " + n(testCount) + " test Rees. Sources exclude the trash; answers are cumulative. Test visibility resets on refresh. Earnings follow account transactions.")
      : t("统计范围：你创建的 Ree。来源按当前记录统计，回收站中的来源已排除；回答数量为累计演示数据。", "Scope: Rees you own. Source counts exclude the trash; answer counts are cumulative demo data.");
    const metrics = [
      [
        t("我的 Ree", "My Rees"),
        data.dots.length,
        t(
          data.publicDots + " 个公开 · " + data.privateDots + " 个仅自己或已下架",
          data.publicDots + " public · " + data.privateDots + " private or taken down",
        ),
        "dot",
        "/dots?visibility=all",
      ],
      [
        t("知识来源", "Knowledge sources"),
        data.sources.total,
        t(
          data.sources.ready + " 个已就绪",
          data.sources.ready + " ready sources",
        ),
        "file",
        "/workspace/sources?scope=mine&dot=all&status=all&kind=all",
      ],
      [
        t("累计成功回答", "Successful answers"),
        data.answers,
        t("我的 Ree · 累计演示数据", "Owned Rees · Cumulative demo data"),
        "chat",
        "/workspace/answers?scope=mine&dot=all&status=answered&view=summary&period=all",
      ],
      [
        t("收入余额", "Earned balance"),
        data.earned,
        t(
          dollars(data.earned) + " · 查询费收入",
          dollars(data.earned) + " · Query-fee earnings",
        ),
        "wallet",
        "/settings?tab=billing&activity=income&section=activity",
      ],
    ];
    return shell(
      `<div class="page creator-overview ${ctx.userRoles?.roleFor("me") === "official" ? "official-overview" : ""}"><div class="creator-overview-head"><div><p class="eyebrow">YOUR DAILY SPACE</p><h1>${t("工作台", "Dashboard")}</h1><p>${t("管理你的 Ree，关注知识状态、回答表现与收入。", "Manage your Rees, source health, answer activity, and earnings.")}</p></div>${btn(I("plus") + t("创建 Ree", "Create Ree"), "create-dot")}</div><div class="dashboard-section-heading"><h2>${t("我的空间概览", "Your workspace at a glance")}</h2><span>${t("知识、回答与收入，尽在这里", "Your knowledge, answers and earnings")}</span></div><div class="creator-metrics">${metrics.filter((_, index) => index !== 3 || ctx.userRoles?.roleFor("me") !== "official").map(([label, value, note, icon, path]) => `<${path ? 'a href="#' + path + '"' : "article"} class="card creator-metric"><div><span>${label}</span>${I(icon)}</div><strong>${n(value)}</strong><small>${note}</small></${path ? "a" : "article"}>`).join("")}</div><div class="creator-overview-grid"><div class="creator-overview-main"><section class="card creator-dot-panel"><div class="creator-panel-heading"><div><h2>${t("我的 Ree", "My Rees")}</h2><p>${t("知识和视频介绍，都在各自的 Ree 中管理。", "Manage knowledge and video introductions within each Ree.")}</p></div>${link("/dots", t("查看全部", "View all") + I("arrow"))}</div>${data.dots.length ? `<div class="creator-dot-list">${data.dots.slice(0, 5).map(({ dot, sources, answers }) => `<article class="creator-dot-row"><div class="creator-dot-identity">${avatar(dot)}<div><a href="#${reePath(dot)}"><strong>${esc(title(dot))}</strong></a><span class="creator-dot-visibility ${dot.public && !dot.moderated ? "public" : ""}">${I(dot.public && !dot.moderated ? "globe" : "lock")}${(dot.moderated ? t("已下架", "Taken down") : dot.public ? t("已公开", "Public") : t("私有", "Private")) + (dot.ownedDemo ? t(" · 测试 Ree", " · Test Ree") : "")}</span></div></div><div class="creator-dot-figures"><div><strong>${n(sources.ready)}<small> / ${n(sources.total)}</small></strong><span>${t("来源已就绪", "Sources ready")}</span></div><div><strong>${n(answers)}</strong><span>${t("累计回答", "Total answers")}</span></div></div><div class="creator-dot-actions">${dot.ownedDemo ? link(reePath(dot), t("查看测试 Ree", "View test Ree"), "btn secondary sm") : `${link("/dots/" + dot.id + "/knowledge", t("管理知识", "Knowledge"), "btn secondary sm")}${link("/dots/" + dot.id + "/video", I("film") + t("视频介绍", "Video"), "btn ghost sm")}`}</div></article>`).join("")}</div>${data.dots.length > 5 ? link("/dots", t("查看全部 " + data.dots.length + " 个 Ree", "View all " + data.dots.length + " Rees") + I("arrow"), "text-link creator-overview-more") : ""}` : `<div class="empty creator-overview-empty">${I("dot")}<h3>${t("从你的第一个 Ree 开始", "Start with your first Ree")}</h3><p>${t("创建一个 Ree，添加知识，让它开始回答。", "Create a Ree, add knowledge and let it start answering.")}</p>${btn(t("创建 Ree", "Create Ree"), "create-dot")}</div>`}</section>${health(data)}${distribution(data)}</div><aside class="creator-overview-side">${attention(data)}${income(data)}</aside></div><p class="creator-data-note">${scopeNote}</p>${footer()}</div>`,
    );
  }
  return { page, summary };
}
