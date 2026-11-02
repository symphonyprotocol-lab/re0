import { workspaceSummary } from "./workspace.js";
import { createStatisticsPeriodControls } from "./statistics-period.js";
import {
  REPORT_TIMEZONE,
  statisticsTimeFilters,
  statisticsSelectionDate,
  statisticsFilterRange,
  writeStatisticsTimeParams,
  validStatisticsRange,
  inStatisticsPeriod,
  recordTime,
} from "./statistics-time.js";

export function sourceState(source) {
  return source.enabled === false
    ? "paused"
    : ["ready", "failed"].includes(source.status)
      ? source.status
      : "processing";
}
export function ownedSourceRows(state) {
  return workspaceSummary(state).dots.flatMap(({ dot }) =>
    (dot.knowledge || []).map((source) => ({
      dot,
      source,
      status: sourceState(source),
    })),
  );
}
export function ownedAnswerRows(state) {
  return answerRowsForDots(state, workspaceSummary(state).dots.map(({ dot }) => dot));
}
export function answerRowsForDots(state, dots) {
  const owned = new Map(dots.map(dot => [dot.id, dot]));
  const threads = [
    ...Object.entries(state.dotMessages || {}).map(([id, messages]) => ({
      id,
      messages,
    })),
    ...(state.chats || []).map((chat) => ({
      id: chat.id,
      messages: chat.messages || [],
    })),
  ];
  const seen = new Set(),
    result = [];
  for (const thread of threads) {
    let question = "";
    for (const message of thread.messages) {
      if (message.role === "user") question = message.text || "";
      const key = message.dot + ":" + message.id;
      if (
        message.role !== "dot" ||
        message.noAnswer ||
        !message.text?.trim() ||
        !owned.has(message.dot) ||
        seen.has(key)
      )
        continue;
      seen.add(key);
      result.push({
        dot: owned.get(message.dot),
        message,
        question,
        thread: thread.id,
      });
    }
  }
  return result.reverse();
}
export function ownedAnswerEvents(state) {
  return answerEventsForDots(state, workspaceSummary(state).dots.map(({ dot }) => dot));
}
export function answerEventsForDots(state, dots) {
  const owned = new Map(dots.map(dot => [dot.id, dot]));
  const events = new Map(
    answerRowsForDots(state, dots).map(({ dot, message }) => [
      dot.id + ":" + message.id,
      { dot, event: message },
    ]),
  );
  for (const entry of state.entries || []) {
    const dot = owned.get(entry.dotId || entry.dot);
    if (
      dot &&
      entry.type === "query" &&
      Number(entry.amount) < 0 &&
      entry.answerId &&
      recordTime(entry) !== null
    )
      events.set(dot.id + ":" + entry.answerId, { dot, event: entry });
  }
  return [...events.values()];
}
export function detailFilters(query, state, answers = false) {
  const dots = workspaceSummary(state).dots.map((row) => row.dot.id);
  const allow = (key, values, fallback) =>
    values.includes(query.get(key)) ? query.get(key) : fallback;
  return {
    scope: "mine",
    dot: allow("dot", ["all", ...dots], "all"),
    status: answers
      ? "answered"
      : allow(
          "status",
          ["all", "ready", "processing", "failed", "paused"],
          "all",
        ),
    kind: allow(
      "kind",
      ["all", "document", "audio", "github", "page", "site", "text"],
      "all",
    ),
    view: allow("view", ["summary", "records"], "summary"),
    ...statisticsTimeFilters(answers ? query : new URLSearchParams()),
    q: (query.get("q") || "").trim().slice(0, 200),
    page: Math.max(1, Math.floor(Number(query.get("page")) || 1)),
    size: [20, 50, 100].includes(Number(query.get("size")))
      ? Number(query.get("size"))
      : 20,
  };
}
export function filterSources(rows, filter) {
  const q = filter.q.toLocaleLowerCase();
  return rows.filter(
    ({ dot, source, status }) =>
      (filter.dot === "all" || filter.dot === dot.id) &&
      (filter.status === "all" || filter.status === status) &&
      (filter.kind === "all" || filter.kind === source.kind) &&
      (!q ||
        [source.title, dot.name, dot.enName, source.source]
          .join(" ")
          .toLocaleLowerCase()
          .includes(q)),
  );
}
export function filterAnswers(rows, filter) {
  const q = filter.q.toLocaleLowerCase();
  const range = statisticsFilterRange(filter);
  return rows.filter(
    ({ dot, message, question }) =>
      (filter.dot === "all" || filter.dot === dot.id) &&
      inStatisticsPeriod(message, range) &&
      (!q ||
        [dot.name, dot.enName, question, message.text]
          .join(" ")
          .toLocaleLowerCase()
          .includes(q)),
  );
}

