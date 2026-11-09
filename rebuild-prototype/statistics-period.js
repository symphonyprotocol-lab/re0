import {
  reportingDate,
  statisticsPeriod,
  statisticsSelection,
} from "./statistics-time.js";

const calendarIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18"/></svg>';
export function createStatisticsPeriodControls({ t, esc }) {
  const name = (period) =>
    ({
      all: t("全部时间", "All time"),
      day: t("天", "Day"),
      week: t("周", "Week"),
      month: t("月", "Month"),
      custom: t("自定义", "Custom"),
    })[period];
  function selectionLabel(period, date, end) {
    if (period === "custom") return `${date} — ${end}`;
    if (period === "week") {
      const range = statisticsPeriod("week", date);
      return `${reportingDate(new Date(range.start))} — ${reportingDate(new Date(range.end - 1))}`;
    }
    return period === "month"
      ? t(
          `${date.slice(0, 4)} 年 ${Number(date.slice(5, 7))} 月`,
          date.slice(0, 7),
        )
      : date;
  }
  function render(f, url, { id, attributes = "", fields = {} }) {
    const active = f.period !== "all",
      custom = f.period === "custom";
    const label = {
      day: t("选择日期", "Select date"),
      week: t("选择周", "Select week"),
      month: t("选择月份", "Select month"),
      custom: t("选择时间范围", "Select date range"),
    }[f.period];
    const hidden = (key, value) =>
      `<input type="hidden" name="${key}" value="${esc(value)}">`;
    const value = active
      ? selectionLabel(f.period, custom ? f.start : f.date, f.end)
      : "";
    const selection = custom
      ? hidden("start", f.start) + hidden("end", f.end)
      : active
        ? hidden("selection", statisticsSelection(f.period, f.date))
        : "";
    const quick =
      custom || !active
        ? ""
        : `<a class="text-link" href="#${esc(url({ date: reportingDate(), page: 1 }))}">${f.period === "day" ? t("今天", "Today") : f.period === "week" ? t("本周", "This week") : t("本月", "This month")}</a>`;
    return `<section class="statistics-period" aria-label="${t("统计时间", "Reporting period")}"><div class="statistics-period-top"><nav class="statistics-period-tabs" aria-label="${t("时间维度", "Time dimension")}">${["all", "day", "week", "month", "custom"].map((period) => `<a href="#${esc(url({ period, page: 1 }))}" ${f.period === period ? 'aria-current="true"' : ""}>${name(period)}</a>`).join("")}</nav>${
      active
        ? `<form id="${id}" class="statistics-period-form" ${attributes}>${hidden("period", f.period)}${Object.entries(
            fields,
          )
            .map(([key, value]) => hidden(key, value))
            .join(
              "",
            )}${selection}<div class="statistics-date-control" data-period="${f.period}" data-date="${custom ? f.start : f.date}" ${custom ? `data-start="${f.start}" data-end="${f.end}"` : ""}><span>${label}</span><button type="button" class="statistics-date-trigger" data-action="statistics-calendar-toggle" aria-label="${label}：${esc(value)}" aria-haspopup="dialog" aria-expanded="false"><span>${esc(value)}</span>${calendarIcon}</button><div class="statistics-calendar" role="dialog" aria-label="${label}" hidden></div></div>${quick}</form>`
        : ""
    }</div><p class="statistics-timezone">UTC+8 · ${t("周一为每周起点", "Weeks start on Monday")}</p></section>`;
  }
  return { render, name };
}
