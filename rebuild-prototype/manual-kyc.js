// Local prototype only: image bytes stay in memory, never in storage or on a server.
export const activePayout = (p) => ["pending", "approved"].includes(p.status);
export function recordPayoutResult(
  payout,
  status,
  values,
  now = new Date().toISOString(),
) {
  if (payout.status !== "approved") throw new Error("stale");
  if (status === "paid") {
    const actual = Number(values.actual),
      requested = payout.credits / 10000;
    if (
      !String(values.transferId || "").trim() ||
      !Number.isFinite(actual) ||
      actual <= 0 ||
      actual > requested ||
      Math.abs(actual * 100 - Math.round(actual * 100)) > 0.0001
    )
      throw new Error("payment");
    Object.assign(payout, {
      status,
      actual,
      transferId: values.transferId.trim(),
      fee: Math.round((requested - actual) * 100) / 100,
      paidBy: values.actor,
      paidAt: now,
    });
  } else if (
    status === "failed" &&
    String(values.reason || "").trim().length >= 3
  ) {
    Object.assign(payout, {
      status,
      note: values.reason.trim(),
      failedBy: values.actor,
      failedAt: now,
    });
  } else throw new Error("reason");
  return status === "failed";
}
export function expireKycFiles(record, now = Date.now()) {
  if (
    record.status !== "verified" ||
    !Number.isFinite(Date.parse(record.decided)) ||
    now < Date.parse(record.decided) + 30 * 86400000
  )
    return false;
  if (record.filesDeletedAt) return false;
  record.document = null;
  record.selfie = null;
  record.filesDeletedAt = new Date(now).toISOString();
  return true;
}
export function decideKyc(
  records,
  id,
  status,
  reason,
  reviewer,
  now = new Date().toISOString(),
) {
  const record = records.find((k) => k.id === id);
  if (
    !record ||
    record.status !== "pending" ||
    records.find((k) => k.user === record.user)?.id !== id
  )
    throw new Error("stale");
  if (
    !["verified", "rejected"].includes(status) ||
    (status === "rejected" && reason.trim().length < 3)
  )
    throw new Error("reason");
  if (
    status === "verified" &&
    (!record.declared ||
      !record.document ||
      !record.selfie ||
      !Number.isFinite(Date.parse(record.expires)) ||
      Date.parse(record.expires) + 86400000 <= Date.parse(now))
  )
    throw new Error("incomplete");
  Object.assign(record, {
    status,
    reason: reason.trim(),
    reviewer,
    decided: now,
  });
  return record;
}
export function normalizeManualKyc(state) {
  let changed = false;
  for (const k of state.console.kyc) {
    // Upgrade only the original synthetic provider fixtures, preserving user history.
    if (k.provider === "Persona" && /^kyc-(lin|alex|mia|ethan)$/.test(k.id)) {
      const u = state.console.users.find((u) => u.id === k.user);
      Object.assign(k, {
        provider: "manual",
        legalName: u?.name || "Demo Creator",
        country: "Malaysia",
        kind: "passport",
        last4: "2048",
        expires: "2030-12-31",
        document: { name: "demo-document.png", demo: true },
        selfie: { name: "demo-selfie.png", demo: true },
        reviewer: k.status === "processing" ? "—" : "admin@re0.ai",
      });
      if (k.status === "processing") {
        k.status = "pending";
        if (u) u.kyc = "pending";
      }
      delete k.session;
      changed = true;
    }
    if (expireKycFiles(k)) changed = true;
  }
  return changed;
}