export function createWorkspaceDetails(ctx) {
  const { t, I, esc, n, title, shell, footer, go } = ctx;
  const S = () => {
    const state = ctx.getState();
    return ctx.getOwnedRees ? { ...state, dots: ctx.getOwnedRees() } : state;
  };
  const reePath = dot => dot.ownedDemo
    ? "/dots?view=list&q=" + encodeURIComponent(title(dot))
    : "/dots/" + dot.id;
  const periods = createStatisticsPeriodControls(ctx);
  const statuses = {
    all: () => t("全部状态", "All statuses"),
    ready: () => t("已就绪", "Ready"),
    processing: () => t("处理中", "Processing"),
    failed: () => t("处理失败", "Failed"),
    paused: () => t("已停用", "Disabled"),
  };
  const kinds = {
    all: () => t("全部类型", "All types"),
    document: () => t("文档", "Document"),
    audio: () => t("音频", "Audio"),
    github: () => "GitHub",
    page: () => t("网页", "Web page"),
    site: () => t("整站", "Website"),
    text: () => t("文本", "Text"),
  };
  const link = (path, label, cls = "text-link") =>
    `<a href="#${esc(path)}" class="${cls}">${label}</a>`;
  function path(answers, filter, patch = {}) {
    const f = { ...filter, ...patch },
      q = new URLSearchParams({ scope: "mine", dot: f.dot, status: f.status });
    if (answers) {
      q.set("view", f.view);
      writeStatisticsTimeParams(q, f);
    } else q.set("kind", f.kind);
    if (f.q) q.set("q", f.q);
    q.set("size", f.size);
    if (f.page > 1) q.set("page", f.page);
    return "/workspace/" + (answers ? "answers" : "sources") + "?" + q;
  }
  function toolbar(answers, filter) {
    const select = (name, label, options) =>
      `<label><span>${label}</span><select name="${name}" aria-label="${label}">${options.map(([value, label]) => `<option value="${value}" ${filter[name] === value ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></label>`;
    return `<form id="workspace-detail-filter" data-list="${answers ? "answers" : "sources"}" class="creator-detail-filters">${answers ? `<input type="hidden" name="period" value="${filter.period}"><input type="hidden" name="date" value="${filter.date}">${filter.period === "custom" ? `<input type="hidden" name="start" value="${filter.start}"><input type="hidden" name="end" value="${filter.end}">` : ""}` : ""}<div class="creator-detail-search">${I("search")}<input type="search" name="q" aria-label="${t("搜索明细", "Search details")}" placeholder="${answers ? (filter.view === "summary" ? t("搜索 Ree 名称…", "Search Ree names…") : t("搜索问题、回答或 Ree…", "Search questions, answers or Rees…")) : t("搜索来源或 Ree…", "Search sources or Rees…")}" value="${esc(filter.q)}"></div>${select("dot", t("所属 Ree", "Ree"), [["all", t("全部我的 Ree", "All my Rees")], ...workspaceSummary(S()).dots.map(({ dot }) => [dot.id, title(dot)])])}${
      answers
        ? select("view", t("查看方式", "View"), [
            ["summary", t("按 Ree 汇总", "By Ree")],
            ["records", t("逐条回答记录", "Answer records")],
          ])
        : select(
            "kind",
            t("来源类型", "Source type"),
            Object.entries(kinds).map(([key, label]) => [key, label()]),
          )
    }${
      !answers
        ? select(
            "status",
            t("来源状态", "Source status"),
            Object.entries(statuses).map(([key, label]) => [key, label()]),
          )
        : `<span class="creator-detail-fixed">${I("check")}${t("成功作答", "Successful")} · ${periods.name(filter.period)}</span>`
    }<label><span>${t("每页条数", "Rows per page")}</span><select name="size" aria-label="${t("每页条数", "Rows per page")}">${[20, 50, 100].map((value) => `<option value="${value}" ${filter.size === value ? "selected" : ""}>${value}</option>`).join("")}</select></label><button type="submit" class="btn secondary sm">${t("应用筛选", "Apply filters")}</button>${link(path(answers, { ...filter, dot: "all", q: "", status: answers ? "answered" : "all", kind: "all", page: 1 }), t("重置", "Reset"), "text-link")}</form>`;
  }
  function pagination(answers, filter, count) {
    const pages = Math.max(1, Math.ceil(count / filter.size)),
      page = Math.min(filter.page, pages);
    return `<div class="creator-detail-pagination"><span>${count ? t("第 " + ((page - 1) * filter.size + 1) + "–" + Math.min(page * filter.size, count) + " 项，共 " + n(count) + " 项", (page - 1) * filter.size + 1 + "–" + Math.min(page * filter.size, count) + " of " + n(count)) : t("共 0 项", "0 results")}</span><div>${page > 1 ? link(path(answers, filter, { page: page - 1 }), t("上一页", "Previous"), "btn secondary sm") : `<button class="btn secondary sm" disabled>${t("上一页", "Previous")}</button>`}<span>${page} / ${pages}</span>${page < pages ? link(path(answers, filter, { page: page + 1 }), t("下一页", "Next"), "btn secondary sm") : `<button class="btn secondary sm" disabled>${t("下一页", "Next")}</button>`}</div></div>`;
  }
  const table = (heads, rows) =>
    `<div class="table-wrap creator-detail-table"><table><thead><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${heads.length}"><div class="creator-detail-empty">${I("search")}<h3>${t("没有符合筛选条件的记录", "No matching records")}</h3><p>${t("试试其他关键词、Ree 或筛选条件。", "Try another query, Ree or filter.")}</p></div></td></tr>`}</tbody></table></div>`;
  function page(answers, query) {
    const data = workspaceSummary(S()),
      f = detailFilters(query, S(), answers);
    const sourceRows = filterSources(ownedSourceRows(S()), f),
      allRecords = ownedAnswerRows(S());
    const range = statisticsFilterRange(f);
    const timedRecords = allRecords.filter(({ message }) =>
      inStatisticsPeriod(message, range),
    );
    const allEvents = answers ? ownedAnswerEvents(S()) : [];
    const dots = data.dots.filter(
      ({ dot }) =>
        (f.dot === "all" || f.dot === dot.id) &&
        (f.view === "records" ||
          !f.q ||
          [dot.name, dot.enName]
            .join(" ")
            .toLocaleLowerCase()
            .includes(f.q.toLocaleLowerCase())),
    );
    const dotIds = new Set(dots.map((row) => row.dot.id));
    const events = allEvents.filter(
      ({ dot, event }) =>
        dotIds.has(dot.id) && inStatisticsPeriod(event, range),
    );
    const records =
      f.view === "summary"
        ? timedRecords.filter((row) => dotIds.has(row.dot.id))
        : filterAnswers(allRecords, f);
    const answerLabel = range
      ? t("时段成功回答", "Successful answers in period")
      : t("累计成功回答", "Successful answers");
    const count = answers
      ? f.view === "summary"
        ? dots.length
        : records.length
      : sourceRows.length;
    const page = Math.min(f.page, Math.max(1, Math.ceil(count / f.size))),
      slice = (rows) => rows.slice((page - 1) * f.size, page * f.size);
    let content;
    if (!answers)
      content = table(
        [
          t("知识来源", "Source"),
          t("所属 Ree", "Ree"),
          t("状态", "Status"),
          t("操作", "Actions"),
        ],
        slice(sourceRows).map(({ dot, source, status }) => [
          `${dot.ownedDemo ? esc(source.title) : link("/dots/" + dot.id + "/knowledge/" + source.id, esc(source.title), "creator-detail-source")}<small class="creator-cell-note">${esc(kinds[source.kind]?.() || source.kind)}${dot.ownedDemo ? t(" · 测试来源", " · Test source") : ""}</small>`,
          link(dot.ownedDemo ? reePath(dot) : "/dots/" + dot.id + "/knowledge", esc(title(dot))),
          `<span class="tag creator-status-${status}">${statuses[status]()}</span>`,
          `<div class="creator-detail-actions">${dot.ownedDemo ? link(reePath(dot), t("查看测试 Ree", "View test Ree")) : `${link("/dots/" + dot.id + "/knowledge/" + source.id, t("预览", "Preview"))}${link("/dots/" + dot.id + "/knowledge" + (f.status !== "all" ? "?status=" + f.status : ""), t("管理来源", "Manage"))}`}</div>`,
        ]),
      );
    else if (f.view === "summary")
      content = table(
        [
          "Ree",
          answerLabel,
          t("已留存记录", "Available records"),
          t("操作", "Actions"),
        ],
        slice(dots).map(({ dot, answers }) => {
          const available = timedRecords.filter(
            (row) => row.dot.id === dot.id,
          ).length;
          const total = range
            ? events.filter((row) => row.dot.id === dot.id).length
            : answers;
          return [
            link(reePath(dot), esc(title(dot))) + (dot.ownedDemo ? `<small class="creator-cell-note">${t("测试 Ree", "Test Ree")}</small>` : ""),
            `<strong class="mono">${n(total)}</strong>`,
            `<span class="mono">${n(available)}</span>`,
            `<div class="creator-detail-actions">${available ? link(path(true, f, { dot: dot.id, view: "records", q: "", page: 1 }), t("查看回答记录", "View records")) : `<span class="muted">${t("暂无逐条记录", "No records yet")}</span>`}${link(reePath(dot), dot.ownedDemo ? t("查看测试 Ree", "View test Ree") : t("打开 Ree", "Open Ree"))}</div>`,
          ];
        }),
      );
    else
      content = table(
        [
          t("问题 / 回答", "Question / answer"),
          t("回答 Ree", "Answering Ree"),
          t("引用来源", "Source"),
          t("记录时间", "Recorded at"),
        ],
        slice(records).map(({ dot, message, question }) => {
          const source =
            message.citationSnapshot ||
            (dot.knowledge || []).find((k) => k.id === message.source);
          return [
            `<strong class="creator-answer-question">${esc(question || t("未记录问题文本", "Question text unavailable"))}</strong><details class="creator-answer-detail"><summary>${t("查看回答正文", "Read answer")}</summary><div>${esc(message.text)}</div></details>`,
            esc(title(dot)),
            source
              ? esc(source.title) +
                `<small class="creator-cell-note">${esc(source.locator || "")}</small>`
              : t("来源未记录", "No source recorded"),
            recordTime(message) !== null
              ? esc(
                  new Date(recordTime(message)).toLocaleString(
                    S().lang === "zh" ? "zh-CN" : "en-GB",
                    { timeZone: REPORT_TIMEZONE },
                  ),
                )
              : `<span class="muted">${t("时间未记录", "Time unavailable")}</span>`,
          ];
        }),
      );
    const total = range
        ? events.length
        : dots.reduce((sum, row) => sum + row.answers, 0),
      available = records.length;
    const missingTime = Math.max(
      0,
      dots.reduce((sum, row) => sum + row.answers, 0) -
        allEvents.filter(
          ({ dot, event }) => dotIds.has(dot.id) && recordTime(event) !== null,
        ).length,
    );
    const periodControls = answers
      ? periods.render(f, (patch) => path(true, f, patch), {
          id: "workspace-answer-period",
          attributes: 'data-list="answers"',
          fields: { dot: f.dot, view: f.view, q: f.q, size: f.size },
        })
      : "";
    return shell(
      `<div class="page creator-detail-page"><div class="creator-detail-heading"><div><h1>${answers ? t("累计回答明细", "Successful answer details") : t("知识来源明细", "Knowledge source details")}</h1><p>${answers ? t("查看我的 Ree 的累计表现与已留存回答。", "Explore your Rees' cumulative activity and available answers.") : t("汇总我的 Ree 的当前来源，按状态查找并进入预览或管理。", "Browse current sources across your Rees, then preview or manage them.")}</p></div><span class="tag blue">${t("仅我的 Ree", "My Rees only")}</span></div>${periodControls}<div class="creator-detail-summary">${answers ? `<span>${answerLabel}<strong>${n(total)}</strong></span><span>${t("已留存可查看记录", "Available answer records")}<strong>${n(available)}</strong></span>` : `<span>${t("全部知识来源", "All owned sources")}<strong>${n(data.sources.total)}</strong></span><span>${t("当前筛选结果", "Matching sources")}<strong>${n(sourceRows.length)}</strong></span>`}</div>${answers ? `<p class="creator-detail-explanation">${t("累计数字包含演示账户的历史统计；只有已留存正文的回答可逐条查看，未作答不计入成功回答。", "Totals include historical demo statistics. Only saved answer texts can be opened individually; unanswered questions are excluded.")}${range ? " " + t("时段统计仅包含有准确时间的成功回答；清空测试消息后，其使用记录仍计入汇总。", "Period totals include dated successful answers; usage remains in totals after clearing test messages.") : ""}${missingTime ? `<span class="statistics-coverage">${t(`${n(missingTime)} 次历史成功回答没有准确时间，仅计入全部时间。`, `${n(missingTime)} historical answers lack exact timestamps and appear only in All time.`)}</span>` : ""}</p>` : ""}<section class="card">${toolbar(answers, f)}${content}${pagination(answers, { ...f, page }, count)}</section>${footer()}</div>`,
    );
  }
  function resolve(path, query) {
    if (
      !S().signed ||
      S().disabled ||
      !["/workspace/sources", "/workspace/answers"].includes(path)
    )
      return null;
    return {
      html: page(path.endsWith("answers"), query),
      title: path.endsWith("answers")
        ? t("累计回答明细", "Answer details")
        : t("知识来源明细", "Source details"),
    };
  }
  async function onSubmit(form, fields) {
    if (
      !["workspace-detail-filter", "workspace-answer-period"].includes(form.id)
    )
      return false;
    const answers = form.dataset.list === "answers",
      query = new URLSearchParams();
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
    if (answers && query.has("selection")) {
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
    const f = detailFilters(query, S(), answers);
    f.page = 1;
    go(path(answers, f));
    return true;
  }
  return { resolve, onSubmit };
}
