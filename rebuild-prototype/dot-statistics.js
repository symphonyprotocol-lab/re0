import {
  answerRowsForDots,
  answerEventsForDots,
  filterAnswers,
} from "./workspace-details.js";
import { sourceSummary } from "./workspace.js";
import { createStatisticsPeriodControls } from "./statistics-period.js";
import {
  REPORT_TIMEZONE,
  reportingDate,
  recordTime,
  statisticsFilterRange,
  writeStatisticsTimeParams,
  validStatisticsRange,
  inStatisticsPeriod,
  statisticsBuckets,
  statisticsTimeFilters,
  statisticsSelectionDate,
} from "./statistics-time.js";

// Income belongs to a Ree only when the ledger explicitly identifies it.
// Titles and the account-wide earned balance are not attribution evidence.
export function dotStatistics(state, id) {
  const dot = (state.dots || []).find((b) => b.id === id && b.owner === "me");
  if (!dot) return null;
  return statisticsForRee(state, dot);
}
export function statisticsForRee(state, dot) {
  const id = dot.id;
  const records = answerRowsForDots(state, [dot]);
  const income = (state.entries || []).filter(
    (entry) =>
      entry.type === "income" &&
      (entry.dotId || entry.dot) === id &&
      Number(entry.amount) > 0,
  );
  const events = answerEventsForDots(state, [dot])
    .map((row) => row.event);
  return {
    dot,
    answers: Math.max(0, Number(dot.answers) || 0),
    records,
    events,
    sources: sourceSummary(dot.knowledge || []),
    income,
    earned: income.reduce((sum, row) => sum + Number(row.amount), 0),
  };
}

export function statisticsFilters(query, now = new Date()) {
  return {
    view: query.get("view") === "income" ? "income" : "answers",
    q: (query.get("q") || "").trim().slice(0, 200),
    size: [20, 50, 100].includes(Number(query.get("size")))
      ? Number(query.get("size"))
      : 20,
    page: Math.max(1, Math.floor(Number(query.get("page")) || 1)),
    ...statisticsTimeFilters(query, now),
  };
}

