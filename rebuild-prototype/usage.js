// Monthly Plan usage is separate from non-expiring Pack and earned balances.
export const MONTHLY_PLAN_CREDITS = 100000;
const amount = (value) =>
  Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
export function creditUsage(state) {
  const active = !!state.plan;
  const allowance = active ? MONTHLY_PLAN_CREDITS : 0;
  const remaining = active ? amount(state.planCredits) : 0;
  const used = active ? Math.max(0, allowance - remaining) : 0;
  return {
    active,
    cancelled: active && !!state.cancelled,
    allowance,
    remaining,
    used,
    percent: allowance
      ? Math.min(100, Math.round((used / allowance) * 10000) / 100)
      : 0,
    total: [
      "planCredits",
      "packCredits",
      "earnedCredits",
      "welcomeCredits",
    ].reduce((sum, key) => sum + amount(state[key]), 0),
  };
}
export function createUsage(ctx) {
  const { t, I, n, esc } = ctx;
  function sidebar() {
    const usage = creditUsage(ctx.getState());
    const membership = usage.active
      ? t("Plan 会员", "Plan member")
      : t("免费账户", "Free account");
    const status = usage.active
      ? usage.cancelled
        ? t("到期不续费", "Ends this cycle")
        : t("生效中", "Active")
      : t("开通 Plan", "Get Plan");
    const summary = usage.active
      ? t(
          `本期已用 ${n(usage.used)}，月度额度 ${n(usage.allowance)} credits，剩余 ${n(usage.remaining)}`,
          `Used ${n(usage.used)} of ${n(usage.allowance)} monthly credits; ${n(usage.remaining)} remaining`,
        )
      : t(
          `未订阅月度 Plan，可用余额 ${n(usage.total)} credits`,
          `No monthly Plan; ${n(usage.total)} credits available`,
        );
    return `<a class="sidebar-usage ${usage.active ? "is-member" : "is-free"} ${usage.percent >= 90 ? "is-low" : ""}" href="#/settings?tab=billing" aria-label="${esc(membership + " · " + status + " · " + summary)}" title="${esc(membership + " · " + status + "\n" + summary)}"><span class="sidebar-usage-icon">${I("sparkle")}</span><div class="sidebar-usage-head"><strong>${membership}</strong><span class="${usage.cancelled ? "ending" : ""}">${status}</span></div>${usage.active ? `<div class="sidebar-usage-label">${t("本期已用 / 月度额度", "Used / monthly allowance")}<small>credits</small></div><div class="sidebar-usage-amount"><small>${t("已用", "Used")}</small><strong>${n(usage.used)}</strong><span>/ ${n(usage.allowance)}</span></div><div class="sidebar-usage-meter" role="meter" aria-label="${t("Plan 当期额度使用情况", "Current Plan credit usage")}" aria-valuemin="0" aria-valuemax="${usage.allowance}" aria-valuenow="${usage.used}" aria-valuetext="${esc(summary)}"><i style="width:${usage.percent}%"></i></div><div class="sidebar-usage-foot"><span>${t("剩余", "Remaining")} ${n(usage.remaining)}</span>${I("arrow")}</div>` : `<div class="sidebar-usage-label">${t("可用余额", "Available balance")}<small>credits</small></div><div class="sidebar-usage-amount"><small>${t("余额", "Balance")}</small><strong>${n(usage.total)}</strong></div><div class="sidebar-usage-foot"><span>${t("暂无月度额度", "No monthly allowance")}</span>${I("arrow")}</div>`}</a>`;
  }
  return { sidebar };
}
