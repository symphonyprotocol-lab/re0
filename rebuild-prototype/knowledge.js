// Owner-only knowledge management, designed for hundreds of sources.
export function createKnowledge(ctx) {
  const {
    t,
    I,
    esc,
    uid,
    n,
    title,
    avatar,
    dotById,
    kinds,
    shell,
    route,
    go,
    save,
    render,
    modal,
    closeModal,
    confirmModal,
    btn,
    iconBtn,
    cancelButton,
    submitButton,
    toast,
    copy,
    debit,
    creditEntry,
    scheduleProcessing,
  } = ctx;
  const S = () => ctx.getState(),
    U = () => ctx.getUi();
  const views = new Map(),
    files = new Map();
  let preview = null,
    searchTimer;
  const L = (path, label, cls = "text-link") =>
    `<a href="#${path}" class="${cls}">${label}</a>`;
  const stamp = () => new Date().toISOString();
  const owner = (b) => b?.owner === "me" && S().signed && !S().disabled;
  const all = (b) => b.knowledge || [];
  const folders = (b) => b.knowledgeFolders || [];
  const folderOf = (b, k) =>
    folders(b).some((f) => f.id === k.folderId) ? k.folderId : "unfiled";
  const folderName = (b, id) =>
    id === "unfiled"
      ? t("未分组", "Unfiled")
      : folders(b).find((f) => f.id === id)?.name ||
        t("全部知识", "All sources");
  function view(b) {
    if (!views.has(b.id)) {
      const q = route().query;
      views.set(b.id, {
        q: q.get("q") || "",
        kind: q.get("kind") || "all",
        folder: q.get("folder") || "all",
        status: q.get("status") || "all",
        sort: q.get("sort") || "new",
        page: Math.max(1, Number(q.get("page")) || 1),
        size: 20,
        trash: q.get("view") === "trash",
        selected: new Set(),
        sideQ: "",
        sidePage: 1,
      });
    }
    const v = views.get(b.id);
    if (
      !["all", "unfiled"].includes(v.folder) &&
      !folders(b).some((f) => f.id === v.folder)
    )
      v.folder = "all";
    return v;
  }
  const humanType = (k) =>
    kinds[k.kind] ? t(kinds[k.kind][0], kinds[k.kind][1]) : t("知识", "Source");
  const isBusy = (k) => ["pending", "processing"].includes(k.status);
  const enabled = (k) => k.enabled !== false;
  const ready = (k) => k.status === "ready" && enabled(k);
  const badge = (k) =>
    `<span class="ks-status ${k.status}">${isBusy(k) ? '<i class="spinner"></i>' : '<i class="dot"></i>'}${{ ready: t("已就绪", "Ready"), pending: t("待处理", "Queued"), processing: t("处理中", "Processing"), failed: t("处理失败", "Failed") }[k.status] || esc(k.status)}</span>`;
  function updated(k) {
    const iso = k.updatedAt || k.createdAt || "2026-10-30T08:24:00Z";
    const d = new Date(iso);
    return Number.isNaN(d.valueOf())
      ? iso
      : new Intl.DateTimeFormat(S().lang === "zh" ? "zh-CN" : "en-GB", {
          timeZone: "Asia/Kuching",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(d);
  }
  function mark(text, query = "") {
    text = String(text || "");
    if (!query) return esc(text);
    let out = "",
      at = 0,
      hits = 0,
      lower = text.toLocaleLowerCase(),
      needle = query.toLocaleLowerCase(),
      index;
    while ((index = lower.indexOf(needle, at)) !== -1 && hits++ < 1000) {
      out +=
        esc(text.slice(at, index)) +
        "<mark>" +
        esc(text.slice(index, index + query.length)) +
        "</mark>";
      at = index + query.length;
    }
    return out + esc(text.slice(at));
  }
  function rootRows(b) {
    return view(b).trash ? b.knowledgeTrash || [] : all(b);
  }
  function folderRows(b, data = rootRows(b)) {
    const v = view(b);
    return v.folder === "all"
      ? data
      : data.filter((k) => folderOf(b, k) === v.folder);
  }
  function rows(b) {
    const v = view(b),
      q = v.q.toLowerCase().trim();
    let items = folderRows(b).filter(
      (k) =>
        (v.kind === "all" || k.kind === v.kind) &&
        (v.status === "all" ||
          (v.status === "paused"
            ? !enabled(k)
            : v.status === "processing"
              ? isBusy(k)
              : k.status === v.status)) &&
        (!q ||
          [
            k.title,
            k.source,
            k.fileName,
            k.content,
            ...(k.pages || []).map((p) => p.title),
            ...(k.files || []).map((f) => f.path),
          ]
            .join(" ")
            .toLowerCase()
            .includes(q)),
    );
    items.sort((a, b) =>
      v.sort === "title"
        ? a.title.localeCompare(b.title, "zh")
        : v.sort === "old"
          ? (a.createdAt || "").localeCompare(b.createdAt || "")
          : (b.updatedAt || b.createdAt || "").localeCompare(
              a.updatedAt || a.createdAt || "",
            ),
    );
    return items;
  }
  function pageRows(b) {
    const v = view(b),
      result = rows(b);
    v.page = Math.min(v.page, Math.max(1, Math.ceil(result.length / v.size)));
    return result.slice((v.page - 1) * v.size, v.page * v.size);
  }
  function syncURL(b) {
    if (route().path !== "/dots/" + b.id + "/knowledge") return;
    const v = view(b),
      q = new URLSearchParams();
    if (v.q) q.set("q", v.q);
    if (v.kind !== "all") q.set("kind", v.kind);
    if (v.folder !== "all") q.set("folder", v.folder);
    if (v.status !== "all") q.set("status", v.status);
    if (v.sort !== "new") q.set("sort", v.sort);
    if (v.page > 1) q.set("page", v.page);
    if (v.trash) q.set("view", "trash");
    history.replaceState(
      null,
      "",
      "#/dots/" + b.id + "/knowledge" + (q.size ? "?" + q : ""),
    );
  }
  const action = (label, a, b, k, cls = "btn secondary sm", extra = "") =>
    `<button type="button" class="${cls}" data-action="${a}" data-dot="${b.id}" ${k ? `data-id="${k.id}"` : ""} ${extra}>${label}</button>`;
  function sidebarRows(b) {
    const v = view(b),
      filtered = all(b).filter((k) =>
        [k.title, k.source]
          .join(" ")
          .toLowerCase()
          .includes(v.sideQ.toLowerCase()),
      );
    v.sidePage = Math.min(
      v.sidePage,
      Math.max(1, Math.ceil(filtered.length / 12)),
    );
    const slice = filtered.slice((v.sidePage - 1) * 12, v.sidePage * 12);
    return `${slice.map((k) => `<div class="ks-row ${!enabled(k) ? "paused" : ""}"><button type="button" class="ks-row-main" data-action="preview-source" data-dot="${b.id}" data-id="${k.id}" title="${esc(k.title)}"><span class="file-icon">${I(kinds[k.kind]?.[2] || "file")}</span><span class="grow"><strong>${mark(k.title, v.sideQ)}</strong><small>${humanType(k)}${k.pages?.length ? " · " + k.pages.length + " " + t("个页面", "pages") : k.files?.length ? " · " + k.files.length + " " + t("个文件", "files") : ""}</small>${badge(k)}${!enabled(k) ? `<span class="ks-paused-label">${t("已暂停参与回答", "Paused for answers")}</span>` : ""}</span></button>${iconBtn("dots", t("管理：", "Manage: ") + k.title, "source-menu", `data-dot="${b.id}" data-id="${k.id}"`)}</div>`).join("") || `<div class="ks-side-empty">${I("search")}<p>${v.sideQ ? t("没有匹配的来源", "No matching sources") : t("添加第一份知识，让它开始了解。", "Add a source to get started.")}</p>${!v.sideQ ? btn(t("添加知识", "Add knowledge"), "add-knowledge", "sm", `data-id="${b.id}"`) : ""}</div>`}${filtered.length > 12 ? `<div class="ks-side-pager">${action(I("chevron"), "side-page", b, null, "icon-btn flip", `data-value="${v.sidePage - 1}" aria-label="${t("上一页来源", "Previous sources")}" ${v.sidePage === 1 ? "disabled" : ""}`)}<span>${v.sidePage} / ${Math.ceil(filtered.length / 12)}</span>${action(I("chevron"), "side-page", b, null, "icon-btn", `data-value="${v.sidePage + 1}" aria-label="${t("下一页来源", "Next sources")}" ${v.sidePage * 12 >= filtered.length ? "disabled" : ""}`)}</div>` : ""}`;
  }
  function sidebar(b) {
    return `<aside class="knowledge-panel" id="knowledge-panel" data-dot="${b.id}"><div class="panel-heading"><span>${t("知识来源", "Knowledge sources")} <small>${all(b).length}</small></span>${iconBtn("plus", t("添加知识", "Add knowledge"), "add-knowledge", `data-id="${b.id}"`)}</div><div class="ks-side-search">${I("search")}<input id="ks-side-search" aria-label="${t("搜索对话侧栏的来源", "Search sidebar sources")}" placeholder="${t("搜索来源…", "Search sources…")}" value="${esc(view(b).sideQ)}" autocomplete="off"></div><div class="knowledge-list ks-compact-list" id="ks-side-list">${sidebarRows(b)}</div><div class="ks-side-manage">${L("/dots/" + b.id + "/knowledge", I("layers") + t("管理全部知识", "Manage all knowledge") + `<span class="mono">${all(b).length}</span>`, "btn secondary full")}<p>${t("点击来源预览正文，更多操作在管理页。", "Click a source to preview. Manage the full library here.")}</p></div></aside>`;
  }
  function workTabs(b) {
    const p = route().path,
      root = "/dots/" + b.id;
    return `<nav class="dot-work-tabs header-tabs" aria-label="${t("Ree 工作台功能", "Ree studio sections")}">${[
      [root + "/settings", "settings", t("设置", "Settings")],
      [root + "/knowledge", "file", t("知识管理", "Knowledge")],
      [root + "/video", "film", t("视频介绍", "Video")],
      [root + "/statistics", "chart", t("使用统计", "Statistics")],
      [root + "/chat", "chat", t("对话", "Chat")],
    ]
      .map(([href, icon, label]) => {
        const active =
          p === href ||
          (href.endsWith("/knowledge") && p.startsWith(href + "/"));
        return `<a href="#${href}" class="${active ? "active" : ""}" ${active ? 'aria-current="page"' : ""}>${I(icon)}${label}${icon === "file" ? `<span>${all(b).length}</span>` : ""}</a>`;
      })
      .join("")}</nav>`;
  }
  function headerControls(b) {
    const k = findSource(b, route().path.split("/")[4]);
    if (!k) return "";
    const candidates = rows(b),
      idx = candidates.findIndex((source) => source.id === k.id);
    return `<div class="context-source-nav"><span class="mono">${idx < 0 ? "—" : idx + 1} / ${candidates.length}</span>${action(I("chevron"), "knowledge-adjacent", b, k, "icon-btn flip", `data-value="-1" aria-label="${t("上一篇来源", "Previous source")}" ${idx <= 0 ? "disabled" : ""}`)}${action(I("chevron"), "knowledge-adjacent", b, k, "icon-btn", `data-value="1" aria-label="${t("下一篇来源", "Next source")}" ${idx < 0 || idx >= candidates.length - 1 ? "disabled" : ""}`)}</div>`;
  }
  function toolbar(b) {
    const v = view(b),
      selected = rootRows(b).filter((k) => v.selected.has(k.id));
    return `<div class="km-selection ${selected.length ? "has-selection" : ""}" id="km-selection"><div class="flex">${selected.length ? I("check") : I("info")}<span>${selected.length ? t("已选择 " + selected.length + " 个来源", selected.length + " sources selected") : t("勾选来源可批量管理；点击标题预览内容。", "Select rows for bulk actions. Click a title to preview.")}</span>${selected.length ? action(t("清空", "Clear"), "knowledge-clear", b, null, "text-link") : ""}</div><div class="flex">${selected.length ? (v.trash ? action(I("refresh") + t("恢复所选", "Restore selected"), "knowledge-bulk-restore", b) : action(I("folder") + t("移动到…", "Move to…"), "knowledge-bulk-move", b) + action(I("refresh") + t("重新处理", "Reprocess"), "knowledge-bulk-refresh", b) + action(I("pause") + t("暂停回答", "Pause"), "knowledge-bulk-pause", b) + action(I("play") + t("恢复回答", "Enable"), "knowledge-bulk-enable", b) + action(I("trash") + t("移到回收站", "Move to trash"), "knowledge-bulk-trash", b)) : ""}</div></div>${selected.length && selected.length < rows(b).length && pageRows(b).every((k) => v.selected.has(k.id)) ? `<div class="km-select-all">${t("已选中本页。", "Current page selected.")} ${action(t("选择全部 " + rows(b).length + " 个筛选结果", "Select all " + rows(b).length + " matching sources"), "knowledge-select-filtered", b, null, "text-link")}</div>` : ""}`;
  }
  function resultHTML(b) {
    const v = view(b),
      data = rows(b),
      page = pageRows(b),
      pages = Math.max(1, Math.ceil(data.length / v.size));
    return `${toolbar(b)}<div class="km-scroll"><table class="km-table"><thead><tr><th class="km-check"><input type="checkbox" id="km-select-page" aria-label="${t("选择本页全部来源", "Select all sources on this page")}" ${page.length && page.every((k) => v.selected.has(k.id)) ? "checked" : ""} ${!page.length ? "disabled" : ""}></th><th>${t("来源名称", "Source")}</th><th>${t("处理状态", "Status")}</th><th class="km-enabled-col">${t("参与回答", "Used for answers")}</th><th class="km-meta-col">${t("内容规模", "Content")}</th><th class="km-date-col">${t("最近更新", "Updated")}</th><th>${t("操作", "Actions")}</th></tr></thead><tbody>${page.map((k) => `<tr class="${v.selected.has(k.id) ? "selected" : ""}"><td class="km-check"><input type="checkbox" data-source-check="${k.id}" aria-label="${t("选择：", "Select: ") + esc(k.title)}" ${v.selected.has(k.id) ? "checked" : ""}></td><td><div class="km-source-name"><span class="file-icon">${I(kinds[k.kind]?.[2] || "file")}</span><span>${action(mark(k.title, v.q), "preview-source", b, k, "km-title", `title="${esc(k.title)}"`)}<small>${humanType(k)} · ${esc(k.source || k.fileName || t("上传或粘贴的知识", "Uploaded or pasted knowledge"))}</small><span class="km-source-folder">${I("folder")}${esc(folderName(b, folderOf(b, k)))}</span></span></div></td><td>${badge(k)}${k.status === "failed" ? `<small class="km-failure" title="${esc(k.error || "")}">${esc(k.error || t("处理失败，可重试", "Processing failed. Retry available."))}</small>` : ""}</td><td class="km-enabled-col">${v.trash ? '<span class="muted">—</span>' : `<button class="switch" role="switch" aria-label="${t("参与回答：", "Use in answers: ") + esc(k.title)}" aria-checked="${enabled(k)}" data-action="knowledge-toggle" data-dot="${b.id}" data-id="${k.id}"></button><small class="km-scope-label">${enabled(k) ? (k.status === "ready" ? t("已启用", "Enabled") : t("就绪后生效", "When ready")) : t("已暂停", "Paused")}</small>`}</td><td class="km-meta-col"><span>${k.pages?.length ? k.pages.length + " " + t("页", "pages") : k.files?.length ? k.files.length + " " + t("个文件", "files") : k.kind === "audio" ? k.duration || "18:24" : n((k.content || sampleText(k)).length) + " " + t("字符", "chars")}</span><small>${chunks(k).length} ${t("个检索片段", "chunks")}</small></td><td class="km-date-col">${updated(k)}</td><td><div class="km-row-actions">${action(I("external") + t("预览", "Preview"), "preview-source", b, k, "btn ghost sm")}${v.trash ? action(t("恢复", "Restore"), "knowledge-restore", b, k) : iconBtn("dots", t("更多操作：", "More actions: ") + k.title, "source-menu", `data-dot="${b.id}" data-id="${k.id}"`)}</div></td></tr>`).join("") || `<tr><td colspan="7"><div class="km-empty">${I(v.trash ? "trash" : "search")}<h3>${v.trash ? t("回收站是空的", "Trash is empty") : t("没有匹配的知识来源", "No matching sources")}</h3><p>${t("试试其他关键词或清除筛选。", "Try another keyword or clear the filters.")}</p>${action(t("清除筛选", "Clear filters"), "knowledge-reset", b)}</div></td></tr>`}</tbody></table></div><div class="km-pagination"><span>${data.length ? t("第 " + ((v.page - 1) * v.size + 1) + "–" + Math.min(v.page * v.size, data.length) + " 项，共 " + data.length + " 项", (v.page - 1) * v.size + 1 + "–" + Math.min(v.page * v.size, data.length) + " of " + data.length) : t("共 0 项", "0 sources")}</span><div class="flex"><label>${t("每页", "Rows")} <select id="km-page-size" aria-label="${t("每页显示数量", "Rows per page")}">${[20, 50, 100].map((size) => `<option value="${size}" ${v.size === size ? "selected" : ""}>${size}</option>`).join("")}</select></label>${action(I("chevron"), "knowledge-page", b, null, "icon-btn flip", `data-value="${v.page - 1}" aria-label="${t("上一页", "Previous page")}" ${v.page === 1 ? "disabled" : ""}`)}<span class="mono">${v.page} / ${pages}</span>${action(I("chevron"), "knowledge-page", b, null, "icon-btn", `data-value="${v.page + 1}" aria-label="${t("下一页", "Next page")}" ${v.page === pages ? "disabled" : ""}`)}</div></div>`;
  }
  function folderNavigation(b) {
    const v = view(b),
      data = rootRows(b);
    const item = (id, label, count, editable = false) =>
      `<div class="km-folder-row ${v.folder === id ? "active" : ""}">${action(I(id === "all" ? "layers" : "folder") + `<span>${esc(label)}</span><small>${count}</small>`, "knowledge-folder", b, null, "km-folder-link", `data-value="${esc(id)}" aria-pressed="${v.folder === id}" title="${esc(label)}"`)}${editable ? iconBtn("dots", t("管理文件夹：", "Manage folder: ") + label, "knowledge-folder-menu", `data-dot="${b.id}" data-folder="${esc(id)}"`) : ""}</div>`;
    return `<aside class="km-folders" aria-label="${t("知识文件夹", "Knowledge folders")}"><div class="km-folders-head"><strong>${t("文件夹", "Folders")}</strong>${iconBtn("plus", t("新建文件夹", "New folder"), "knowledge-folder-create", `data-dot="${b.id}"`)}</div><nav aria-label="${t("按文件夹筛选", "Filter by folder")}">${item("all", t("全部知识", "All sources"), data.length)}${item("unfiled", t("未分组", "Unfiled"), data.filter((k) => folderOf(b, k) === "unfiled").length)}<div class="km-folder-divider"></div>${folders(
      b,
    )
      .map((f) =>
        item(
          f.id,
          f.name,
          data.filter((k) => folderOf(b, k) === f.id).length,
          true,
        ),
      )
      .join(
        "",
      )}</nav>${!folders(b).length ? `<p class="km-folders-empty">${t("按主题或项目整理知识，从第一个文件夹开始。", "Organize sources by topic or project. Create your first folder.")}</p>` : ""}${action(I("plus") + t("新建文件夹", "New folder"), "knowledge-folder-create", b, null, "km-folder-new")}<p class="km-folders-hint">${t("选择文件夹后添加知识，会自动归入该文件夹。", "New sources are added to the selected folder.")}</p></aside>`;
  }
  function manager(b) {
    const v = view(b),
      scope = folderRows(b, all(b)),
      counts = {
        all: scope.length,
        ready: scope.filter((k) => k.status === "ready").length,
        processing: scope.filter(isBusy).length,
        failed: scope.filter((k) => k.status === "failed").length,
        paused: scope.filter((k) => !enabled(k)).length,
      };
    return shell(
      `<div class="km-page" data-knowledge-manager="${b.id}"><div class="km-page-head"><div><p class="eyebrow">YOUR SOURCES. CLEARLY ORGANIZED.</p><h1>${t("知识管理", "Knowledge library")} <span class="mono">${all(b).length}</span></h1><p>${t("在这里查看、查找和管理来源。只有已就绪且启用的知识会参与回答。", "Find and manage sources. Only ready, enabled knowledge contributes to answers.")}</p></div><div class="flex">${btn(I("plus") + t("添加知识", "Add knowledge"), "add-knowledge", "", `data-id="${b.id}"`)}</div></div><div class="km-library-layout">${folderNavigation(b)}<div class="km-library-content"><div class="km-folder-context">${I(v.folder === "all" ? "layers" : "folder")}<strong>${esc(folderName(b, v.folder))}</strong><span>${folderRows(b).length} ${t("个来源", "sources")}</span></div><div class="km-state-tabs">${[
        ["all", t("全部知识", "All sources")],
        ["ready", t("已就绪", "Ready")],
        ["processing", t("处理中", "Processing")],
        ["failed", t("失败", "Failed")],
        ["paused", t("已暂停", "Paused")],
      ]
        .map(([status, label]) =>
          action(
            label + `<span>${counts[status]}</span>`,
            "knowledge-status",
            b,
            null,
            "km-state-tab " + (!v.trash && v.status === status ? "active" : ""),
            `data-value="${status}" aria-pressed="${!v.trash && v.status === status}"`,
          ),
        )
        .join(
          "",
        )}<div class="grow"></div>${action(I("trash") + t("回收站", "Trash") + `<span>${folderRows(b, b.knowledgeTrash || []).length}</span>`, "knowledge-trash-view", b, null, "km-state-tab " + (v.trash ? "active" : ""), `aria-pressed="${v.trash}"`)}</div><form class="km-filters" id="knowledge-filter-form" data-dot="${b.id}"><div class="km-search">${I("search")}<input id="km-search" name="q" type="search" aria-label="${t("搜索知识来源", "Search knowledge sources")}" value="${esc(v.q)}" placeholder="${t("搜索名称、链接或正文内容…", "Search names, links, or source content…")}" autocomplete="off"><kbd>⌘ K</kbd></div><select id="km-kind" name="kind" aria-label="${t("按知识类型筛选", "Filter by source type")}"><option value="all">${t("全部类型", "All types")}</option>${Object.entries(
        kinds,
      )
        .map(
          ([key, [zh, en]]) =>
            `<option value="${key}" ${v.kind === key ? "selected" : ""}>${t(zh, en)}</option>`,
        )
        .join(
          "",
        )}</select><select id="km-sort" name="sort" aria-label="${t("知识排序", "Sort sources")}">${[
        ["new", t("最近更新", "Recently updated")],
        ["old", t("最早添加", "Oldest first")],
        ["title", t("名称排序", "Name")],
      ]
        .map(
          ([key, label]) =>
            `<option value="${key}" ${v.sort === key ? "selected" : ""}>${label}</option>`,
        )
        .join(
          "",
        )}</select>${v.q || v.kind !== "all" || v.status !== "all" ? action(t("清除", "Clear"), "knowledge-reset", b, null, "btn ghost sm") : ""}</form><section class="card km-results" id="km-results">${resultHTML(b)}</section><div class="km-page-note"><span>${I("shield")}${t("知识正文仅自己可预览；公开页只展示来源标题。", "Full source previews are private. Public pages only show titles.")}</span><span>${t("整站和仓库的子页面、文件可在预览内继续查找。", "Find website pages and repository files inside each preview.")}</span></div></div></div></div>`,
    );
  }
  function sampleText(k) {
    if (k.content) return k.content;
    return t(
      `# ${k.title}\n\n这是一份用于设计评审的示例解析正文。\n\n## 核心内容\n\n知识来源保留清晰的结构与定位。每次回答都可以追溯到具体的页码、时间戳、文件路径或原始网页。\n\n在管理页中可以搜索来源、按类型与状态筛选、检查处理结果，并一次管理多份知识。\n\n## 使用建议\n\n先确认来源是否已就绪，再检查内容是否完整。需要更新时重新处理；不希望参与回答时暂停该来源，仍可保留和预览。\n\n这里只演示阅读与管理交互，没有抓取外部页面或生成真实转写。`,
      `# ${k.title}\n\nThis is illustrative extracted content for design review.\n\n## Key ideas\n\nSources retain their structure and location. Answers can be traced to a page, timestamp, repository path, or original URL.\n\nSearch and filter sources in the library, inspect processing results, and manage multiple sources at once.\n\n## Suggested workflow\n\nCheck readiness and completeness. Reprocess outdated sources, or pause a source to retain it without using it for answers.\n\nNo external crawling or transcription occurs in this prototype.`,
    );
  }
  function chunks(k) {
    const text = sampleText(k);
    const paragraphs = text.split(/\n\s*\n/).filter(Boolean),
      out = [];
    for (const paragraph of paragraphs) {
      for (let i = 0; i < paragraph.length; i += 800)
        out.push({
          text: paragraph.slice(i, i + 800),
          locator:
            k.locator ||
            t("段落 " + (out.length + 1), "Paragraph " + (out.length + 1)),
        });
    }
    return out;
  }
  function plain(text, q) {
    return String(text)
      .split("\n")
      .map((line) =>
        line.startsWith("### ")
          ? `<h4>${mark(line.slice(4), q)}</h4>`
          : line.startsWith("## ")
            ? `<h3>${mark(line.slice(3), q)}</h3>`
            : line.startsWith("# ")
              ? `<h2>${mark(line.slice(2), q)}</h2>`
              : line.trim()
                ? `<p>${mark(line, q)}</p>`
                : '<div class="kp-paragraph-gap"></div>',
      )
      .join("");
  }
  function sourceChildren(k) {
    if (k.kind === "github")
      return k.files?.length
        ? k.files
        : [
            { path: "README.md", content: sampleText(k) },
            {
              path: "docs/getting-started.md",
              content: t(
                "# 开始使用\n\n创建一个 Ree，添加知识，提出你的第一个问题。",
                "# Getting started\n\nCreate a Ree, add knowledge, and ask your first question.",
              ),
            },
            {
              path: "src/components/button.tsx",
              content:
                'type Props = { label: string; disabled?: boolean };\n\nexport function Button({ label, disabled }: Props) {\n  return (\n    <button disabled={disabled} type="button">\n      {label}\n    </button>\n  );\n}',
            },
          ];
    if (k.kind === "site")
      return k.pages?.length
        ? k.pages
        : Array.from({ length: 12 }, (_, i) => ({
            title: t(
              "使用指南 · 第 " + (i + 1) + " 页",
              "Guide · Page " + (i + 1),
            ),
            url: (k.source || "https://docs.example.com") + "/guide/" + (i + 1),
            content: sampleText(k),
          }));
    return [];
  }
  function previewView(b, k, reset = false) {
    if (!preview || preview.dot !== b.id || preview.id !== k.id || reset)
      preview = {
        dot: b.id,
        id: k.id,
        tab: "content",
        q: "",
        childQ: "",
        child: 0,
        page: 1,
        hit: 0,
      };
    return preview;
  }
  function contentHTML(b, k) {
    const p = previewView(b, k),
      data = files.get(k.id);
    if (isBusy(k) && p.tab !== "activity")
      return `<div class="kp-status-state"><i class="spinner"></i><h3>${t("正在整理这份知识", "Preparing this source")}</h3><p>${t("完成后可预览正文与检索片段。", "Content and retrieval chunks will be available when ready.")}</p><div class="kp-processing-steps"><span>${I("check")}${t("来源已添加", "Source added")}</span><span class="active"><i class="spinner"></i>${t("解析、切块与索引中", "Parsing, chunking & indexing")}</span><span>${t("等待就绪", "Awaiting completion")}</span></div></div>`;
    if (k.status === "failed" && p.tab !== "activity")
      return `<div class="kp-status-state failed">${I("info")}<h3>${t("这份知识还没有处理成功", "This source could not be processed")}</h3><p>${esc(k.error || t("暂时无法读取来源。", "Source could not be read."))}</p>${action(I("refresh") + t("重试处理 · 20 credits", "Retry · 20 credits"), "knowledge-refresh", b, k)}<small>${t("失败时预留的费用已退回。可检查来源后重试或移到回收站。", "Reserved credits were released on failure. Check the source, retry, or move it to trash.")}</small></div>`;
    if (p.tab === "chunks")
      return `<div class="kp-chunks"><div class="kp-content-intro"><h3>${t("Ree 可检索到的文本片段", "Retrievable text passages")}</h3><p>${t("检查切块是否保留了完整语境。此处显示原型中已保存文本的分段，不运行真实向量检索。", "Inspect passage boundaries. This prototype segments saved text without running vector retrieval.")}</p></div>${chunks(
        k,
      )
        .map(
          (c, i) =>
            `<article><div><span class="mono">CHUNK ${String(i + 1).padStart(3, "0")}</span><span>${esc(c.locator)} · ${c.text.length} ${t("字符", "characters")}</span></div><p>${mark(c.text, p.q)}</p></article>`,
        )
        .join("")}</div>`;
    if (p.tab === "activity")
      return `<div class="kp-activity"><h3>${t("处理记录", "Processing activity")}</h3>${(
        k.activity || [
          {
            at: k.createdAt || "2026-10-30T08:24:00Z",
            label: t("来源已添加", "Source added"),
          },
          {
            at: k.updatedAt || "2026-10-30T08:25:00Z",
            label: t(
              "解析完成，文本已就绪 · 演示",
              "Parsing and indexing completed · Demo",
            ),
          },
        ]
      )
        .slice()
        .reverse()
        .map(
          (a) =>
            `<div>${I("check")}<span><strong>${esc(a.label)}</strong><small>${updated({ updatedAt: a.at })}</small></span></div>`,
        )
        .join(
          "",
        )}<p class="demo-label">${t("这里保留本地原型的操作记录。没有调用真实解析或索引服务。", "Local prototype events only. No live parsing or indexing service is contacted.")}</p></div>`;
    if (p.tab === "original" && data?.url) {
      if (k.kind === "audio")
        return `<audio controls src="${data.url}" class="kp-audio-player" aria-label="${t("原始音频", "Original audio")}"></audio>`;
      return `<iframe class="kp-pdf-frame" src="${data.url}#page=${p.page}" title="${esc(k.title)}" sandbox="allow-same-origin"></iframe>`;
    }
    if (k.kind === "site" || k.kind === "github") {
      const children = sourceChildren(k),
        filtered = children
          .map((c, i) => ({ ...c, index: i }))
          .filter((c) =>
            (c.path || c.title || c.url)
              .toLowerCase()
              .includes(p.childQ.toLowerCase()),
          ),
        child = children[p.child] || children[0];
      return `<div class="kp-collection"><aside><div class="kp-child-count">${I(k.kind === "site" ? "globe" : "github")}<strong>${children.length} ${k.kind === "site" ? t("个页面", "pages") : t("个文件", "files")}</strong></div><div class="kp-child-search">${I("search")}<input id="kp-child-search" aria-label="${t("查找子页面或文件", "Find pages or files")}" placeholder="${t("查找页面或路径…", "Find a page or path…")}" value="${esc(p.childQ)}"></div><div class="kp-child-list">${
        filtered
          .slice(0, 200)
          .map((c) =>
            action(
              I(k.kind === "site" ? "file" : "code") +
                `<span>${mark(c.path || c.title, p.childQ)}</span>`,
              "knowledge-child",
              b,
              k,
              "kp-child " + (c.index === p.child ? "active" : ""),
              `data-value="${c.index}" title="${esc(c.path || c.title)}"`,
            ),
          )
          .join("") ||
        `<p class="kp-child-empty">${t("没有匹配的页面或文件", "No matching pages or files")}</p>`
      }</div></aside><div class="kp-child-content"><div class="kp-child-location">${I(k.kind === "site" ? "globe" : "code")}<span>${esc(child?.url || child?.path || "")}</span></div>${
        k.kind === "github"
          ? `<div class="kp-code">${(child?.content || sampleText(k))
              .split("\n")
              .map(
                (line, i) =>
                  `<div><span class="mono">${i + 1}</span><code>${mark(line, p.q)}</code></div>`,
              )
              .join("")}</div>`
          : `<article class="kp-document"><h2>${esc(child?.title || k.title)}</h2>${plain(child?.content || sampleText(k), p.q)}</article>`
      }</div></div>`;
    }
    if (k.kind === "audio") {
      const transcript = k.transcript || [
        {
          time: 0,
          text: t(
            "今天我们从一个真实的问题开始：如何让已有知识更容易被使用。",
            "Let’s start with a real question: how can existing knowledge become more useful?",
          ),
        },
        { time: 46, text: sampleText(k) },
        {
          time: 154,
          text: t(
            "来源、结构和引用需要一起保留，让每一次回答都有可以验证的依据。",
            "Keep sources, structure, and citations connected so every answer can be verified.",
          ),
        },
      ];
      return `<div class="kp-audio"><div class="kp-audio-heading">${I("audio")}<div><strong>${esc(k.title)}</strong><small>${k.duration || "18:24"} · ${t("时间戳转写", "Timestamped transcript")}</small></div></div>${data?.url ? `<audio id="kp-audio-player" class="kp-audio-player" controls src="${data.url}"></audio>` : `<div class="demo-label">${t("示例转写内容；此来源没有保留原始音频文件。", "Illustrative transcript. No original audio is retained for this sample.")}</div>`}<div class="kp-transcript">${transcript.map((seg, i) => `<div><button class="mono" data-action="knowledge-seek" data-dot="${b.id}" data-id="${k.id}" data-value="${seg.time}">${String(Math.floor(seg.time / 60)).padStart(2, "0")}:${String(seg.time % 60).padStart(2, "0")}</button><p>${mark(seg.text, p.q)}</p></div>`).join("")}</div></div>`;
    }
    return `<div class="kp-document-wrap">${k.kind === "document" && /\.pdf$/i.test(k.fileName || k.title) ? `<div class="kp-page-label">${I("file")}${t("解析正文", "Extracted text")} · ${esc(k.locator || t("第 1 页", "Page 1"))}</div>` : ""}<article class="kp-document">${plain(sampleText(k), p.q)}</article>${k.previewLimited ? `<div class="demo-label">${t("当前只保留部分解析文本；原文件可在本次上传会话中下载。", "Only part of the extracted text is retained. The original is downloadable in this upload session.")}</div>` : ""}</div>`;
  }
  function previewBody(b, k) {
    const p = previewView(b, k),
      data = files.get(k.id),
      isTrash = (b.knowledgeTrash || []).some((x) => x.id === k.id),
      fixture =
        !k.content ||
        k.demo ||
        (k.kind === "github" && !k.files?.length) ||
        (k.kind === "site" && !k.pages?.length) ||
        (k.kind === "audio" && !k.transcript?.length);
    return `<div class="kp-root" data-knowledge-preview="${k.id}" data-dot="${b.id}"><div class="kp-toolbar"><div class="kp-tabs">${[["content", t("内容预览", "Content")], ["chunks", t("检索片段", "Chunks")], ["activity", t("处理记录", "Activity")], ...(data?.url && (/\.pdf$/i.test(k.fileName || k.title) || k.kind === "audio") ? [["original", t("原文件", "Original")]] : [])].map(([tab, label]) => action(label, "knowledge-preview-tab", b, k, "kp-tab " + (p.tab === tab ? "active" : ""), `data-value="${tab}" aria-pressed="${p.tab === tab}"`)).join("")}</div><div class="kp-find">${I("search")}<input id="kp-find" aria-label="${t("在内容中查找", "Find in content")}" placeholder="${t("在内容中查找…", "Find in content…")}" value="${esc(p.q)}"><span id="kp-match-count"></span>${action(I("down"), "knowledge-next-hit", b, k, "icon-btn", `aria-label="${t("下一个匹配", "Next match")}"`)}</div></div><div class="kp-workspace"><div class="kp-content" id="kp-content">${contentHTML(b, k)}</div><aside class="kp-details"><div class="between"><h3>${t("来源详情", "Source details")}</h3>${badge(k)}</div>${isTrash ? `<div class="kp-trash-notice">${I("trash")}${t("已移到回收站，不参与回答。", "In trash. Excluded from answers.")}</div>` : `<div class="kp-scope"><div><strong>${t("参与 Ree 回答", "Use in answers")}</strong><p>${enabled(k) ? t("就绪后可被引用", "Available when ready") : t("暂停使用，保留内容", "Paused, content retained")}</p></div><button class="switch" role="switch" aria-label="${t("此来源参与回答", "Use this source in answers")}" aria-checked="${enabled(k)}" data-action="knowledge-toggle" data-dot="${b.id}" data-id="${k.id}"></button></div>`}<dl><dt>${t("文件夹", "Folder")}</dt><dd>${esc(folderName(b, folderOf(b, k)))}</dd><dt>${t("类型", "Type")}</dt><dd>${humanType(k)}</dd>${k.fileName ? `<dt>${t("原文件名", "Original filename")}</dt><dd>${esc(k.fileName)}</dd>` : ""}<dt>${t("来源地址", "Source address")}</dt><dd>${esc(k.source || t("上传文件 / 本地文本", "Uploaded file / pasted text"))}</dd><dt>${t("定位", "Locator")}</dt><dd>${esc(k.locator || "—")}</dd><dt>${t("保存文本", "Saved text")}</dt><dd>${n((k.content || sampleText(k)).length)} ${t("字符", "characters")}</dd><dt>${t("检索片段", "Retrieval passages")}</dt><dd>${chunks(k).length}</dd><dt>${t("最近更新", "Last updated")}</dt><dd>${updated(k)}</dd></dl><div class="kp-detail-actions">${action(I("copy") + t("复制预览链接", "Copy preview link"), "knowledge-copy-link", b, k)}${data?.url ? action(I("download") + t("下载原文件", "Download original"), "knowledge-download", b, k) : ""}${action(I("text") + t("下载解析文本", "Download extracted text"), "knowledge-download-text", b, k)}${!isTrash ? action(I("folder") + t("移动到文件夹", "Move to folder"), "knowledge-move", b, k) + action(I("settings") + t("修改名称", "Rename"), "knowledge-rename", b, k) + action(I("refresh") + t("重新处理", "Reprocess"), "knowledge-refresh", b, k, "btn secondary sm", isBusy(k) ? "disabled" : "") : action(I("refresh") + t("恢复来源", "Restore source"), "knowledge-restore", b, k)}</div>${fixture ? `<div class="demo-label">${t("示例解析内容，用于演示预览交互。真实上传的文本与 Markdown 会显示已保存的原文；PDF / 音频原文件仅在当前上传会话保留。", "Illustrative extracted content. Uploaded text and Markdown show saved source text; original PDF/audio remain available for this upload session only.")}</div>` : ""}</aside></div></div>`;
  }
  function previewNav(b, k) {
    const candidates = rows(b),
      idx = candidates.findIndex((x) => x.id === k.id),
      total = candidates.length || 1;
    return `<div class="kp-nav"><span>${idx < 0 ? "1" : idx + 1} / ${total} ${t("个来源", "sources")}</span><div class="flex">${action(I("chevron") + t("上一篇", "Previous"), "knowledge-adjacent", b, k, "btn secondary sm", `data-value="-1" ${idx <= 0 ? "disabled" : ""}`)}${action(t("下一篇", "Next") + I("chevron"), "knowledge-adjacent", b, k, "btn secondary sm", `data-value="1" ${idx < 0 || idx >= total - 1 ? "disabled" : ""}`)}${L("/dots/" + b.id + "/knowledge", t("返回知识管理", "Back to library"), "btn secondary sm")}</div></div>`;
  }
  function openPreview(b, k, reset = true) {
    if (!owner(b)) return;
    previewView(b, k, reset);
    modal(
      esc(k.title),
      `${humanType(k)} · ${t("仅所有者可预览", "Owner-only preview")}`,
      previewBody(b, k),
      previewNav(b, k),
      { wide: true },
    );
    document.querySelector(".modal")?.classList.add("kp-modal");
    paintMatches();
  }
  function previewPage(b, k) {
    previewView(b, k);
    return shell(
      `<div class="kp-page"><div class="kp-page-head"><span class="file-icon">${I(kinds[k.kind]?.[2] || "file")}</span><div><h1>${esc(k.title)}</h1><p>${esc(title(b))} · ${t("知识预览", "Source preview")}</p></div></div><div class="card kp-page-card">${previewBody(b, k)}</div></div>`,
    );
  }
  function findSource(b, id) {
    return (
      all(b).find((k) => k.id === id) ||
      (b.knowledgeTrash || []).find((k) => k.id === id)
    );
  }
  function resolve(path) {
    const match = path.match(/^\/dots\/([^/]+)\/knowledge(?:\/([^/]+))?$/);
    if (!match) return null;
    if (!S().signed)
      return { redirect: "/login?next=" + encodeURIComponent(path) };
    const b = dotById(match[1]);
    if (!owner(b)) return { redirect: "/dots" };
    const k = match[2] ? findSource(b, match[2]) : null;
    if (match[2] && !k)
      return {
        html: shell(
          `<div class="page"><div class="card empty">${I("file")}<h2>${t("这份来源不存在", "Source unavailable")}</h2><p>${t("来源可能已被移除。", "The source may have been removed.")}</p>${L("/dots/" + b.id + "/knowledge", t("返回知识管理", "Back to library"), "btn secondary")}</div></div>`,
        ),
        title: t("来源不存在", "Source unavailable"),
      };
    return {
      html: k ? previewPage(b, k) : manager(b),
      title: t(
        k ? "知识预览" : "知识管理",
        k ? "Source preview" : "Knowledge library",
      ),
    };
  }
  function paint(b, keepScroll = false) {
    const region = document.querySelector("#km-results");
    if (!region) return;
    const scroll = keepScroll
      ? region.querySelector(".km-scroll")?.scrollTop || 0
      : 0;
    region.innerHTML = resultHTML(b);
    if (keepScroll) region.querySelector(".km-scroll").scrollTop = scroll;
    syncSelection(b);
    syncURL(b);
  }
  function syncSelection(b) {
    const v = view(b),
      page = pageRows(b),
      selected = page.filter((k) => v.selected.has(k.id)).length,
      header = document.querySelector("#km-select-page");
    if (header) {
      header.checked = !!page.length && selected === page.length;
      header.indeterminate = selected > 0 && selected < page.length;
    }
    document.querySelectorAll("[data-source-check]").forEach((el) => {
      el.checked = v.selected.has(el.dataset.sourceCheck);
      el.closest("tr").classList.toggle("selected", el.checked);
    });
  }
  function paintSelection(b) {
    const old = document.querySelector("#km-selection");
    if (old) {
      old.nextElementSibling?.classList.contains("km-select-all") &&
        old.nextElementSibling.remove();
      old.outerHTML = toolbar(b);
    }
    syncSelection(b);
  }
  function paintMatches() {
    const root = document.querySelector("[data-knowledge-preview]");
    if (!root) return;
    const matches = [...root.querySelectorAll(".kp-content mark")],
      label = root.querySelector("#kp-match-count");
    if (label)
      label.textContent = preview?.q
        ? matches.length + " " + t("处", "matches")
        : "";
  }
  function paintContent(b, k) {
    const el = document.querySelector("#kp-content");
    if (el) el.innerHTML = contentHTML(b, k);
    paintMatches();
  }
  function refreshUI(b, k = null) {
    if (document.querySelector(".kp-modal") && preview?.dot === b.id) {
      const source = k || findSource(b, preview.id);
      if (source && source.id === preview.id) openPreview(b, source, false);
      render();
    } else render();
  }
  function selected(b) {
    const ids = view(b).selected;
    return rootRows(b).filter((k) => ids.has(k.id));
  }
  function activity(k, label) {
    k.activity ??= [];
    k.activity.push({ at: stamp(), label });
    k.updatedAt = stamp();
  }
  function selectionReview(items) {
    return `<div class="km-operation-list">${items
      .slice(0, 5)
      .map(
        (k) =>
          `<p>${I(kinds[k.kind]?.[2] || "file")}<span>${esc(k.title)}</span></p>`,
      )
      .join(
        "",
      )}${items.length > 5 ? `<small>${t("等 " + items.length + " 个来源", "and " + (items.length - 5) + " more sources")}</small>` : ""}</div>`;
  }
  function changeScope(b, items, value) {
    if (U().busy)
      return toast(
        t(
          "请等待当前回答完成后调整知识范围。",
          "Wait for the current answer before changing source scope.",
        ),
      );
    for (const k of items) {
      k.enabled = value;
      activity(
        k,
        value
          ? t("恢复参与回答", "Enabled for answers")
          : t("暂停参与回答", "Paused for answers"),
      );
    }
    save();
    if (document.querySelector(".ks-menu-modal")) closeModal();
    refreshUI(b, items.length === 1 ? items[0] : null);
    toast(
      t(
        "已更新 " + items.length + " 个来源的回答范围。",
        "Answer scope updated for " + items.length + " source(s).",
      ),
    );
  }
  function moveTrash(b, items) {
    if (!items.length) return;
    if (U().busy)
      return toast(t("请等待当前回答结束", "Wait for the current answer"));
    if (items.some(isBusy))
      return toast(
        t(
          "所选来源中有正在处理的项目，请先取消选择。",
          "Deselect sources that are still processing.",
        ),
      );
    confirmModal(
      t(
        "将 " + items.length + " 个来源移到回收站？",
        "Move " + items.length + " source(s) to trash?",
      ),
      selectionReview(items) +
        `<p class="form-hint">${t("这些知识将不再参与新回答，历史对话保留。你可以在回收站恢复；已有处理费用不会退回。", "These sources stop contributing to new answers. History remains. Restore them from trash; previous processing charges are not refunded.")}</p>`,
      t("移到回收站", "Move to trash"),
      () => {
        b.knowledgeTrash ??= [];
        for (const k of items) {
          k.deletedAt = stamp();
          k.originalIndex = all(b).indexOf(k);
          activity(k, t("移到回收站", "Moved to trash"));
          if (!b.knowledgeTrash.some((x) => x.id === k.id))
            b.knowledgeTrash.push(k);
        }
        const ids = new Set(items.map((k) => k.id));
        b.knowledge = all(b).filter((k) => !ids.has(k.id));
        view(b).selected.clear();
        save();
        render();
        toast(
          t(
            "已移到回收站，可随时恢复。",
            "Moved to trash. You can restore these sources.",
          ),
        );
      },
      true,
    );
  }
  function restore(b, items) {
    for (const k of items) {
      delete k.deletedAt;
      activity(k, t("从回收站恢复", "Restored from trash"));
      if (!all(b).some((x) => x.id === k.id))
        b.knowledge.splice(
          Math.min(k.originalIndex ?? all(b).length, all(b).length),
          0,
          k,
        );
    }
    const ids = new Set(items.map((k) => k.id));
    b.knowledgeTrash = (b.knowledgeTrash || []).filter((k) => !ids.has(k.id));
    view(b).selected.clear();
    save();
    if (document.querySelector(".kp-modal")) {
      closeModal();
      render();
    } else render();
    toast(
      t(
        "已恢复 " + items.length + " 个来源。",
        "Restored " + items.length + " source(s).",
      ),
    );
  }
  function refreshSources(b, items) {
    if (!items.length) return;
    if (U().busy)
      return toast(t("请等待当前回答完成", "Wait for the current answer"));
    if (items.some(isBusy))
      return toast(
        t(
          "所选来源中有正在处理的项目，请先取消选择。",
          "Deselect sources that are still processing.",
        ),
      );
    if (items.some((k) => k.private && k.kind === "github") && !S().github)
      return toast(
        t(
          "私有仓库需要先连接 GitHub。",
          "Connect GitHub before refreshing private repositories.",
        ),
      );
    const cost = items.length * 20;
    confirmModal(
      t(
        "重新处理 " + items.length + " 个来源？",
        "Reprocess " + items.length + " source(s)?",
      ),
      selectionReview(items) +
        `<div class="estimate"><span>${t("本次模拟预留费用", "Demo processing reservation")}</span><strong>${n(cost)} credits</strong></div><p class="form-hint mt16">${t("每份来源演示费用 20 credits。先预留总费用，逐个处理；失败的来源分别退回。", "20 demo credits per source. Reserve the total, process each source, and refund failures individually.")}</p>`,
      t("确认并处理", "Confirm & reprocess"),
      () => {
        if (!debit(cost))
          return toast(t("余额不足，请充值。", "Insufficient credits."));
        const allocation = { ...U().lastDeduction };
        for (const k of items) {
          const hold = {};
          let amount = 20;
          for (const bucket of [
            "planCredits",
            "welcomeCredits",
            "packCredits",
            "earnedCredits",
          ]) {
            const used = Math.min(allocation[bucket] || 0, amount);
            hold[bucket] = used;
            allocation[bucket] = (allocation[bucket] || 0) - used;
            amount -= used;
            if (!amount) break;
          }
          k.status = "processing";
          k.hold = hold;
          k.processingCost = 20;
          delete k.error;
          activity(
            k,
            t(
              "已预留 20 credits，开始重新处理",
              "20 credits reserved; reprocessing started",
            ),
          );
          creditEntry(
            k.title + " · " + t("重新处理", "Reprocess"),
            -20,
            "knowledge",
          );
          scheduleProcessing(b, k, 20, false);
        }
        view(b).selected.clear();
        save();
        render();
        toast(
          t(
            "已开始处理 " + items.length + " 个来源。",
            "Started processing " + items.length + " source(s).",
          ),
        );
      },
    );
  }
  function renameModal(b, k) {
    modal(
      t("修改来源名称", "Rename source"),
      t(
        "只修改显示名称，不改变原文件或来源地址。",
        "Changes the display name, not the original file or URL.",
      ),
      `<form id="knowledge-rename-form" data-dot="${b.id}" data-id="${k.id}"><div class="field"><label for="knowledge-name">${t("来源名称", "Source name")}</label><input id="knowledge-name" name="title" value="${esc(k.title)}" maxlength="200" required></div></form>`,
      cancelButton() +
        submitButton(t("保存名称", "Save name"), "knowledge-rename-form"),
    );
  }
  function sourceMenu(b, k) {
    const trash = (b.knowledgeTrash || []).some((x) => x.id === k.id);
    modal(
      esc(k.title),
      humanType(k),
      `<div class="ks-action-menu">${action(I("external") + t("预览内容", "Preview content"), "preview-source", b, k, "ks-menu-item")}${trash ? action(I("refresh") + t("恢复来源", "Restore source"), "knowledge-restore", b, k, "ks-menu-item") : action(I("folder") + t("移动到文件夹", "Move to folder"), "knowledge-move", b, k, "ks-menu-item") + action(I("settings") + t("修改名称", "Rename"), "knowledge-rename", b, k, "ks-menu-item") + action(I(enabled(k) ? "pause" : "play") + (enabled(k) ? t("暂停参与回答", "Pause for answers") : t("恢复参与回答", "Enable for answers")), "knowledge-toggle", b, k, "ks-menu-item") + action(I("refresh") + t("重新处理 · 20 credits", "Reprocess · 20 credits"), "knowledge-refresh", b, k, "ks-menu-item", isBusy(k) ? "disabled" : "") + action(I("trash") + t("移到回收站", "Move to trash"), "knowledge-trash", b, k, "ks-menu-item danger-text", isBusy(k) ? "disabled" : "")}</div>`,
      "",
    );
    document.querySelector(".modal")?.classList.add("ks-menu-modal");
  }
  function buildDemo() {
    let b = dotById("knowledge-demo");
    if (b && S().dots.some((x) => x.id === b.id)) {
      go("/dots/" + b.id + "/knowledge");
      return;
    }
    const types = ["document", "page", "github", "text", "audio", "site"],
      topics = [
        "设计系统",
        "用户研究",
        "产品策略",
        "组件规范",
        "内容表达",
        "知识问答",
        "体验评估",
        "团队协作",
      ];
    b = {
      id: "knowledge-demo",
      slug: "knowledge-management-demo",
      name: "知识管理 · 规模演示",
      enName: "Knowledge library · Scale demo",
      description:
        "独立的 128 来源演示，包含整站页面、仓库文件与多种处理状态。",
      enDescription:
        "A separate 128-source demo with pages, repository files and status examples.",
      tags: ["产品设计"],
      icon: "layers",
      color: "",
      owner: "me",
      fee: 0,
      public: false,
      answers: 0,
      rating: 0,
      samples: ["如何组织一个设计系统？", "这些知识包含哪些产品研究方法？"],
      knowledge: [],
      knowledgeDemo: true,
    };
    for (let i = 0; i < 128; i++) {
      const kind = types[i % 6],
        topic = topics[i % 8],
        k = {
          id: "scale-" + String(i + 1).padStart(3, "0"),
          kind,
          title:
            kind === "document"
              ? `${topic} · 实践手册 ${String(i + 1).padStart(3, "0")}.${i % 2 ? "md" : "pdf"}`
              : kind === "github"
                ? `design-team / ${["components", "design-tokens", "product-docs"][i % 3]}-${i + 1}`
                : kind === "site"
                  ? `${topic} · 文档站 ${i + 1}`
                  : kind === "audio"
                    ? `${topic} · 团队讨论 ${i + 1}.m4a`
                    : `${topic} · ${kind === "page" ? "研究文章" : "工作笔记"} ${i + 1}`,
          status:
            i % 29 === 28 ? "failed" : i % 17 === 16 ? "processing" : "ready",
          enabled: i % 19 !== 18,
          source: ["page", "site"].includes(kind)
            ? `https://docs.example.com/${i % 2 ? "research" : "design"}/${i + 1}`
            : kind === "github"
              ? `https://github.com/example/design-docs-${i + 1}`
              : "",
          locator:
            kind === "audio"
              ? "02:34–03:08"
              : kind === "github"
                ? "README.md · L1–32"
                : t("第 1 节", "Section 1"),
          createdAt: new Date(
            Date.UTC(2026, 9, 31, 8, 0) - i * 3600000,
          ).toISOString(),
          updatedAt: new Date(
            Date.UTC(2026, 9, 31, 8, 0) - i * 3600000,
          ).toISOString(),
          demo: true,
        };
      k.content = `# ${topic}：${k.title}\n\n这是一份独立的规模演示资料，用于检查大量知识来源的组织、检索和预览体验。\n\n## 从问题开始\n\n先明确需要解决的用户问题，再收集有出处的事实和原始材料。围绕「${topic}」，记录背景、约束和判断依据。\n\n## 建立可使用的知识\n\n将内容整理为清晰的标题和段落，保留原始页面、文件路径、页码或时间戳。让每个片段都保有足够语境。\n\n## 实践与验证\n\n用真实问题检查内容覆盖范围。先验证来源是否可靠，再比较不同方案，记录决定、行动和后续更新。\n\n关键词：${topic}、设计系统、用户研究、版本管理、来源引用。`;
      if (k.status === "failed")
        k.error = t(
          "演示：来源暂时无法读取，请检查后重试。",
          "Demo: temporarily unreadable. Check and retry.",
        );
      if (kind === "site" && i === 5)
        k.pages = Array.from({ length: 148 }, (_, j) => ({
          title: `${topics[j % 8]} / ${String(j + 1).padStart(3, "0")}`,
          url: `https://docs.example.com/handbook/${j + 1}`,
          content: `# ${topics[j % 8]} · 第 ${j + 1} 页\n\n这是一条整站来源中的独立子页面，可通过左侧搜索快速找到。\n\n## 操作建议\n\n保留页面标题、原始 URL 和清晰的正文结构。针对具体问题，回到相关段落检查依据。\n\n本页关键词：${topics[j % 8]}、页面 ${j + 1}、实践。`,
        }));
      if (kind === "github" && i === 2)
        k.files = Array.from({ length: 117 }, (_, j) => ({
          path:
            j === 0
              ? "README.md"
              : `${j % 2 ? "docs" : "src/components"}/${["button", "dialog", "navigation", "forms", "typography"][j % 5]}-${String(j + 1).padStart(3, "0")}.${j % 2 ? "md" : "tsx"}`,
          content:
            j % 2
              ? `# 组件使用说明 ${j + 1}\n\n包含适用场景、交互状态和无障碍要求。`
              : `// Component ${j + 1}: illustrative source\ntype Props = { label: string; disabled?: boolean };\n\nexport function Component${j + 1}({ label, disabled }: Props) {\n  return <button disabled={disabled}>{label}</button>;\n}`,
        }));
      b.knowledge.push(k);
    }
    S().dots.push(b);
    save();
    go("/dots/" + b.id + "/knowledge");
    b.knowledge
      .filter(isBusy)
      .forEach((k, i) =>
        setTimeout(() => scheduleProcessing(b, k, 0, false), 8000 + i * 1000),
      );
    toast(
      t(
        "已创建独立的 128 来源演示，原 Ree 的知识未改变。",
        "Created a separate 128-source demo. Your original Ree is unchanged.",
      ),
    );
  }
  function download(name, text, type = "text/plain;charset=utf-8") {
    const url = URL.createObjectURL(new Blob([text], { type })),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function afterRender() {
    const tabs = document.querySelector(".ree-workspace-shell .dot-work-tabs");
    const activeTab = tabs?.querySelector('[aria-current="page"]');
    if (activeTab && window.matchMedia("(max-width: 760px)").matches) {
      const viewport = tabs.getBoundingClientRect();
      const active = activeTab.getBoundingClientRect();
      tabs.scrollLeft += Math.min(0, active.left - viewport.left) + Math.max(0, active.right - viewport.right);
    }
    const root = document.querySelector("[data-knowledge-manager]");
    if (root) {
      const b = dotById(root.dataset.knowledgeManager);
      if (b) syncSelection(b);
    }
    paintMatches();
  }
  function folderForm(b, folder = null) {
    modal(
      folder
        ? t("重命名文件夹", "Rename folder")
        : t("新建文件夹", "New folder"),
      title(b),
      `<form id="knowledge-folder-form" data-dot="${b.id}" data-folder="${folder?.id || ""}"><div class="field"><label for="km-folder-name">${t("文件夹名称", "Folder name")}</label><input id="km-folder-name" name="name" maxlength="40" value="${esc(folder?.name || "")}" placeholder="${t("例如：产品文档、用户研究", "e.g. Product docs, User research")}" required autofocus></div></form>`,
      cancelButton() +
        submitButton(t("保存文件夹", "Save folder"), "knowledge-folder-form"),
    );
  }
  function validFolderName(b, raw, except = "") {
    const name = String(raw || "")
      .trim()
      .replace(/\s+/g, " ");
    if (!name || name.length > 40) {
      toast(
        t(
          "请输入 1–40 个字符的文件夹名称。",
          "Enter a folder name of 1–40 characters.",
        ),
      );
      return null;
    }
    if (
      folders(b).some(
        (f) =>
          f.id !== except &&
          f.name.normalize("NFKC").toLocaleLowerCase() ===
            name.normalize("NFKC").toLocaleLowerCase(),
      )
    ) {
      toast(
        t(
          "此文件夹名称已存在，请换一个名称。",
          "A folder with this name already exists. Choose another name.",
        ),
      );
      return null;
    }
    return name;
  }
  function moveModal(b, items) {
    if (!items.length) return;
    const current = [...new Set(items.map((k) => folderOf(b, k)))];
    modal(
      t(
        "移动 " + items.length + " 个来源",
        "Move " + items.length + " source(s)",
      ),
      t(
        "移动后可在目标文件夹中查看。",
        "Find the sources in their destination folder after moving.",
      ),
      selectionReview(items) +
        `<form id="knowledge-move-form" data-dot="${b.id}"><input type="hidden" name="sources" value="${esc(JSON.stringify(items.map((k) => k.id)))}"><div class="field"><label for="km-move-folder">${t("目标文件夹", "Destination folder")}</label><select id="km-move-folder" name="folder">${[["unfiled", t("未分组", "Unfiled")], ...folders(b).map((f) => [f.id, f.name]), ["new", t("＋ 新建文件夹…", "＋ New folder…")]].map(([id, name]) => `<option value="${id}" ${current.length === 1 && current[0] === id ? "selected" : ""}>${esc(name)}</option>`).join("")}</select></div><div class="field" id="km-move-new-field" hidden><label for="km-move-new-name">${t("新文件夹名称", "New folder name")}</label><input id="km-move-new-name" name="name" maxlength="40"></div><p class="form-hint">${t("当前所在：", "Currently in: ")}${current.map((id) => esc(folderName(b, id))).join("、")}</p></form>`,
      cancelButton() +
        submitButton(t("确认移动", "Move sources"), "knowledge-move-form"),
    );
  }
  async function onAction(a, d, el) {
    const known = new Set([
      "preview-source",
      "source-menu",
      "side-page",
      "knowledge-status",
      "knowledge-trash-view",
      "knowledge-reset",
      "knowledge-page",
      "knowledge-clear",
      "knowledge-select-filtered",
      "knowledge-toggle",
      "knowledge-bulk-pause",
      "knowledge-bulk-enable",
      "knowledge-refresh",
      "knowledge-bulk-refresh",
      "knowledge-trash",
      "knowledge-bulk-trash",
      "knowledge-restore",
      "knowledge-bulk-restore",
      "knowledge-rename",
      "knowledge-demo",
      "knowledge-preview-tab",
      "knowledge-child",
      "knowledge-adjacent",
      "knowledge-next-hit",
      "knowledge-copy-link",
      "knowledge-download",
      "knowledge-download-text",
      "knowledge-seek",
      "knowledge-folder",
      "knowledge-folder-create",
      "knowledge-folder-menu",
      "knowledge-folder-rename",
      "knowledge-folder-delete",
      "knowledge-move",
      "knowledge-bulk-move",
    ]);
    if (!known.has(a)) return false;
    const b = dotById(d.dot),
      k = b ? findSource(b, d.id) : null;
    if (!owner(b)) {
      toast(
        t("只能管理自己的知识来源。", "You can only manage your own sources."),
      );
      return true;
    }
    const v = view(b);
    const folder = folders(b).find((f) => f.id === d.folder);
    if (a === "knowledge-folder") {
      if (!["all", "unfiled", ...folders(b).map((f) => f.id)].includes(d.value))
        return true;
      v.folder = d.value;
      v.page = 1;
      v.selected.clear();
      syncURL(b);
      render();
      return true;
    }
    if (a === "knowledge-folder-create" || a === "knowledge-folder-rename") {
      if (a === "knowledge-folder-create" || folder) folderForm(b, folder);
      return true;
    }
    if (a === "knowledge-folder-menu") {
      if (folder)
        modal(
          esc(folder.name),
          t("文件夹管理", "Folder settings"),
          `<div class="ks-action-menu">${action(I("settings") + t("重命名文件夹", "Rename folder"), "knowledge-folder-rename", b, null, "ks-menu-item", `data-folder="${folder.id}"`)}${action(I("trash") + t("删除文件夹", "Delete folder"), "knowledge-folder-delete", b, null, "ks-menu-item danger-text", `data-folder="${folder.id}"`)}</div>`,
          "",
        );
      return true;
    }
    if (a === "knowledge-folder-delete") {
      if (folder)
        confirmModal(
          esc(
            t(
              "删除文件夹「" + folder.name + "」？",
              "Delete folder “" + folder.name + "”?",
            ),
          ),
          t(
            "里面的来源会移到「未分组」，包括回收站中的来源。",
            "Its sources will move to Unfiled, including sources in Trash.",
          ),
          t("删除文件夹", "Delete folder"),
          () => {
            for (const source of [...all(b), ...(b.knowledgeTrash || [])])
              if (source.folderId === folder.id) delete source.folderId;
            b.knowledgeFolders = folders(b).filter((f) => f.id !== folder.id);
            if (v.folder === folder.id) v.folder = "unfiled";
            v.page = 1;
            v.selected.clear();
            save();
            syncURL(b);
            render();
            toast(
              t(
                "文件夹已删除，来源保留在未分组中。",
                "Folder deleted. Sources are retained in Unfiled.",
              ),
            );
          },
        );
      return true;
    }
    if (a === "knowledge-move" || a === "knowledge-bulk-move") {
      moveModal(
        b,
        a === "knowledge-move"
          ? all(b).filter((x) => x.id === k?.id)
          : selected(b),
      );
      return true;
    }
    if (a === "preview-source") {
      if (k) openPreview(b, k);
      return true;
    }
    if (a === "source-menu") {
      if (k) sourceMenu(b, k);
      return true;
    }
    if (a === "side-page") {
      v.sidePage = Math.max(1, Number(d.value));
      const list = document.querySelector("#ks-side-list");
      if (list) list.innerHTML = sidebarRows(b);
      return true;
    }
    if (a === "knowledge-status") {
      v.trash = false;
      v.status = d.value;
      v.page = 1;
      v.selected.clear();
      syncURL(b);
      render();
      return true;
    }
    if (a === "knowledge-trash-view") {
      v.trash = !v.trash;
      v.status = "all";
      v.page = 1;
      v.selected.clear();
      syncURL(b);
      render();
      return true;
    }
    if (a === "knowledge-reset") {
      Object.assign(v, { q: "", kind: "all", status: "all", page: 1 });
      v.selected.clear();
      syncURL(b);
      render();
      return true;
    }
    if (a === "knowledge-page") {
      v.page = Math.max(1, Number(d.value));
      paint(b);
      return true;
    }
    if (a === "knowledge-clear") {
      v.selected.clear();
      paintSelection(b);
      return true;
    }
    if (a === "knowledge-select-filtered") {
      rows(b).forEach((k) => v.selected.add(k.id));
      paintSelection(b);
      return true;
    }
    if (a === "knowledge-toggle") {
      if (k) changeScope(b, [k], !enabled(k));
      return true;
    }
    if (a === "knowledge-bulk-pause" || a === "knowledge-bulk-enable") {
      const items = selected(b),
        value = a === "knowledge-bulk-enable";
      if (!items.length) return true;
      confirmModal(
        value
          ? t("恢复所选来源参与回答？", "Enable selected sources?")
          : t("暂停所选来源参与回答？", "Pause selected sources?"),
        selectionReview(items) +
          `<p class="form-hint">${value ? t("已就绪的来源将重新参与回答；尚未就绪的会在完成后生效。", "Ready sources will contribute again. Other sources take effect when ready.") : t("这些来源保留在知识库中，可以预览和恢复，但不再用于新回答。", "Sources stay available for preview and restoration, but stop contributing to new answers.")}</p>`,
        t("确认", "Confirm"),
        () => changeScope(b, items, value),
      );
      return true;
    }
    if (a === "knowledge-refresh" || a === "knowledge-bulk-refresh") {
      refreshSources(
        b,
        a === "knowledge-refresh" ? [k].filter(Boolean) : selected(b),
      );
      return true;
    }
    if (a === "knowledge-trash" || a === "knowledge-bulk-trash") {
      moveTrash(b, a === "knowledge-trash" ? [k].filter(Boolean) : selected(b));
      return true;
    }
    if (a === "knowledge-restore" || a === "knowledge-bulk-restore") {
      restore(b, a === "knowledge-restore" ? [k].filter(Boolean) : selected(b));
      return true;
    }
    if (a === "knowledge-rename") {
      if (k) renameModal(b, k);
      return true;
    }
    if (a === "knowledge-demo") {
      if (
        dotById("knowledge-demo") &&
        S().dots.some((x) => x.id === "knowledge-demo")
      )
        buildDemo();
      else
        confirmModal(
          t("体验 128 个来源的知识管理", "Explore a 128-source library"),
          t(
            "新增一个独立的私有示例 Ree，含 128 个来源；其中一个整站有 148 个页面，一个仓库有 117 个文件。不会修改当前 Ree，也不消耗 Credits。",
            "Creates a separate private demo Ree with 128 sources, including a 148-page site and 117-file repository. Your current Ree is unchanged. No credits are charged.",
          ),
          t("打开规模演示", "Open scale demo"),
          buildDemo,
        );
      return true;
    }
    if (a === "knowledge-preview-tab") {
      previewView(b, k).tab = d.value;
      if (document.querySelector(".kp-modal")) openPreview(b, k, false);
      else render();
      return true;
    }
    if (a === "knowledge-child") {
      previewView(b, k).child = Number(d.value);
      const listScroll =
        document.querySelector(".kp-child-list")?.scrollTop || 0;
      paintContent(b, k);
      const list = document.querySelector(".kp-child-list");
      if (list) list.scrollTop = listScroll;
      return true;
    }
    if (a === "knowledge-adjacent") {
      const data = rows(b),
        idx = data.findIndex((x) => x.id === k.id),
        next = data[idx + Number(d.value)];
      if (next) {
        if (document.querySelector(".kp-modal")) openPreview(b, next);
        else {
          preview = null;
          go("/dots/" + b.id + "/knowledge/" + next.id);
        }
      }
      return true;
    }
    if (a === "knowledge-next-hit") {
      const matches = [...document.querySelectorAll(".kp-content mark")];
      if (matches.length) {
        preview.hit = (preview.hit + 1) % matches.length;
        matches.forEach((el, i) =>
          el.classList.toggle("current", i === preview.hit),
        );
        matches[preview.hit].scrollIntoView({
          block: "center",
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        });
      }
      return true;
    }
    if (a === "knowledge-copy-link") {
      await copy(
        location.href.split("#")[0] + "#/dots/" + b.id + "/knowledge/" + k.id,
      );
      return true;
    }
    if (a === "knowledge-download") {
      const file = files.get(k.id);
      if (file) {
        const a = document.createElement("a");
        a.href = file.url;
        a.download = file.name;
        a.click();
      } else
        toast(
          t(
            "原文件在当前会话中不可用。",
            "Original file is not available in this session.",
          ),
        );
      return true;
    }
    if (a === "knowledge-download-text") {
      download(
        (k.title.replace(/\.[^.]+$/, "") || "knowledge") + ".txt",
        sampleText(k),
      );
      return true;
    }
    if (a === "knowledge-seek") {
      const audio = document.querySelector("#kp-audio-player");
      if (audio) {
        audio.currentTime = Number(d.value);
      } else
        toast(
          t(
            "这是转写示例；没有可播放的原始音频。",
            "This is a transcript sample without original audio.",
          ),
        );
      el.closest(".kp-transcript")
        ?.querySelectorAll("button")
        .forEach((x) => x.classList.toggle("active", x === el));
      return true;
    }
    return true;
  }
  async function onSubmit(form, f) {
    if (form.id === "knowledge-folder-form") {
      const b = dotById(form.dataset.dot);
      if (!owner(b)) return true;
      const existing = folders(b).find(
        (item) => item.id === form.dataset.folder,
      );
      if (form.dataset.folder && !existing) return true;
      const name = validFolderName(b, f.get("name"), existing?.id);
      if (!name) return true;
      if (existing) existing.name = name;
      else {
        const folder = { id: uid(), name, createdAt: stamp() };
        b.knowledgeFolders ??= [];
        b.knowledgeFolders.push(folder);
        Object.assign(view(b), {
          folder: folder.id,
          page: 1,
          trash: false,
          status: "all",
          q: "",
          kind: "all",
        });
        view(b).selected.clear();
      }
      save();
      closeModal();
      syncURL(b);
      render();
      toast(t("文件夹已保存。", "Folder saved."));
      return true;
    }
    if (form.id === "knowledge-move-form") {
      const b = dotById(form.dataset.dot);
      if (!owner(b)) return true;
      let ids;
      try {
        ids = JSON.parse(f.get("sources"));
      } catch {
        return true;
      }
      if (!Array.isArray(ids) || !ids.length) return true;
      const items = all(b).filter((k) => ids.includes(k.id));
      if (items.length !== new Set(ids).size) {
        toast(
          t(
            "部分来源已不在知识库中，请重新选择。",
            "Some sources are no longer in the library. Select them again.",
          ),
        );
        return true;
      }
      let target = f.get("folder");
      if (target === "new") {
        const name = validFolderName(b, f.get("name"));
        if (!name) return true;
        const folder = { id: uid(), name, createdAt: stamp() };
        b.knowledgeFolders ??= [];
        b.knowledgeFolders.push(folder);
        target = folder.id;
      } else if (
        target !== "unfiled" &&
        !folders(b).some((folder) => folder.id === target)
      ) {
        toast(
          t(
            "目标文件夹不存在，请重新选择。",
            "The destination folder is unavailable. Choose another folder.",
          ),
        );
        return true;
      }
      let moved = 0;
      for (const k of items) {
        if (folderOf(b, k) === target) continue;
        if (target === "unfiled") delete k.folderId;
        else k.folderId = target;
        activity(
          k,
          t("移入文件夹：", "Moved to folder: ") + folderName(b, target),
        );
        moved++;
      }
      view(b).selected.clear();
      view(b).page = 1;
      save();
      closeModal();
      syncURL(b);
      render();
      toast(
        moved
          ? t(
              "已移动 " +
                moved +
                " 个来源到「" +
                folderName(b, target) +
                "」。",
              "Moved " +
                moved +
                " source(s) to “" +
                folderName(b, target) +
                "”.",
            )
          : t(
              "所选来源已在此文件夹中。",
              "The selected sources are already in this folder.",
            ),
      );
      return true;
    }
    if (form.id === "knowledge-rename-form") {
      const b = dotById(form.dataset.dot),
        k = b ? findSource(b, form.dataset.id) : null;
      if (!owner(b) || !k) return true;
      const name = f.get("title").trim();
      if (!name) {
        toast(t("名称不能为空。", "A name is required."));
        return true;
      }
      k.originalTitle ??= k.title;
      k.title = name;
      activity(k, t("显示名称已修改", "Display name changed"));
      save();
      closeModal();
      render();
      toast(t("来源名称已保存。", "Source name saved."));
      return true;
    }
    if (form.id === "knowledge-filter-form") {
      const b = dotById(form.dataset.dot);
      if (!owner(b)) return true;
      const v = view(b);
      v.q = (f.get("q") || "").trim();
      v.kind = f.get("kind") || "all";
      v.sort = f.get("sort") || "new";
      v.page = 1;
      v.selected.clear();
      paint(b);
      return true;
    }
    return false;
  }
  function ingested(b, k, file = null) {
    const folder = view(b).folder;
    if (
      route().path === "/dots/" + b.id + "/knowledge" &&
      folders(b).some((f) => f.id === folder)
    )
      k.folderId = folder;
    k.createdAt ??= stamp();
    k.updatedAt = k.createdAt;
    k.enabled ??= true;
    activity(k, t("来源已添加，等待处理", "Source added; processing queued"));
    if (file) {
      k.fileName = file.name;
      k.fileSize = file.size;
      k.previewLimited =
        ["md", "txt"].includes(file.name.split(".").pop().toLowerCase()) &&
        file.size > new Blob([k.content]).size;
      const mime = /\.pdf$/i.test(file.name)
        ? "application/pdf"
        : k.kind === "audio"
          ? file.type.startsWith("audio/")
            ? file.type
            : "audio/mpeg"
          : "application/octet-stream";
      files.set(k.id, {
        url: URL.createObjectURL(new Blob([file], { type: mime })),
        name: file.name,
      });
    }
  }
  let processingTimer,
    resultCount = 0,
    failedCount = 0;
  function processed(b, k, failed) {
    activity(
      k,
      failed
        ? t(
            "处理失败，预留额度已退回",
            "Processing failed; reservation released",
          )
        : t("处理完成，来源已就绪", "Processing complete; source ready"),
    );
    resultCount++;
    if (failed) failedCount++;
    clearTimeout(processingTimer);
    processingTimer = setTimeout(() => {
      if (document.querySelector(".kp-modal") && preview) {
        const dot = dotById(preview.dot),
          source = dot && findSource(dot, preview.id);
        if (source) openPreview(dot, source, false);
      }
      if (!document.querySelector(".modal") && !U().busy) render();
      toast(
        t(
          "已更新 " +
            resultCount +
            " 个来源" +
            (failedCount
              ? "，其中 " + failedCount + " 个失败并退回费用。"
              : "，知识已就绪。"),
          resultCount +
            " source(s) updated" +
            (failedCount
              ? "; " + failedCount + " failed and were refunded."
              : "; knowledge is ready."),
        ),
      );
      resultCount = 0;
      failedCount = 0;
    }, 120);
    return true;
  }
  document.addEventListener("input", (e) => {
    if (e.target.id === "ks-side-search") {
      const b = dotById(e.target.closest("[data-dot]").dataset.dot);
      if (!owner(b)) return;
      view(b).sideQ = e.target.value;
      view(b).sidePage = 1;
      document.querySelector("#ks-side-list").innerHTML = sidebarRows(b);
    }
    if (e.target.id === "km-search") {
      const b = dotById(
        e.target.closest("[data-knowledge-manager]").dataset.knowledgeManager,
      );
      const v = view(b);
      v.q = e.target.value;
      v.page = 1;
      v.selected.clear();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        if (
          document.querySelector("[data-knowledge-manager]")?.dataset
            .knowledgeManager !== b.id
        )
          return;
        paint(b);
      }, 160);
    }
    if (e.target.id === "kp-find" && preview) {
      const b = dotById(preview.dot),
        k = b && findSource(b, preview.id);
      if (k) {
        preview.q = e.target.value;
        preview.hit = 0;
        paintContent(b, k);
      }
    }
    if (e.target.id === "kp-child-search" && preview) {
      const b = dotById(preview.dot),
        k = b && findSource(b, preview.id);
      if (k) {
        preview.childQ = e.target.value;
        const sel = e.target.selectionStart;
        const content = document.querySelector("#kp-content");
        content.innerHTML = contentHTML(b, k);
        const input = document.querySelector("#kp-child-search");
        input?.focus();
        input?.setSelectionRange(sel, sel);
        paintMatches();
      }
    }
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "km-move-folder") {
      const field = document.querySelector("#km-move-new-field");
      if (field) {
        field.hidden = e.target.value !== "new";
        const input = field.querySelector("input");
        input.required = !field.hidden;
        if (!field.hidden) input.focus();
      }
      return;
    }
    const root = e.target.closest("[data-knowledge-manager]");
    if (!root) return;
    const b = dotById(root.dataset.knowledgeManager);
    if (!owner(b)) return;
    const v = view(b);
    if (e.target.dataset.sourceCheck) {
      e.target.checked
        ? v.selected.add(e.target.dataset.sourceCheck)
        : v.selected.delete(e.target.dataset.sourceCheck);
      paintSelection(b);
    }
    if (e.target.id === "km-select-page") {
      pageRows(b).forEach((k) =>
        e.target.checked ? v.selected.add(k.id) : v.selected.delete(k.id),
      );
      paintSelection(b);
    }
    if (["km-kind", "km-sort", "km-page-size"].includes(e.target.id)) {
      if (e.target.id === "km-kind") v.kind = e.target.value;
      if (e.target.id === "km-sort") v.sort = e.target.value;
      if (e.target.id === "km-page-size") v.size = Number(e.target.value);
      v.page = 1;
      v.selected.clear();
      paint(b);
    }
  });
  document.addEventListener(
    "keydown",
    (e) => {
      const input = e.target.closest(
        'input,textarea,select,[contenteditable="true"]',
      );
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "k" &&
        document.querySelector("#km-search")
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        document.querySelector("#km-search").focus();
      }
      if (
        !input &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        document.querySelector("[data-knowledge-preview]") &&
        ["ArrowLeft", "ArrowRight"].includes(e.key) &&
        preview
      ) {
        const b = dotById(preview.dot),
          k = b && findSource(b, preview.id),
          data = b ? rows(b) : [],
          idx = data.findIndex((x) => x.id === preview.id),
          next = data[idx + (e.key === "ArrowRight" ? 1 : -1)];
        if (k && next) {
          e.preventDefault();
          document.querySelector(".kp-modal")
            ? openPreview(b, next)
            : go("/dots/" + b.id + "/knowledge/" + next.id);
        }
      }
    },
    true,
  );
  return {
    sidebar,
    workTabs,
    headerControls,
    resolve,
    afterRender,
    onAction,
    onSubmit,
    ingested,
    processed,
  };
}