export function createDotStatistics(ctx, options = {}) {
  const { t, I, esc, n, title, shell, footer, go } = ctx;
  const S = ctx.getState;
  const load = options.load || dotStatistics;
  const wrap = options.shell || shell;
  const pageFooter = options.footer || footer;
  const formScope = options.formScope || "dot-statistics";
  const sourcesPath = options.sourcesPath || (id => "/dots/" + id + "/knowledge?status=ready");
  const link = (path, label, cls = "text-link") =>
    `<a href="#${esc(path)}" class="${cls}">${label}</a>`;
  function path(id, filter, patch = {}) {
    const f = { ...filter, ...patch };
    const q = new URLSearchParams({ view: f.view, size: f.size });
    if (f.period !== "all") {
      writeStatisticsTimeParams(q, f);
    }
    if (f.q) q.set("q", f.q);
    if (f.page > 1) q.set("page", f.page);
    return options.path ? options.path(id, q) : "/dots/" + encodeURIComponent(id) + "/statistics?" + q;
  }
  const periods = createStatisticsPeriodControls(ctx);
  const periodName = periods.name;
  function formatTime(record) {
    const stamp = recordTime(record);
    return stamp === null
      ? `<span class="muted">${esc(record.time || t("时间未记录", "Time unavailable"))}</span>`
      : esc(
          new Date(stamp).toLocaleString(
            S().lang === "zh" ? "zh-CN" : "en-GB",
            { timeZone: REPORT_TIMEZONE },
          ),
        );
  }
  function missingTimeNote(data) {
    const missingAnswers = Math.max(
      0,
      data.answers -
        data.events.filter((event) => recordTime(event) !== null).length,
    );
    const missingIncome = data.income.filter(
      (entry) => recordTime(entry) === null,
    ).length;
    return missingAnswers || missingIncome
      ? `<span class="statistics-coverage">${t(`其中 ${n(missingAnswers)} 次历史成功回答、${n(missingIncome)} 条收入没有准确时间，仅计入全部时间。`, `${n(missingAnswers)} historical answers and ${n(missingIncome)} income records lack exact timestamps and appear only in All time.`)}</span>`
      : "";
  }
  const dateLabel = (stamp) => reportingDate(new Date(stamp));
  function periodControls(dot, f) {
    return periods.render(f, (patch) => path(dot.id, f, patch), {
      id: formScope + "-period",
      attributes: `data-dot="${esc(dot.id)}"`,
      fields: { view: f.view, q: f.q, size: f.size },
    });
  }
  function trend(dot, f, data, range) {
    if (!range) return "";
    const buckets = statisticsBuckets(
      data.events,
      data.income,
      range,
      f.period,
    );
    const income = f.view === "income",
      field = income ? "earned" : "answers";
    const max = Math.max(1, ...buckets.map((bucket) => bucket[field]));
    const sum = buckets.reduce((total, bucket) => total + bucket[field], 0);
    const label = income
      ? t("查询费收入", "Query income")
      : t("成功回答", "Successful answers");
    const unit = income ? " credits" : t(" 次", " answers");
    const bucketDays =
      f.period === "custom"
        ? (buckets[0].end - buckets[0].start) / 86400000
        : 1;
    const grouping =
      f.period === "day"
        ? t("按小时汇总", "Hourly totals")
        : bucketDays > 1
          ? t(`每 ${bucketDays} 天汇总`, `Totals every ${bucketDays} days`)
          : t("按天汇总", "Daily totals");
    const bucketName = (bucket) =>
      f.period === "day"
        ? String(new Date(bucket.start + 8 * 3600000).getUTCHours()).padStart(
            2,
            "0",
          ) + ":00"
        : dateLabel(bucket.start) +
          (bucketDays > 1 ? " — " + dateLabel(bucket.end - 1) : "");
    return `<section class="card statistics-trend" aria-label="${t("使用趋势", "Usage trend")}"><div class="statistics-trend-head"><div><h2>${t("使用趋势", "Usage trend")}</h2><p>${grouping} · ${label}</p></div><strong class="mono">${n(sum)}<small>${unit}</small></strong></div><div class="statistics-bars" role="list" aria-label="${label}">${buckets
      .map((bucket, i) => {
        const full = bucketName(bucket),
          value = bucket[field];
        const axis =
          f.period === "custom"
            ? i % 5 === 0 || i === buckets.length - 1
              ? dateLabel(bucket.start).slice(5)
              : ""
            : f.period === "day"
              ? i % 4 === 0 || i === 23
                ? full.slice(0, 2)
                : ""
              : f.period === "month"
                ? i % 5 === 0 || i === buckets.length - 1
                  ? full.slice(8)
                  : ""
                : full.slice(5);
        return `<div class="statistics-bar-item" role="listitem" aria-label="${esc(full + " · " + n(value) + unit)}" title="${esc(full + " · " + n(value) + unit)}"><span class="statistics-bar-track"><i style="height:${(value / max) * 100}%"></i></span><span class="statistics-bar-label">${axis}</span></div>`;
      })
      .join(
        "",
      )}</div>${!sum ? `<p class="statistics-trend-empty">${t("此时段暂无带准确时间的记录", "No dated records in this period")}</p>` : ""}</section>`;
  }
  function page(data, query) {
    const { dot } = data;
    const f = statisticsFilters(query);
    const official = !options.allowOfficialIncome && ctx.userRoles?.roleFor("me") === "official";
    if (official) { f.view = "answers"; data = {...data, income: [], earned: 0}; }
    const income = f.view === "income";
    const range = statisticsFilterRange(f);
    const records = data.records.filter(({ message }) =>
      inStatisticsPeriod(message, range),
    );
    const entries = data.income.filter((entry) =>
      inStatisticsPeriod(entry, range),
    );
    const events = data.events.filter((entry) =>
      inStatisticsPeriod(entry, range),
    );
    const earned = entries.reduce(
      (sum, entry) => sum + Number(entry.amount),
      0,
    );
    const rows = income
      ? entries.filter(
          (entry) =>
            !f.q ||
            (entry.title || "")
              .toLocaleLowerCase()
              .includes(f.q.toLocaleLowerCase()),
        )
      : filterAnswers(records, { dot: dot.id, q: f.q });
    const pages = Math.max(1, Math.ceil(rows.length / f.size));
    const current = Math.min(f.page, pages);
    const slice = rows.slice((current - 1) * f.size, current * f.size);
    const metric = (label, value, note, target, icon) =>
      link(
        target,
        `<div class="between"><span>${label}</span>${I(icon)}</div><strong class="mono">${n(value)}</strong><small>${note}</small>`,
        "card creator-metric",
      );
    const metrics = `<div class="creator-metrics">${metric(range ? t("时段成功回答", "Successful answers in period") : t("累计成功回答", "Successful answers"), range ? events.length : data.answers, range ? t("仅计有准确时间的记录", "Dated records only") : t("含历史演示统计", "Includes historical demo totals"), path(dot.id, f, { view: "answers", q: "", page: 1 }), "chat")}${metric(t("已留存回答", "Saved answers"), records.length, t("可查看正文与引用", "Read answers and citations"), path(dot.id, f, { view: "answers", q: "", page: 1 }), "file")}${metric(t("当前已就绪来源", "Currently ready sources"), data.sources.ready, t("共 " + n(data.sources.total) + " 个知识来源", n(data.sources.total) + " sources in total"), sourcesPath(dot.id), "layers")}${official ? "" : metric(range ? t("时段查询收入", "Query income in period") : t("已记录查询收入", "Recorded query income"), earned, "credits · " + t("仅计可归属流水", "Attributed ledger entries only"), path(dot.id, f, { view: "income", q: "", page: 1 }), "wallet")}</div>`;
    const toolbar = `<form id="${formScope}-filter" data-dot="${esc(dot.id)}" class="creator-detail-filters"><input type="hidden" name="period" value="${f.period}"><input type="hidden" name="date" value="${f.date}">${f.period === "custom" ? `<input type="hidden" name="start" value="${f.start}"><input type="hidden" name="end" value="${f.end}">` : ""}<div class="creator-detail-search">${I("search")}<input type="search" name="q" aria-label="${t("搜索统计明细", "Search activity")}" placeholder="${income ? t("搜索收入记录…", "Search income…") : t("搜索问题或回答…", "Search questions or answers…")}" value="${esc(f.q)}"></div><label><span>${t("明细类型", "Activity type")}</span><select name="view" aria-label="${t("明细类型", "Activity type")}"><option value="answers" ${!income ? "selected" : ""}>${t("成功回答", "Successful answers")}</option>${official ? "" : `<option value="income" ${income ? "selected" : ""}>${t("查询费收入", "Query income")}</option>`}</select></label><span class="creator-detail-fixed">${periodName(f.period)} · ${t("当前 Ree", "This Ree")}</span><label><span>${t("每页条数", "Rows per page")}</span><select name="size" aria-label="${t("每页条数", "Rows per page")}">${[20, 50, 100].map((size) => `<option value="${size}" ${f.size === size ? "selected" : ""}>${size}</option>`).join("")}</select></label><button type="submit" class="btn secondary sm">${t("应用筛选", "Apply filters")}</button>${link(path(dot.id, f, { q: "", page: 1 }), t("重置", "Reset"))}</form>`;
    const cells = income
      ? slice.map((entry) => [
          esc(entry.title),
          `<strong class="mono">+${n(entry.amount)} credits</strong>`,
          formatTime(entry),
        ])
      : slice.map(({ message, question }) => {
          const source =
            message.citationSnapshot ||
            (dot.knowledge || []).find((k) => k.id === message.source);
          return [
            `<strong class="creator-answer-question">${esc(question || t("未记录问题文本", "Question text unavailable"))}</strong><details class="creator-answer-detail"><summary>${t("查看回答正文", "Read answer")}</summary><div>${esc(message.text)}</div></details>`,
            source
              ? esc(source.title) +
                `<small class="creator-cell-note">${esc(source.locator || "")}</small>`
              : t("来源未记录", "No source recorded"),
            formatTime(message),
          ];
        });
    const heads = income
      ? [
          t("收入记录", "Income record"),
          t("金额", "Amount"),
          t("记录时间", "Recorded at"),
        ]
      : [
          t("问题 / 回答", "Question / answer"),
          t("引用来源", "Source"),
          t("记录时间", "Recorded at"),
        ];
    const empty = `<div class="creator-detail-empty">${I(income ? "wallet" : "chat")}<h3>${f.q || range ? t("没有符合筛选条件的记录", "No matching records") : income ? t("暂无可归属的查询费收入记录", "No attributed query income yet") : t("暂无已留存的成功回答", "No saved successful answers yet")}</h3><p>${f.q || range ? t("试试其他时段或关键词；没有准确时间的历史记录可在全部时间查看。", "Try another period or query; undated history is available under All time.") : income ? t("这里只展示明确关联到当前 Ree 的收入流水。所有者本人的提问不产生查询费收入。", "Only income explicitly linked to this Ree is shown. Owner questions do not generate query income.") : t("累计统计保留历史数量；有正文的回答才会显示在这里。", "Historical totals remain; only saved answers appear here.")}</p></div>`;
    const table = `<div class="table-wrap creator-detail-table"><table><thead><tr>${heads.map((head) => `<th>${head}</th>`).join("")}</tr></thead><tbody>${cells.length ? cells.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${heads.length}">${empty}</td></tr>`}</tbody></table></div>`;
    const pagination = `<div class="creator-detail-pagination"><span>${rows.length ? t("第 " + ((current - 1) * f.size + 1) + "–" + Math.min(current * f.size, rows.length) + " 项，共 " + n(rows.length) + " 项", (current - 1) * f.size + 1 + "–" + Math.min(current * f.size, rows.length) + " of " + n(rows.length)) : t("共 0 项", "0 results")}</span><div>${current > 1 ? link(path(dot.id, f, { page: current - 1 }), t("上一页", "Previous"), "btn secondary sm") : `<button class="btn secondary sm" disabled>${t("上一页", "Previous")}</button>`}<span>${current} / ${pages}</span>${current < pages ? link(path(dot.id, f, { page: current + 1 }), t("下一页", "Next"), "btn secondary sm") : `<button class="btn secondary sm" disabled>${t("下一页", "Next")}</button>`}</div></div>`;
    return wrap(
      `<div class="page creator-detail-page ${official ? "official-statistics" : ""} ${options.pageClass || ""}"><div class="creator-detail-heading"><div><h1>${t("使用统计", "Usage statistics")}</h1><p>${esc(title(dot))} · ${t("查看回答表现、知识就绪情况与查询费收入。", "Answers, source readiness and query income.")}</p></div><span class="tag blue">${t("当前 Ree", "This Ree")}</span></div>${periodControls(dot, f)}${metrics}${trend(dot, f, data, range)}<p class="creator-detail-explanation">${t("累计成功回答包含历史演示统计，未作答不计入；下方仅展示已留存的正文。收入按流水归属统计，不以回答次数乘查询费估算。", "Successful totals include historical demo statistics and exclude unanswered questions. Only saved texts appear below. Income is attributed from ledger entries, never estimated from answer counts.")}${range ? " " + t("时段统计仅包含有准确时间的记录；知识来源为当前快照，不随时段变化。", "Period totals include dated records only; sources show the current snapshot.") : ""}${missingTimeNote(data)}${official ? " " + t("官方账号的查询费收入仅在管理后台查看。", "Official account income is available only in the admin console.") : ""}</p><section class="card">${toolbar}${table}${pagination}</section>${pageFooter()}</div>`,
    );
  }
  function resolve(route, query) {
    const match = route.match(/^\/dots\/([^/]+)\/statistics$/);
    if (!match || !S().signed || S().disabled) return null;
    const data = dotStatistics(S(), match[1]);
    if (!data) return { redirect: "/dots" };
    return {
      html: page(data, query),
      title: title(data.dot) + " · " + t("使用统计", "Usage statistics"),
    };
  }
  async function onSubmit(form, fields) {
    if (![formScope + "-filter", formScope + "-period"].includes(form.id))
      return false;
    const data = load(S(), form.dataset.dot);
    if (!data) return true;
    const query = new URLSearchParams();
    for (const [key, value] of fields) query.set(key, String(value));
    if (
      query.get("period") === "custom" &&
      !validStatisticsRange(query.get("start"), query.get("end"))
    ) {
      ctx.toast?.(
        t(
          "请选择有效的开始和结束日期，结束日期不能早于开始日期",
          "Choose valid start and end dates; the end cannot precede the start",
        ),
      );
      return true;
    }
    if (query.has("selection")) {
      const date = statisticsSelectionDate(
        query.get("period"),
        query.get("selection"),
      );
      if (!date) {
        ctx.toast?.(
          t("请选择有效的日期、周或月份", "Choose a valid date, week or month"),
        );
        return true;
      }
      query.set("date", date);
    }
    go(path(data.dot.id, statisticsFilters(query), { page: 1 }));
    return true;
  }
  return { resolve, onSubmit, page };
}