export function createManualKyc(ctx, api) {
  const {
    t,
    I,
    esc,
    uid,
    btn,
    closeModal,
    save,
    render,
    toast,
    go,
  } = ctx;
  const S = ctx.getState;
  const uploads = new Map();
  let draft = {};
  const text = (zh, en) => t(zh, en);
  const current = (user = "me") => S().console.kyc.find((k) => k.user === user);
  const kind = (value) =>
    ({
      passport: text("护照", "Passport"),
      id: text("身份证", "National ID"),
      residence: text("居留证", "Residence permit"),
    })[value] || "—";
  const statusText = (status) =>
    ({
      none: text("待提交", "Not submitted"),
      pending: text("待人工审核", "Awaiting review"),
      verified: text("已通过", "Verified"),
      rejected: text("未通过", "Rejected"),
      reset: text("需重新验证", "Reverification required"),
      processing: text("历史验证进行中", "Legacy verification in progress"),
    })[status] || status;
  const stamp = (value) =>
    !value || value === "—"
      ? "—"
      : new Date(value).toLocaleDateString(
          S().lang === "zh" ? "zh-CN" : "en-GB",
        );
  const error = (form, message) => {
    form.querySelector(".form-error")?.remove();
    form.insertAdjacentHTML(
      "beforeend",
      `<p class="form-error" role="alert">${esc(message)}</p>`,
    );
  };
  function userCard() {
    const k = current(),
      status = S().kyc,
      verified = status === "verified",
      pending = status === "pending";
    const active = S().payouts.find(activePayout);
    const hold =
      S().paypalChanged && Date.now() - S().paypalChanged < 7 * 86400000;
    const eligible =
      verified && S().paypal && S().earnedCredits >= 500000 && !active && !hold;
    const detail = verified
      ? text(
          "人工审核已通过 · 税务声明已提交",
          "Manually verified · Tax declaration submitted",
        )
      : pending
        ? text(
            "资料已提交，请等待管理员审核。审核完成后会更新结果。",
            "Your submission is awaiting manual review. The result will appear here.",
          )
        : status === "rejected"
          ? text(
              "请按审核意见补充资料后重新提交。",
              "Update your documents based on the review feedback and resubmit.",
            )
          : text(
              "提交身份资料和税务声明，由平台管理员人工审核。",
              "Submit identity documents and a tax declaration for manual review.",
            );
    const action = pending
      ? btn(text("查看提交资料", "View submission"), "kyc", "secondary sm")
      : verified
        ? `<span class="tag green">${I("check")}${text("已验证", "Verified")}</span>`
        : btn(
            status === "rejected" || status === "reset"
              ? text("重新提交", "Resubmit")
              : text("提交身份资料", "Submit identity details"),
            "kyc",
            "secondary sm",
          );
    let blocked = active
      ? text(
          "已有进行中的提现，完成后可再次申请。",
          "A payout is in progress. Wait for it to finish before requesting another.",
        )
      : hold
        ? text(
            "收款邮箱更换后有 7 天保护期，期间暂不能提现。",
            "Payouts are paused for 7 days after changing your payout email.",
          )
        : verified && !S().paypal
          ? text(
              "请先绑定 PayPal 个人账户邮箱。",
              "Connect your personal PayPal account email first.",
            )
          : verified && S().earnedCredits < 500000
            ? text(
                "收入达到 500,000 credits（$50）后可申请。",
                "You can request a payout once earnings reach 500,000 credits ($50).",
              )
            : "";
    return `<div class="billing-payout"><section class="card settings-card earnings-card"><div class="between"><h2>${text("收入提现", "Withdraw earnings")}</h2><span class="tag blue">${text("人工审核与打款", "Manual review & payment")}</span></div><p class="muted">${text("仅收入 credits 可提现，最低 500,000 credits（$50）。", "Only earned credits can be withdrawn. Minimum: 500,000 credits ($50).")}</p><div class="kyc-step"><span class="step-circle ${verified ? "done" : ""}">${verified ? I("check") : "1"}</span><div class="grow"><strong>${text("身份验证与税务声明", "Identity & tax declaration")}</strong><p>${detail}</p></div>${action}</div>${k?.reason && ["rejected", "reset"].includes(status) ? `<div class="kyc-feedback" role="status"><strong>${text("审核意见", "Review feedback")}</strong><p>${esc(k.reason)}</p></div>` : ""}${k && ["pending", "verified"].includes(status) ? `<div class="kyc-record-meta">${esc(k.legalName || S().displayName)} · ${esc(k.country || "—")} · ${kind(k.kind)}<br>${text("提交于", "Submitted")} ${stamp(k.submitted)}${verified ? ` · ${text("审核于", "Reviewed")} ${stamp(k.decided)}` : ""}</div>` : ""}<div class="kyc-step"><span class="step-circle ${S().paypal ? "done" : ""}">${S().paypal ? I("check") : "2"}</span><div class="grow"><strong>${text("PayPal 个人账户邮箱", "Personal PayPal email")}</strong><p>${S().paypal ? esc(S().paypal) : text("身份验证通过后填写，平台人工转账。", "Connect after verification. Payments are sent manually.")}</p></div>${btn(S().paypal ? text("更换", "Change") : text("绑定", "Connect"), "paypal", "secondary sm", verified ? "" : "disabled")}</div><div class="kyc-privacy">${I("shield")}<span>${text("资料仅用于身份与提现审核，仅管理员可限时查看，每次查看均留审计。审核通过 30 天后删除证件照与自拍原图。", "Documents are used only for identity and payout review. Admin access is time-limited and audited. Original images are deleted 30 days after approval.")}</span></div><div class="rule"></div><div class="between"><span class="small muted">${text("可提现收入", "Available earnings")}<br><strong class="mono earnings-amount">$${(S().earnedCredits / 10000).toFixed(2)}</strong></span>${btn(verified ? text("申请提现", "Request payout") : pending ? text("身份审核中", "Identity review pending") : text("完成身份验证", "Verify identity"), verified ? "payout" : "kyc", "", verified ? (eligible ? "" : "disabled") : pending ? "disabled" : "")}</div>${blocked ? `<p class="kyc-feedback small">${blocked}</p>` : ""}<p class="tiny muted mt16">${text("申请 → 冻结收入 → 审核 → 人工 PayPal 转账 → 登记结果。手续费由提现人承担；同一时间只能有一笔进行中的提现。", "Request → hold earnings → review → manual PayPal transfer → record result. Fees are borne by the recipient. Only one active payout is allowed.")}</p></section><section class="card settings-card earnings-card"><h2>${text("提现记录", "Payout history")}</h2>${
      S().payouts.length
        ? S()
            .payouts.map(
              (p) =>
                `<div class="settings-row"><div><h3 class="mono">$${(p.credits / 10000).toFixed(2)}</h3><p>${esc(p.email)}</p>${p.note ? `<p>${esc(p.note)}</p>` : ""}${p.status === "paid" ? `<p>${text("实付", "Net paid")} $${Number(p.actual ?? p.credits / 10000 - (p.fee || 0)).toFixed(2)} · ${text("手续费", "Fee")} $${Number(p.fee || 0).toFixed(2)}<br>${text("转账 ID", "Transfer ID")}: ${esc(p.transferId || p.batch || "—")}</p>` : ""}</div><span class="tag ${["failed", "rejected"].includes(p.status) ? "red" : p.status === "paid" ? "green" : "orange"}">${{ pending: text("待审核", "Pending review"), approved: text("待人工打款", "Awaiting manual payment"), paid: text("已打款 · 演示", "Paid · Demo"), failed: text("打款失败 · 已退回", "Failed · Released"), rejected: text("已驳回 · 已退回", "Rejected · Released") }[p.status]}</span></div>`,
            )
            .join("")
        : `<div class="empty" style="padding:45px 10px">${I("wallet")}<h3>${text("暂时还没有提现记录", "No payouts yet")}</h3><p>${text("完成身份审核后，即可申请收入提现。", "Request an earnings payout after identity verification.")}</p></div>`
    }</section></div>`;
  }
  function uploadField(slot, label, hint) {
    const submitted = ["pending", "verified"].includes(S().kyc)
      ? current()?.[slot]
      : null;
    const deleted =
      current()?.filesDeletedAt && ["pending", "verified"].includes(S().kyc);
    return `<div class="field"><label for="kyc-${slot}">${label}</label><label class="kyc-upload" for="kyc-${slot}">${I(slot === "document" ? "file" : "users")}<strong>${deleted ? text("原图已删除", "Originals deleted") : submitted ? text("已提交", "Submitted") : text("选择图片", "Choose image")}</strong><span data-kyc-file="${slot}">${deleted ? text("审核通过已满 30 天", "30 days since approval") : submitted ? esc(submitted.name) : hint}</span><input type="file" id="kyc-${slot}" data-kyc-upload="${slot}" accept="image/jpeg,image/png,image/webp"></label></div>`;
  }
  function userPage() {
    draft = {};
    const k = current(),
      locked = ["pending", "verified"].includes(S().kyc);
    const heading = locked
      ? text("已提交的身份资料", "Submitted identity details")
      : text("提交身份资料", "Submit identity details");
    const intro = locked
      ? text(
          "资料已提交，当前结果会同步至余额与计费页面。",
          "Your submission and its status are also available in billing.",
        )
      : text(
          "完成以下三部分资料，由平台管理员人工审核。",
          "Complete the three sections below for manual administrator review.",
        );
    return `<div class="page kyc-page"><div class="kyc-page-intro"><div><h1>${heading}</h1><p>${intro}</p></div>${locked ? `<span class="tag ${S().kyc === "verified" ? "green" : "orange"}">${statusText(S().kyc)}</span>` : btn(I("sparkle") + text("填入演示资料与图片", "Fill sample details & images"), "kyc-sample", "secondary sm")}</div><div class="kyc-page-layout"><form id="manual-kyc-form" class="kyc-page-form"><fieldset class="kyc-page-fields" ${locked ? "disabled" : ""}><section class="card kyc-form-section"><div class="kyc-section-title"><span>01</span><div><h2>${text("基本身份信息", "Identity details")}</h2><p>${text("请填写与证件一致的信息。", "Use the details shown on your identity document.")}</p></div></div><div class="two-col"><div class="field"><label for="kyc-name">${text("法定姓名", "Legal name")}</label><input id="kyc-name" name="legalName" required maxlength="100" autocomplete="off" value="${esc(k?.legalName || "")}" placeholder="${text("与证件上的姓名一致", "As shown on your document")}"></div><div class="field"><label for="kyc-country">${text("国家 / 地区", "Country / region")}</label><input id="kyc-country" name="country" required maxlength="80" value="${esc(k?.country || "")}" placeholder="${text("证件签发国家 / 地区", "Document issuing country / region")}"></div></div><div class="two-col"><div class="field"><label for="kyc-kind">${text("证件类型", "Document type")}</label><select id="kyc-kind" name="kind"><option value="passport" ${k?.kind === "passport" ? "selected" : ""}>${kind("passport")}</option><option value="id" ${k?.kind === "id" ? "selected" : ""}>${kind("id")}</option><option value="residence" ${k?.kind === "residence" ? "selected" : ""}>${kind("residence")}</option></select></div><div class="field"><label for="kyc-last4">${text("证件号码后四位", "Last four document characters")}</label><input id="kyc-last4" name="last4" required pattern="[A-Za-z0-9]{4}" minlength="4" maxlength="4" placeholder="2048" value="${esc(k?.last4 || "")}"></div></div><div class="field"><label for="kyc-expires">${text("证件有效期至", "Document expiration date")}</label><input type="date" id="kyc-expires" name="expires" value="${esc(k?.expires || "")}" required min="${new Date().toISOString().slice(0, 10)}"></div></section><section class="card kyc-form-section"><div class="kyc-section-title"><span>02</span><div><h2>${text("身份证明材料", "Identity documents")}</h2><p>${text("请确保照片清晰、完整，信息无遮挡。", "Make sure both photos are clear, complete and unobstructed.")}</p></div></div><div class="two-col">${uploadField("document", text("证件照片", "Identity document photo"), text("清晰展示姓名、照片和有效期", "Show name, portrait and expiry clearly"))}${uploadField("selfie", text("手持证件自拍", "Selfie holding your document"), text("面部与手持证件应清晰可见", "Your face and held document must be visible"))}</div><p class="form-hint">JPG / PNG / WebP · ${text("每张最大 10 MB", "Up to 10 MB each")}</p></section><section class="card kyc-form-section"><div class="kyc-section-title"><span>03</span><div><h2>${text("税务声明", "Tax declaration")}</h2><p>${text("选择适用的税务表单并确认已提交。", "Choose your tax form and confirm it has been submitted.")}</p></div></div><div class="field"><label for="kyc-tax">${text("税务表单类型", "Tax form type")}</label><select id="kyc-tax" name="tax"><option value="W-8BEN" ${(k?.tax || S().tax) === "W-8BEN" ? "selected" : ""}>W-8BEN · ${text("非美国个人", "Non-US individual")}</option><option value="W-9" ${(k?.tax || S().tax) === "W-9" ? "selected" : ""}>W-9 · ${text("美国纳税人", "US taxpayer")}</option></select></div><label class="check-row small"><input type="checkbox" name="declared" required ${locked && k?.declared ? "checked" : ""}>${text("我声明已提交所选税务表单。", "I declare that I have submitted the selected tax form.")}</label><label class="check-row small mt16"><input type="checkbox" name="consent" required ${locked ? "checked" : ""}>${text("我了解资料仅用于身份与提现审核；仅管理员可限时查看，每次查看记审计，通过后 30 天删除原图。", "I understand the purpose, audited time-limited admin access, and deletion of original images 30 days after approval.")}</label></section></fieldset>${locked ? "" : `<div class="kyc-page-actions"><a href="#/settings?tab=billing" class="btn secondary">${text("取消", "Cancel")}</a><button type="submit" class="btn">${text("提交人工审核", "Submit for manual review")}${I("arrow")}</button></div>`}</form><aside class="kyc-page-guide"><section class="card kyc-guide-card"><span class="kyc-guide-icon">${I("shield")}</span><h2>${locked ? statusText(S().kyc) : text("提交后会怎样？", "What happens next?")}</h2><ol><li>${text("提交身份资料与税务声明", "Submit identity details and tax declaration")}</li><li>${text("管理员人工审核并更新结果", "An administrator reviews your submission")}</li><li>${text("通过后绑定 PayPal 邮箱，申请提现", "After approval, connect PayPal and request a payout")}</li></ol>${locked ? `<p class="form-hint">${text("已提交资料暂不可编辑。", "Submitted details cannot be edited.")}<br>${text("提交时间", "Submitted")}: ${stamp(k?.submitted)}</p>` : ""}${k?.reason && ["rejected", "reset"].includes(S().kyc) ? `<div class="kyc-feedback"><strong>${text("审核意见", "Review feedback")}</strong><p>${esc(k.reason)}</p></div>` : ""}</section><section class="kyc-guide-note"><h3>${text("你的资料如何保护", "How your documents are protected")}</h3><p>${text("仅用于身份与提现审核。仅管理员可限时查看，每次查看都会记录审计。审核通过 30 天后删除原图。", "Used only for identity and payout review. Admin access is time-limited and audited. Originals are deleted 30 days after approval.")}</p><p class="form-hint">${text("本地原型请使用演示材料。选择的图片仅留在当前页面内存，不上传或保存。", "Use sample materials in this local prototype. Selected images stay in page memory and are never uploaded or persisted.")}</p></section></aside></div></div>`;
  }
  function table(rows) {
    return api.table(
      [
        text("用户", "User"),
        text("法定姓名 / 国家", "Legal name / country"),
        text("证件 / 状态", "Document / status"),
        text("税务声明", "Tax declaration"),
        text("提交 / 审核", "Submitted / reviewed"),
        text("操作", "Actions"),
      ],
      rows.map((k) => [
        api.userLink(api.user(k.user)),
        `${esc(k.legalName || "—")}<small class="cell-subline">${esc(k.country || "—")}</small>`,
        `${api.tag(k.status)}<small class="cell-subline">${kind(k.kind)} ${k.last4 ? "•••• " + esc(k.last4) : ""}</small>${k.filesDeletedAt ? `<small class="cell-subline">${text("原图已删除", "Originals deleted")}</small>` : ""}`,
        `${esc(k.tax)}<small class="cell-subline">${k.declared ? text("已声明提交", "Declared submitted") : text("未提交", "Not submitted")}</small>`,
        `${stamp(k.submitted)}<small class="cell-subline">${stamp(k.decided)} · ${esc(k.reviewer || "—")}</small>`,
        `<div class="flex">${btn(k.status === "pending" ? text("审核资料", "Review submission") : text("查看记录", "View record"), "kyc-details", "secondary sm", `data-id="${k.id}"`)}${btn(text("要求重新验证", "Require recheck"), "reset-kyc", "ghost sm", `data-id="${k.id}"`)}</div>`,
      ]),
    );
  }
  function page(rows) {
    return `${api.sectionHead(text("KYC 记录", "Identity verification"), text("平台人工审核身份与税务声明。证件限时查看、逐次审计，通过后 30 天删除原图。", "Manual identity and tax review. Image access is time-limited and audited; originals are deleted 30 days after approval."))}<section class="card">${api.filterBar("kyc", ["none", "pending", "verified", "rejected", "reset"])}${table(
      api.filtered(
        "kyc",
        rows.map((k) => ({
          ...k,
          created: k.submitted,
          name: [api.user(k.user)?.name, k.legalName, k.country].join(" "),
          email: api.user(k.user)?.email,
        })),
      ),
    )}</section>`;
  }
  let previewTimer = null;
  function reviewPage(id) {
    const k = S().admin && S().console.kyc.find((k) => k.id === id);
    if (!k) return null;
    const latest = current(k.user)?.id === k.id,
      applicant = api.user(k.user);
    const facts = [
      [text("法定姓名", "Legal name"), k.legalName],
      [text("国家 / 地区", "Country / region"), k.country],
      [text("证件类型", "Document type"), kind(k.kind)],
      [
        text("号码后四位", "Last four characters"),
        k.last4 ? "•••• " + k.last4 : "—",
      ],
      [text("有效期至", "Expires on"), k.expires],
    ];
    return `<div class="kyc-review-page" data-record="${esc(k.id)}"><div class="kyc-page-intro"><div><h1>${text("人工身份审核", "Manual identity review")}</h1><p>${esc(applicant?.name || "—")} · ${esc(applicant?.email || "—")}</p></div>${api.tag(k.status)}</div><section class="card kyc-review-facts">${facts.map(([label, value]) => `<div><span>${label}</span><strong>${esc(value || "—")}</strong></div>`).join("")}</section><section class="kyc-comparison-section"><div class="between kyc-comparison-heading"><div><h2>${text("证件与本人核对", "Compare document and holder")}</h2><p id="kyc-preview-notice" role="status">${text("限时预览，每次查看均记录审计。", "Time-limited previews. Each view is audited.")}</p></div>${!k.filesDeletedAt && (k.document || k.selfie) ? btn(I("refresh") + text("重新获取预览", "Renew previews"), "kyc-refresh-previews", "secondary sm", `data-id="${k.id}"`) : ""}</div><div class="kyc-comparison-grid">${["document", "selfie"].map((slot) => `<article class="card kyc-preview-panel"><div class="kyc-preview-title"><span>${I(slot === "document" ? "file" : "users")}${slot === "document" ? text("证件照片", "Identity document") : text("手持证件自拍", "Selfie holding document")}</span><small>${slot === "document" ? text("核对姓名、号码与有效期", "Check name, number and expiry") : text("核对本人面部与手持证件", "Compare face and held document")}</small></div><div class="kyc-preview-stage" id="kyc-preview-${slot}"><p>${text("准备预览…", "Preparing preview…")}</p></div><p class="kyc-preview-caption">${text("仅供本次身份审核使用", "For this identity review only")}</p></article>`).join("")}</div></section><div class="kyc-review-bottom"><section class="card kyc-review-history"><h2>${text("提交与审核记录", "Submission and review")}</h2><div class="review-checklist">${[
      [text("税务表单", "Tax form"), k.tax],
      [
        text("税务声明", "Tax declaration"),
        k.declared
          ? text("已声明提交", "Declared submitted")
          : text("未提交", "Not submitted"),
      ],
      [text("提交时间", "Submitted"), stamp(k.submitted)],
      [text("审核人", "Reviewer"), k.reviewer],
      [text("审核时间", "Reviewed"), stamp(k.decided)],
    ]
      .map(
        ([label, value]) =>
          `<div><span>${label}</span><strong>${esc(value || "—")}</strong></div>`,
      )
      .join(
        "",
      )}</div><p class="form-hint mt16">${text("仅管理员可限时查看资料，每次查看记审计。通过审核 30 天后删除原图，保留必要证件信息和审核记录。", "Admin access is time-limited and audited. Originals are deleted 30 days after approval; required metadata and review history remain.")}</p></section><section class="card kyc-review-history"><h2>${latest && k.status === "pending" ? text("审核决定", "Review decision") : text("审核结果", "Review result")}</h2>${k.reason ? `<div class="kyc-feedback">${esc(k.reason)}</div>` : ""}${latest && k.status === "pending" ? `<form id="manual-kyc-review" data-id="${k.id}" class="kyc-review-decision"><label class="check-row small"><input type="checkbox" name="matched">${text("已比对证件照与自拍，确认姓名、有效期及税务声明。", "I have compared the document and selfie and checked the name, expiry and tax declaration.")}</label><div class="field mt16"><label for="kyc-reason">${text("审核意见（拒绝必填）", "Review note (required for rejection)")}</label><textarea id="kyc-reason" name="reason" rows="2" maxlength="300"></textarea></div><div class="flex"><button class="btn secondary" type="submit" name="decision" value="rejected">${text("拒绝并说明原因", "Reject with reason")}</button><button class="btn" type="submit" name="decision" value="verified">${text("通过审核", "Approve verification")}</button></div></form>` : `<p class="muted small">${latest ? text("此记录已完成处理，审核结果已同步至用户账户。", "This record has been processed and the result is available in the user account.") : text("这是历史记录，用户已有更新的验证记录。", "This is a historical record. The user has a newer verification record.")}</p>${btn(text("要求重新验证", "Require recheck"), "reset-kyc", "secondary sm mt16", `data-id="${k.id}"`)}`}</section></div></div>`;
  }
  function refreshPreviews(id) {
    clearTimeout(previewTimer);
    const root = document.querySelector(".kyc-review-page");
    const k = S().admin && S().console.kyc.find((k) => k.id === id);
    if (!k || root?.dataset.record !== id) return;
    const expiry = new Date(Date.now() + 60000).toISOString();
    for (const slot of ["document", "selfie"]) {
      const stage = root.querySelector("#kyc-preview-" + slot);
      if (k.filesDeletedAt || !k[slot]) {
        stage.innerHTML = `<div class="kyc-preview-empty">${I("shield")}<strong>${k.filesDeletedAt ? text("原图已删除", "Original deleted") : text("未提供图片", "No image submitted")}</strong><p>${k.filesDeletedAt ? text("通过审核已满 30 天，原图不再可访问。", "The original was deleted 30 days after approval.") : text("此记录没有可预览的材料。", "This record has no image available for preview.")}</p></div>`;
        continue;
      }
      api.audit("kyc.files.view", k.id, null, {
        file: slot,
        expiresAt: expiry,
      });
      const local = uploads.get(k.id)?.[slot];
      stage.innerHTML = local
        ? `<img class="kyc-local-image" src="${local}" alt="${slot === "document" ? text("证件照预览", "Identity document preview") : text("手持证件自拍预览", "Selfie holding document preview")}">`
        : `<div class="kyc-demo-document ${slot === "selfie" ? "kyc-demo-selfie" : ""}">${I(slot === "document" ? "file" : "users")}<small>DEMO / ${slot.toUpperCase()}</small><strong>${esc(k.legalName || "Demo Creator")}</strong><span>${kind(k.kind)} · •••• ${esc(k.last4 || "—")}</span>${slot === "document" ? `<span>${text("有效期至", "Expires")} ${esc(k.expires || "—")}</span>` : ""}<p>${text("演示占位图，不含真实身份资料。", "Sample placeholder with no real identity data.")}${k[slot].local ? text("本地图片已随刷新释放。", "The selected local image was released on refresh.") : ""}</p></div>`;
    }
    const hasFiles = !k.filesDeletedAt && (k.document || k.selfie);
    root.querySelector("#kyc-preview-notice").textContent = hasFiles
      ? text(
          "本次查看已记录审计 · 两张预览将在 60 秒后失效",
          "Views logged · Both previews expire in 60 seconds",
        )
      : text(
          "仅保留资料元数据和审核记录。",
          "Only document metadata and review history remain.",
        );
    if (hasFiles)
      previewTimer = setTimeout(() => {
        if (root.isConnected) {
          root.querySelectorAll(".kyc-preview-stage").forEach((el) => {
            el.innerHTML = `<div class="kyc-preview-empty">${I("clock")}<strong>${text("预览已失效", "Preview expired")}</strong><p>${text("点击“重新获取预览”继续核对。", "Renew the previews to continue comparing.")}</p></div>`;
          });
          root.querySelector("#kyc-preview-notice").textContent = text(
            "预览已失效，重新获取会再次记录审计。",
            "Previews expired. Renewing them creates new audit entries.",
          );
        }
      }, 60000);
  }
  function afterRender() {
    clearTimeout(previewTimer);
    const id = document.querySelector(".kyc-review-page")?.dataset.record;
    if (id) refreshPreviews(id);
  }
  async function onAction(a, d) {
    if (a === "kyc") {
      go("/settings/identity");
      return true;
    }
    if (a === "kyc-sample") {
      for (const [id, value] of Object.entries({
        "kyc-name": "Demo Creator",
        "kyc-country": "Malaysia",
        "kyc-last4": "2048",
        "kyc-expires": "2030-12-31",
      }))
        document.getElementById(id).value = value;
      for (const slot of ["document", "selfie"]) {
        draft[slot] = { name: `demo-${slot}.png`, demo: true };
        document.querySelector(`[data-kyc-file="${slot}"]`).textContent = text(
          "演示图片已就绪",
          "Sample image ready",
        );
      }
      return true;
    }
    if (!["kyc-details", "kyc-refresh-previews"].includes(a)) return false;
    if (!S().admin) {
      go("/admin/login");
      return true;
    }
    const k = S().console.kyc.find((k) => k.id === d.id);
    if (!k) {
      toast(text("该用户尚未提交资料", "No submission yet"));
      return true;
    }
    if (a === "kyc-details") go("/admin/kyc/" + encodeURIComponent(k.id));
    else refreshPreviews(k.id);
    return true;
  }

  async function onSubmit(form, f, event) {
    if (form.id === "manual-kyc-form") {
      const values = Object.fromEntries(f);
      if (S().kyc === "pending" || S().kyc === "verified") {
        error(
          form,
          text(
            "当前状态不能重复提交。",
            "A new submission is not allowed in the current state.",
          ),
        );
        return true;
      }
      if (
        !values.legalName?.trim() ||
        !values.country?.trim() ||
        !/^[A-Za-z0-9]{4}$/.test(values.last4 || "") ||
        !values.expires ||
        Date.parse(values.expires) + 86400000 < Date.now() ||
        !["passport", "id", "residence"].includes(values.kind) ||
        !["W-8BEN", "W-9"].includes(values.tax) ||
        !f.has("declared") ||
        !f.has("consent") ||
        !draft.document ||
        !draft.selfie
      ) {
        error(
          form,
          text(
            "请补全有效的身份资料、两张图片和声明。",
            "Complete all valid details, both images and declarations.",
          ),
        );
        return true;
      }
      const k = {
        id: uid(),
        user: "me",
        provider: "manual",
        status: "pending",
        legalName: values.legalName.trim(),
        country: values.country.trim(),
        kind: values.kind,
        last4: values.last4,
        expires: values.expires,
        tax: values.tax,
        declared: true,
        declaredAt: new Date().toISOString(),
        submitted: new Date().toISOString(),
        decided: null,
        reason: "",
        document: draft.document,
        selfie: draft.selfie,
      };
      uploads.set(k.id, {
        document: draft.document.url,
        selfie: draft.selfie.url,
      });
      delete k.document.url;
      delete k.selfie.url;
      S().console.kyc.unshift(k);
      S().kyc = "pending";
      S().tax = k.tax;
      save();
      closeModal();
      render();
      toast(
        text(
          "资料已提交，等待管理员人工审核。",
          "Submitted for manual administrator review.",
        ),
      );
      return true;
    }
    if (form.id !== "manual-kyc-review") return false;
    if (!S().admin) {
      go("/admin/login");
      return true;
    }
    const status = event?.submitter?.value || f.get("decision");
    if (
      status === "rejected" &&
      String(f.get("reason") || "").trim().length < 3
    ) {
      error(
        form,
        text(
          "拒绝审核请填写至少 3 个字符的原因。",
          "Enter a rejection reason of at least 3 characters.",
        ),
      );
      return true;
    }
    if (status === "verified" && !f.has("matched")) {
      error(
        form,
        text(
          "请先比对资料并勾选审核确认。",
          "Compare the documents and confirm the review first.",
        ),
      );
      return true;
    }
    let k;
    try {
      k = decideKyc(
        S().console.kyc,
        form.dataset.id,
        status,
        String(f.get("reason") || ""),
        S().console.adminEmail,
      );
    } catch {
      error(
        form,
        text(
          "请检查拒绝原因、证件有效期与税务声明；仅可审核最新的待审核记录。",
          "Check rejection reason, expiry and tax declaration. Only the latest pending submission can be reviewed.",
        ),
      );
      return true;
    }
    if (k.user === "me") S().kyc = k.status;
    else {
      const u = S().console.users.find((u) => u.id === k.user);
      if (u) {
        u.kyc = k.status;
        u.tax = k.tax;
      }
    }
    api.notice(
      status === "verified"
        ? text(
            "身份审核已通过，可以绑定收款邮箱。",
            "Verification approved. You can connect your payout email.",
          )
        : text("身份审核未通过：", "Verification rejected: ") + k.reason,
      k.user,
    );
    api.audit("kyc." + status, k.id, "pending", { status, reason: k.reason });
    save();
    closeModal();
    render();
    toast(text("人工审核结果已保存", "Manual review saved"));
    return true;
  }
  document.addEventListener("change", (e) => {
    const slot = e.target.dataset?.kycUpload;
    if (!slot) return;
    const file = e.target.files?.[0];
    if (!file) return;
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size > 10 * 1024 * 1024
    ) {
      e.target.value = "";
      toast(
        text(
          "请选择不超过 10 MB 的 JPG、PNG 或 WebP 图片。",
          "Choose a JPG, PNG or WebP image under 10 MB.",
        ),
      );
      return;
    }
    if (draft[slot]?.url) URL.revokeObjectURL(draft[slot].url);
    draft[slot] = {
      name: file.name,
      local: true,
      url: URL.createObjectURL(file),
    };
    document.querySelector(`[data-kyc-file="${slot}"]`).textContent = file.name;
  });
  return {
    userCard,
    userPage,
    table,
    page,
    reviewPage,
    afterRender,
    onAction,
    onSubmit,
  };
}
