import test from "node:test";
import assert from "node:assert/strict";
import {
  reportingDate,
  validReportDate,
  recordTime,
  statisticsPeriod,
  inStatisticsPeriod,
  shiftStatisticsDate,
  statisticsBuckets,
  reportingWeek,
  statisticsSelection,
  statisticsSelectionDate,
  statisticsTimeFilters,
  statisticsFilterRange,
  validStatisticsRange,
  recentStatisticsRange,
} from "../statistics-time.js";
test("recent ranges include today, use UTC+8 and span the exact number of days across years and leap days", () => {
  const now = new Date("2025-12-31T16:00:00Z");
  for (const [days, start] of [
    [7, "2025-12-26"],
    [30, "2025-12-03"],
    [90, "2025-10-04"],
  ]) {
    const range = recentStatisticsRange(days, now);
    assert.deepEqual(range, { start, end: "2026-01-01" });
    const bounds = statisticsPeriod("custom", range.start, range.end);
    assert.equal((bounds.end - bounds.start) / 86400000, days);
  }
  assert.deepEqual(
    recentStatisticsRange(30, new Date("2028-03-01T00:00:00Z")),
    { start: "2028-02-01", end: "2028-03-01" },
  );
  assert.equal(recentStatisticsRange(99, now), null);
});
test("custom ranges include the whole end date and support a single day", () => {
  const f = statisticsTimeFilters(
    new URLSearchParams("period=custom&start=2026-10-31&end=2026-10-31"),
    new Date("2026-10-31T00:00:00Z"),
  );
  const range = statisticsFilterRange(f);
  assert.equal(range.end - range.start, 86400000);
  assert.equal(
    inStatisticsPeriod({ createdAt: "2026-10-30T16:00:00Z" }, range),
    true,
  );
  assert.equal(
    inStatisticsPeriod({ createdAt: "2026-10-31T15:59:59Z" }, range),
    true,
  );
  assert.equal(
    inStatisticsPeriod({ createdAt: "2026-10-31T16:00:00Z" }, range),
    false,
  );
  assert.equal(inStatisticsPeriod({ time: "刚刚" }, range), false);
  assert.equal(validStatisticsRange("2026-10-31", "2026-10-30"), false);
});
test("custom URL bounds normalize invalid, reversed and future dates safely", () => {
  const now = new Date("2026-10-31T00:00:00Z");
  const reversed = statisticsTimeFilters(
    new URLSearchParams("period=custom&start=2026-10-31&end=2026-09-01"),
    now,
  );
  assert.equal(reversed.start, "2026-09-01");
  assert.equal(reversed.end, "2026-10-31");
  const invalid = statisticsTimeFilters(
    new URLSearchParams("period=custom&start=2026-02-30&end=invalid"),
    now,
  );
  assert.equal(invalid.start, "2026-10-01");
  assert.equal(invalid.end, "2026-10-31");
  const future = statisticsTimeFilters(
    new URLSearchParams("period=custom&start=2026-12-01&end=2027-01-01"),
    now,
  );
  assert.equal(future.start, "2026-10-31");
  assert.equal(future.end, "2026-10-31");
});
test("long custom trends stay bounded and preserve exact totals across all buckets", () => {
  const range = statisticsPeriod("custom", "2024-01-01", "2026-10-31");
  const buckets = statisticsBuckets(
    [
      { createdAt: "2024-02-29T00:00:00Z" },
      { createdAt: "2026-10-31T15:59:59Z" },
      { createdAt: "2026-10-31T16:00:00Z" },
    ],
    [{ amount: 17, createdAt: "2026-10-31T15:59:59Z" }],
    range,
    "custom",
  );
  assert.ok(buckets.length <= 31);
  assert.equal(buckets.at(-1).end, range.end);
  assert.equal(
    buckets.reduce((sum, bucket) => sum + bucket.answers, 0),
    2,
  );
  assert.equal(
    buckets.reduce((sum, bucket) => sum + bucket.earned, 0),
    17,
  );
});
test("week and month selections round-trip across ISO week years without invalid weeks", () => {
  assert.equal(reportingWeek("2027-01-01"), "2026-W53");
  assert.equal(statisticsSelection("week", "2027-01-01"), "2026-W53");
  assert.equal(statisticsSelectionDate("week", "2026-W53"), "2026-12-28");
  assert.equal(statisticsSelectionDate("week", "2021-W53"), null);
  assert.equal(statisticsSelectionDate("week", "2026-W00"), null);
  assert.equal(statisticsSelectionDate("month", "2028-02"), "2028-02-01");
  assert.equal(statisticsSelection("month", "2028-02-29"), "2028-02");
  assert.equal(statisticsSelectionDate("month", "2028-13"), null);
  assert.equal(statisticsSelectionDate("day", "2026-02-30"), null);
});
test("reporting dates use UTC+8 and reject relative or invalid legacy dates", () => {
  assert.equal(reportingDate(new Date("2026-10-30T16:00:00Z")), "2026-10-31");
  for (const value of [
    "2026-02-30",
    "2026-10-31<script>",
    "今天",
    "刚刚",
    "",
    null,
  ])
    assert.equal(validReportDate(value), false);
  assert.equal(recordTime({ time: "今天 10:30" }), null);
  assert.equal(recordTime({ createdAt: "2026-02-30T00:00:00Z" }), null);
  assert.equal(
    recordTime({ time: "2026-10-31" }),
    Date.parse("2026-10-30T16:00:00Z"),
  );
});
test("day boundaries are half-open local midnight and preserve unknown records only for All time", () => {
  const range = statisticsPeriod("day", "2026-10-31");
  assert.equal(
    inStatisticsPeriod({ createdAt: "2026-10-30T15:59:59Z" }, range),
    false,
  );
  assert.equal(
    inStatisticsPeriod({ createdAt: "2026-10-30T16:00:00Z" }, range),
    true,
  );
  assert.equal(
    inStatisticsPeriod({ createdAt: "2026-10-31T16:00:00Z" }, range),
    false,
  );
  assert.equal(inStatisticsPeriod({ time: "刚刚" }, range), false);
  assert.equal(inStatisticsPeriod({ time: "刚刚" }, null), true);
});
test("weeks start Monday across years and month navigation handles leap years", () => {
  const week = statisticsPeriod("week", "2027-01-01");
  assert.equal(reportingDate(new Date(week.start)), "2026-12-28");
  assert.equal(reportingDate(new Date(week.end)), "2027-01-04");
  const feb = statisticsPeriod("month", "2028-02-29");
  assert.equal((feb.end - feb.start) / 86400000, 29);
  assert.equal(shiftStatisticsDate("month", "2028-01-31", 1), "2028-02-01");
  assert.equal(shiftStatisticsDate("day", "2028-03-01", -1), "2028-02-29");
  assert.equal(shiftStatisticsDate("week", "2027-01-01", -1), "2026-12-21");
});
test("hourly and daily buckets include zeros and never double count the next period", () => {
  const range = statisticsPeriod("day", "2026-10-31");
  const buckets = statisticsBuckets(
    [
      { createdAt: "2026-10-30T16:00:00Z" },
      { createdAt: "2026-10-30T16:30:00Z" },
      { createdAt: "2026-10-31T16:00:00Z" },
      { time: "刚刚" },
    ],
    [{ createdAt: "2026-10-31T15:59:59Z", amount: 25 }],
    range,
    "day",
  );
  assert.equal(buckets.length, 24);
  assert.equal(buckets[0].answers, 2);
  assert.equal(buckets[23].earned, 25);
  assert.equal(
    buckets.reduce((sum, b) => sum + b.answers, 0),
    2,
  );
  assert.equal(
    statisticsBuckets([], [], statisticsPeriod("month", "2026-10-31"), "month")
      .length,
    31,
  );
  assert.equal(
    statisticsBuckets([], [], statisticsPeriod("week", "2026-10-31"), "week")
      .length,
    7,
  );
});
