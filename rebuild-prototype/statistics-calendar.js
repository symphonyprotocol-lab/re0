import {
  reportingDate,
  reportingWeek,
  statisticsPeriod,
  statisticsSelection,
  validReportDate,
  recentStatisticsRange,
} from "./statistics-time.js";

const DAY = 86400000;
export function calendarWeeks(cursor) {
  const first = cursor.slice(0, 7) + "-01";
  const last = new Date(first + "T00:00:00Z");
  last.setUTCMonth(last.getUTCMonth() + 1);
  last.setUTCDate(0);
  const start = statisticsPeriod("week", first).start;
  const weeks = [];
  for (
    let stamp = start;
    reportingDate(new Date(stamp)) <= last.toISOString().slice(0, 10);
    stamp += 7 * DAY
  ) {
    weeks.push(
      Array.from({ length: 7 }, (_, i) =>
        reportingDate(new Date(stamp + i * DAY)),
      ),
    );
  }
  return weeks;
}
export function calendarSelectionDate(period, date, today = reportingDate()) {
  if (
    !validReportDate(date) ||
    !["day", "week", "month", "custom"].includes(period)
  )
    return null;
  const normalized =
    period === "week"
      ? reportingDate(new Date(statisticsPeriod("week", date).start))
      : period === "month"
        ? date.slice(0, 7) + "-01"
        : date;
  return normalized <= today ? normalized : null;
}
function moveCursor(cursor, period, direction) {
  const date = new Date(cursor.slice(0, 7) + "-01T00:00:00Z");
  if (period === "month")
    date.setUTCFullYear(date.getUTCFullYear() + direction);
  else date.setUTCMonth(date.getUTCMonth() + direction);
  return date.toISOString().slice(0, 10);
}
export function createStatisticsCalendar(ctx) {
  const { t, esc, I } = ctx;
  function close(control, focus = false) {
    if (!control) return;
    control.querySelector(".statistics-calendar").hidden = true;
    const trigger = control.querySelector(".statistics-date-trigger");
    trigger.setAttribute("aria-expanded", "false");
    if (focus) trigger.focus();
  }
  function applyRange(control, start, end) {
    const form = control.closest("form");
    form.querySelector('[name="start"]').value = start;
    form.querySelector('[name="end"]').value = end;
    close(control, true);
    form.requestSubmit();
  }
  function paint(control, cursor) {
    const { period, date } = control.dataset;
    const today = reportingDate();
    const panel = control.querySelector(".statistics-calendar");
    panel.dataset.cursor = cursor;
    const year = Number(cursor.slice(0, 4)),
      month = Number(cursor.slice(5, 7));
    const nowYear = Number(today.slice(0, 4));
    const years = Array.from(
      { length: nowYear - Math.min(2000, year) + 1 },
      (_, i) => Math.min(2000, year) + i,
    ).reverse();
    const monthName = (m) =>
      t(
        `${m} 月`,
        new Intl.DateTimeFormat("en", {
          month: "short",
          timeZone: "UTC",
        }).format(new Date(Date.UTC(2026, m - 1, 1))),
      );
    const select = (name, label, choices, value) =>
      `<select data-calendar-part="${name}" aria-label="${label}">${choices.map(([key, text]) => `<option value="${key}" ${Number(key) === value ? "selected" : ""}>${text}</option>`).join("")}</select>`;
    const previous = moveCursor(cursor, period, -1),
      next = moveCursor(cursor, period, 1);
    const arrow = (target, backwards, disabled = false) =>
      `<button type="button" class="statistics-calendar-nav ${backwards ? "is-previous" : ""}" data-action="statistics-calendar-browse" data-date="${target}" aria-label="${period === "month" ? (backwards ? t("上一年", "Previous year") : t("下一年", "Next year")) : backwards ? t("上个月", "Previous month") : t("下个月", "Next month")}" ${disabled ? "disabled" : ""}>${I("arrow")}</button>`;
    const header = `<div class="statistics-calendar-head">${arrow(previous, true)}<div>${select(
      "year",
      t("日历年份", "Calendar year"),
      years.map((y) => [y, y]),
      year,
    )}${
      period !== "month"
        ? select(
            "month",
            t("日历月份", "Calendar month"),
            Array.from({ length: 12 }, (_, i) => [i + 1, monthName(i + 1)]),
            month,
          )
        : ""
    }</div>${arrow(next, false, period === "month" ? year >= nowYear : next.slice(0, 7) > today.slice(0, 7))}</div>`;
    const selected = (value) =>
      period === "custom"
        ? value === panel.dataset.rangeStart || value === panel.dataset.rangeEnd
        : statisticsSelection(period, value) ===
          statisticsSelection(period, date);
    const attributes = (value, label) =>
      `type="button" data-action="statistics-calendar-select" data-date="${value}" aria-label="${esc(label)}" aria-pressed="${selected(value)}" ${calendarSelectionDate(period, value, today) ? "" : "disabled"}`;
    let body;
    if (period === "month") {
      body = `<div class="statistics-month-grid">${Array.from(
        { length: 12 },
        (_, i) => {
          const value = `${year}-${String(i + 1).padStart(2, "0")}-01`;
          return `<button ${attributes(value, t(`${year} 年 ${i + 1} 月`, `${monthName(i + 1)} ${year}`))}>${monthName(i + 1)}</button>`;
        },
      ).join("")}</div>`;
    } else {
      const weekdays = t(
        ["一", "二", "三", "四", "五", "六", "日"],
        ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"],
      );
      const weeks = calendarWeeks(cursor);
      body = `<div class="statistics-calendar-weekdays ${period === "week" ? "with-weeks" : ""}">${period === "week" ? `<span>${t("周", "Wk")}</span>` : ""}${weekdays.map((day) => `<span>${day}</span>`).join("")}</div>${
        period === "week"
          ? `<div class="statistics-week-grid">${weeks.map((days) => `<button ${attributes(days[0], `${reportingWeek(days[0])} · ${days[0]} — ${days[6]}`)}><small>${Number(reportingWeek(days[0]).slice(6))}</small>${days.map((day) => `<span class="${day.slice(5, 7) !== cursor.slice(5, 7) ? "outside-month" : ""}">${Number(day.slice(8))}</span>`).join("")}</button>`).join("")}</div>`
          : `<div class="statistics-day-grid">${weeks
              .flat()
              .map(
                (day) =>
                  `<button ${attributes(day, day)} class="${day.slice(5, 7) !== cursor.slice(5, 7) ? "outside-month" : ""}" ${period === "custom" && panel.dataset.rangeStart && panel.dataset.rangeEnd && day > panel.dataset.rangeStart && day < panel.dataset.rangeEnd ? 'data-in-range="true"' : ""} ${day === today ? 'aria-current="date"' : ""}>${Number(day.slice(8))}</button>`,
              )
              .join("")}</div>`
      }`;
    }
    const rangeFields =
      period !== "custom"
        ? ""
        : `<div class="statistics-range-fields">${["start", "end"].map((bound) => `<button type="button" data-action="statistics-calendar-range-bound" data-bound="${bound}" aria-pressed="${panel.dataset.phase === bound}"><small>${bound === "start" ? t("开始日期", "Start date") : t("结束日期", "End date")}</small><strong>${panel.dataset[bound === "start" ? "rangeStart" : "rangeEnd"] || t("请选择", "Select date")}</strong></button>`).join("")}</div>`;
    const hint =
      period === "custom"
        ? panel.dataset.phase === "start"
          ? t("请选择开始日期", "Choose the start date")
          : t(
              "请选择结束日期，选完自动更新",
              "Choose the end date to update statistics",
            )
        : period === "week"
          ? t("点击整周，立即更新统计", "Select a week to update statistics")
          : period === "month"
            ? t("点击月份，立即更新统计", "Select a month to update statistics")
            : t("点击日期，立即更新统计", "Select a day to update statistics");
    const presets =
      period !== "custom"
        ? ""
        : `<div class="statistics-range-presets" role="group" aria-label="${t("快捷时间范围", "Quick date ranges")}">${[
            7, 30, 90,
          ]
            .map((days) => {
              const range = recentStatisticsRange(days);
              return `<button type="button" data-action="statistics-calendar-preset" data-days="${days}" aria-pressed="${panel.dataset.rangeStart === range.start && panel.dataset.rangeEnd === range.end}">${t(`最近 ${days} 天`, `Last ${days} days`)}</button>`;
            })
            .join("")}</div>`;
    panel.innerHTML = `${presets}${rangeFields}${header}${body}<p class="statistics-calendar-hint" aria-live="polite">${hint}</p>`;
  }
  async function onAction(action, data, element) {
    if (!action.startsWith("statistics-calendar-")) return false;
    const control = element?.closest(".statistics-date-control");
    if (!control) return true;
    const panel = control.querySelector(".statistics-calendar");
    if (action === "statistics-calendar-toggle") {
      if (!panel.hidden) {
        close(control, true);
        return true;
      }
      document
        .querySelectorAll(".statistics-date-control")
        .forEach((other) => close(other));
      if (control.dataset.period === "custom") {
        panel.dataset.rangeStart = control.dataset.start;
        panel.dataset.rangeEnd = control.dataset.end;
        panel.dataset.phase = "start";
      }
      paint(control, control.dataset.date.slice(0, 7) + "-01");
      panel.hidden = false;
      element.setAttribute("aria-expanded", "true");
      panel
        .querySelector(
          '[aria-pressed="true"]:not(:disabled), [data-action="statistics-calendar-select"]:not(:disabled)',
        )
        ?.focus();
    } else if (action === "statistics-calendar-preset") {
      if (control.dataset.period !== "custom") return true;
      const range = recentStatisticsRange(Number(data.days));
      if (range) applyRange(control, range.start, range.end);
    } else if (action === "statistics-calendar-browse") {
      if (validReportDate(data.date)) {
        const backwards = element.classList.contains("is-previous");
        paint(control, data.date);
        panel
          .querySelector(
            backwards
              ? ".statistics-calendar-nav.is-previous"
              : ".statistics-calendar-nav:not(.is-previous)",
          )
          ?.focus();
      }
    } else if (action === "statistics-calendar-range-bound") {
      panel.dataset.phase = data.bound === "end" ? "end" : "start";
      paint(control, panel.dataset.cursor);
      panel
        .querySelector(
          `[data-action="statistics-calendar-range-bound"][data-bound="${panel.dataset.phase}"]`,
        )
        ?.focus();
    } else if (action === "statistics-calendar-select") {
      const date = calendarSelectionDate(control.dataset.period, data.date);
      if (!date) return true;
      const form = control.closest("form");
      if (control.dataset.period === "custom") {
        if (panel.dataset.phase === "start") {
          panel.dataset.rangeStart = date;
          panel.dataset.rangeEnd = "";
          panel.dataset.phase = "end";
          paint(control, panel.dataset.cursor);
          panel
            .querySelector(
              `[data-action="statistics-calendar-select"][data-date="${date}"]`,
            )
            ?.focus();
          return true;
        }
        const [start, end] = [
          panel.dataset.rangeStart || control.dataset.start,
          date,
        ].sort();
        applyRange(control, start, end);
        return true;
      }
      form.querySelector('[name="selection"]').value = statisticsSelection(
        control.dataset.period,
        date,
      );
      close(control, true);
      form.requestSubmit();
    }
    return true;
  }
  document.addEventListener("change", (event) => {
    const select = event.target.closest("[data-calendar-part]");
    if (!select) return;
    const panel = select.closest(".statistics-calendar");
    const control = panel.closest(".statistics-date-control");
    const year = panel.querySelector('[data-calendar-part="year"]').value;
    const month =
      panel.querySelector('[data-calendar-part="month"]')?.value || "1";
    paint(control, `${year}-${String(month).padStart(2, "0")}-01`);
    panel
      .querySelector(`[data-calendar-part="${select.dataset.calendarPart}"]`)
      ?.focus();
  });
  document.addEventListener("pointerdown", (event) => {
    const control = document.querySelector(
      ".statistics-date-control:has(.statistics-calendar:not([hidden]))",
    );
    if (control && !control.contains(event.target)) close(control);
  });
  document.addEventListener("keydown", (event) => {
    const control = event.target.closest(".statistics-date-control");
    if (!control || control.querySelector(".statistics-calendar").hidden)
      return;
    if (event.key === "Escape") {
      event.preventDefault();
      close(control, true);
      return;
    }
    if (event.key === "Tab") {
      // Focus may leave this non-modal popover; collapse after it has moved outside.
      setTimeout(() => {
        if (!control.contains(document.activeElement)) close(control);
      }, 0);
      return;
    }
    const target = event.target.closest(
      '[data-action="statistics-calendar-select"]',
    );
    if (!target) return;
    const vertical = ["day", "custom"].includes(control.dataset.period)
      ? 7
      : control.dataset.period === "month"
        ? 3
        : 1;
    const delta = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -vertical,
      ArrowDown: vertical,
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    const buttons = [
      ...control.querySelectorAll('[data-action="statistics-calendar-select"]'),
    ];
    const next = buttons[buttons.indexOf(target) + delta];
    if (next && !next.disabled) next.focus();
  });
  return { onAction };
}
