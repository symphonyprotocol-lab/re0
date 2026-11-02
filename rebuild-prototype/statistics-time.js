// Reporting uses the same UTC+8 calendar as the workspace (Asia/Kuching).
const DAY = 86400000;
const OFFSET = 8 * 3600000;
export const REPORT_TIMEZONE = "Asia/Kuching";
export function reportingDate(now = new Date()) {
  return new Date(Number(now) + OFFSET).toISOString().slice(0, 10);
}
export function validReportDate(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function statisticsTimeFilters(query, now = new Date()) {
  const result = {
    period: ["day", "week", "month", "custom"].includes(query.get("period"))
      ? query.get("period")
      : "all",
    date: validReportDate(query.get("date"))
      ? query.get("date")
      : reportingDate(now),
  };
  if (result.period === "custom") {
    const today = reportingDate(now);
    const fallback = result.date <= today ? result.date : today;
    const start = validReportDate(query.get("start"))
      ? query.get("start")
      : fallback.slice(0, 7) + "-01";
    const end = validReportDate(query.get("end")) ? query.get("end") : fallback;
    [result.start, result.end] = [
      start > today ? today : start,
      end > today ? today : end,
    ].sort();
    result.date = result.end;
  }
  return result;
}
export function validStatisticsRange(start, end, now = new Date()) {
  return (
    validReportDate(start) &&
    validReportDate(end) &&
    start <= end &&
    end <= reportingDate(now)
  );
}
export function recentStatisticsRange(days, now = new Date()) {
  if (![7, 30, 90].includes(days)) return null;
  const end = reportingDate(now);
  const midnight = Date.parse(end + "T00:00:00+08:00");
  return { start: reportingDate(new Date(midnight - (days - 1) * DAY)), end };
}
export function writeStatisticsTimeParams(query, filter) {
  const time = statisticsTimeFilters(
    new URLSearchParams(
      Object.entries(filter).filter(([, value]) => value !== undefined),
    ),
  );
  query.set("period", time.period);
  if (time.period === "custom") {
    query.set("start", time.start);
    query.set("end", time.end);
  } else if (time.period !== "all") query.set("date", time.date);
  return query;
}
export function statisticsFilterRange(filter) {
  return filter.period === "custom"
    ? statisticsPeriod("custom", filter.start, filter.end)
    : statisticsPeriod(filter.period || "all", filter.date);
}
export function reportingWeek(date) {
  const local = new Date(date + "T00:00:00Z");
  local.setUTCDate(local.getUTCDate() + 3 - ((local.getUTCDay() + 6) % 7));
  const year = local.getUTCFullYear();
  const first = new Date(`${year}-01-01T00:00:00Z`);
  const week = Math.ceil(((Number(local) - Number(first)) / DAY + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
export function statisticsSelection(period, date) {
  return period === "week"
    ? reportingWeek(date)
    : period === "month"
      ? date.slice(0, 7)
      : date;
}
export function statisticsSelectionDate(period, value) {
  if (period === "day") return validReportDate(value) ? value : null;
  if (period === "month")
    return /^\d{4}-\d{2}$/.test(value || "") && validReportDate(value + "-01")
      ? value + "-01"
      : null;
  if (period !== "week" || !/^\d{4}-W\d{2}$/.test(value || "")) return null;
  const year = value.slice(0, 4),
    week = Number(value.slice(6));
  if (week < 1 || week > 53) return null;
  const first = statisticsPeriod("week", `${year}-01-04`).start;
  const date = reportingDate(new Date(first + (week - 1) * 7 * DAY));
  return reportingWeek(date) === value ? date : null;
}
export function recordTime(record) {
  const value = record.createdAt || record.time;
  if (validReportDate(value)) return Date.parse(value + "T00:00:00+08:00");
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return null;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) && validReportDate(value.slice(0, 10))
    ? stamp
    : null;
}
export function statisticsPeriod(period, date, endDate) {
  if (period === "all") return null;
  if (period === "custom") {
    return {
      start: Date.parse(date + "T00:00:00+08:00"),
      end: Date.parse(endDate + "T00:00:00+08:00") + DAY,
    };
  }
  const local = new Date(date + "T00:00:00Z");
  if (period === "week")
    local.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
  if (period === "month") local.setUTCDate(1);
  const start = Number(local) - OFFSET;
  if (period === "month") local.setUTCMonth(local.getUTCMonth() + 1);
  else local.setUTCDate(local.getUTCDate() + (period === "week" ? 7 : 1));
  return { start, end: Number(local) - OFFSET };
}
export function inStatisticsPeriod(record, range) {
  if (!range) return true;
  const stamp = recordTime(record);
  return stamp !== null && stamp >= range.start && stamp < range.end;
}
export function shiftStatisticsDate(period, date, direction) {
  const range = statisticsPeriod(period, date);
  const local = new Date(range.start + OFFSET);
  if (period === "month") local.setUTCMonth(local.getUTCMonth() + direction);
  else
    local.setUTCDate(
      local.getUTCDate() + (period === "week" ? 7 : 1) * direction,
    );
  return local.toISOString().slice(0, 10);
}
export function statisticsBuckets(events, income, range, period) {
  if (!range) return [];
  const step =
    period === "day"
      ? 3600000
      : period === "custom"
        ? Math.max(1, Math.ceil((range.end - range.start) / DAY / 31)) * DAY
        : DAY;
  const buckets = [];
  for (let start = range.start; start < range.end; start += step) {
    buckets.push({
      start,
      end: Math.min(start + step, range.end),
      answers: 0,
      earned: 0,
    });
  }
  for (const event of events) {
    const stamp = recordTime(event);
    if (stamp !== null && stamp >= range.start && stamp < range.end)
      buckets[Math.floor((stamp - range.start) / step)].answers++;
  }
  for (const entry of income) {
    const stamp = recordTime(entry);
    if (stamp !== null && stamp >= range.start && stamp < range.end)
      buckets[Math.floor((stamp - range.start) / step)].earned += Number(
        entry.amount,
      );
  }
  return buckets;
}
