import test from "node:test";
import assert from "node:assert/strict";
import {
  calendarWeeks,
  calendarSelectionDate,
  createStatisticsCalendar,
} from "../statistics-calendar.js";
import { createStatisticsPeriodControls } from "../statistics-period.js";
import { recentStatisticsRange } from "../statistics-time.js";
test("calendar weeks include whole Monday–Sunday rows through month and year boundaries", () => {
  const rows = calendarWeeks("2027-01-01");
  assert.equal(rows[0][0], "2026-12-28");
  assert.equal(rows.at(-1).at(-1), "2027-01-31");
  assert.equal(
    rows.flat().filter((date) => date.startsWith("2027-01")).length,
    31,
  );
  assert.ok(rows.every((row) => row.length === 7));
});
test("calendar choices normalize entire weeks and months and disallow future periods", () => {
  assert.equal(
    calendarSelectionDate("week", "2027-01-01", "2027-01-01"),
    "2026-12-28",
  );
  assert.equal(
    calendarSelectionDate("month", "2028-02-29", "2028-02-29"),
    "2028-02-01",
  );
  assert.equal(calendarSelectionDate("day", "2026-02-30", "2026-10-31"), null);
  assert.equal(calendarSelectionDate("day", "2026-11-01", "2026-10-31"), null);
  assert.equal(calendarSelectionDate("week", "2026-11-02", "2026-10-31"), null);
});
test("all dimensions expose the same calendar trigger without an extra submit button", () => {
  const api = createStatisticsPeriodControls({ t: (zh) => zh, esc: String });
  for (const period of ["day", "week", "month"]) {
    const html = api.render(
      { period, date: "2026-10-31" },
      () => "/statistics",
      { id: "preview" },
    );
    assert.match(html, /role="dialog"/);
    assert.match(html, /data-action="statistics-calendar-toggle"/);
    assert.match(html, /name="selection"/);
    assert.doesNotMatch(html, /type="submit"|>查看</);
  }
});
test("selecting a calendar value immediately submits the existing form once and retains its other fields", async () => {
  globalThis.document = { addEventListener() {} };
  const api = createStatisticsCalendar({
    t: (zh) => zh,
    esc: String,
    I: () => "",
  });
  for (const [period, expected] of [
    ["day", "2026-01-01"],
    ["week", "2026-W01"],
    ["month", "2026-01"],
  ]) {
    let submits = 0;
    const selection = { value: "old" },
      panel = { hidden: false },
      fields = { dot: "mine", q: "design", size: "50" };
    const trigger = { setAttribute() {}, focus() {} };
    const form = {
      querySelector: () => selection,
      requestSubmit: () => submits++,
      fields,
    };
    const control = {
      dataset: { period },
      closest: () => form,
      querySelector: (selector) =>
        selector === ".statistics-calendar" ? panel : trigger,
    };
    const element = { closest: () => control };
    await api.onAction(
      "statistics-calendar-select",
      { date: "2026-01-01" },
      element,
    );
    assert.equal(selection.value, expected);
    assert.equal(submits, 1);
    assert.equal(panel.hidden, true);
    assert.deepEqual(form.fields, fields);
  }
});
test("Escape closes the calendar and returns focus without applying a selection", () => {
  const listeners = new Map();
  globalThis.document = {
    addEventListener: (type, listener) => listeners.set(type, listener),
  };
  createStatisticsCalendar({ t: (zh) => zh, esc: String, I: () => "" });
  let focused = false,
    prevented = false;
  const panel = { hidden: false };
  const trigger = {
    setAttribute() {},
    focus() {
      focused = true;
    },
  };
  const control = {
    querySelector: (selector) =>
      selector === ".statistics-calendar" ? panel : trigger,
  };
  listeners.get("keydown")({
    key: "Escape",
    target: { closest: () => control },
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(panel.hidden, true);
  assert.equal(focused, true);
  assert.equal(prevented, true);
});
test("custom calendar waits for both bounds, then sorts and applies the range once", async () => {
  globalThis.document = { addEventListener() {} };
  const api = createStatisticsCalendar({
    t: (zh) => zh,
    esc: String,
    I: () => "",
  });
  let submits = 0;
  const fields = {
    start: { value: "2026-10-01" },
    end: { value: "2026-10-31" },
  };
  const panel = {
    hidden: false,
    dataset: {
      phase: "start",
      cursor: "2026-10-01",
      rangeStart: "2026-10-01",
      rangeEnd: "2026-10-31",
    },
    querySelector: () => null,
  };
  const trigger = { setAttribute() {}, focus() {} };
  const form = {
    querySelector: (selector) =>
      fields[selector.includes("start") ? "start" : "end"],
    requestSubmit: () => submits++,
  };
  const control = {
    dataset: {
      period: "custom",
      start: "2026-10-01",
      end: "2026-10-31",
      date: "2026-10-01",
    },
    closest: () => form,
    querySelector: (selector) =>
      selector === ".statistics-calendar" ? panel : trigger,
  };
  const element = { closest: () => control };
  await api.onAction(
    "statistics-calendar-select",
    { date: "2026-10-20" },
    element,
  );
  assert.equal(submits, 0);
  assert.equal(panel.hidden, false);
  assert.equal(panel.dataset.phase, "end");
  assert.equal(fields.start.value, "2026-10-01");
  await api.onAction(
    "statistics-calendar-select",
    { date: "2026-10-10" },
    element,
  );
  assert.equal(submits, 1);
  assert.equal(fields.start.value, "2026-10-10");
  assert.equal(fields.end.value, "2026-10-20");
  assert.equal(panel.hidden, true);
});
test("recent-range shortcuts replace pending custom dates and apply immediately once", async () => {
  globalThis.document = { addEventListener() {} };
  const api = createStatisticsCalendar({
    t: (zh) => zh,
    esc: String,
    I: () => "",
  });
  for (const days of [7, 30, 90]) {
    let submits = 0;
    const fields = {
      start: { value: "2026-01-01" },
      end: { value: "2026-01-31" },
    };
    const panel = {
      hidden: false,
      dataset: { phase: "end", rangeStart: "2026-01-15" },
    };
    const trigger = { setAttribute() {}, focus() {} };
    const form = {
      querySelector: (selector) =>
        fields[selector.includes("start") ? "start" : "end"],
      requestSubmit: () => submits++,
    };
    const control = {
      dataset: { period: "custom" },
      closest: () => form,
      querySelector: (selector) =>
        selector === ".statistics-calendar" ? panel : trigger,
    };
    await api.onAction(
      "statistics-calendar-preset",
      { days: String(days) },
      { closest: () => control },
    );
    const expected = recentStatisticsRange(days);
    assert.equal(fields.start.value, expected.start);
    assert.equal(fields.end.value, expected.end);
    assert.equal(submits, 1);
    assert.equal(panel.hidden, true);
  }
});
