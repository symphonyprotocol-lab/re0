import { adminReeDetailPath, adminReeBackPath, adminReeSourcePath, filteredAdminReeSources } from "./admin-ree-detail.js";

export function adminSourceSequence(dot, sourceId, query) {
  const { rows } = filteredAdminReeSources(dot, query);
  const index = rows.findIndex(source => source.id === sourceId);
  const item = at => at >= 0 && at < rows.length ? { source: rows[at], page: Math.floor(at / 20) + 1 } : undefined;
  return { total: rows.length, position: index + 1, previous: index >= 0 ? item(index - 1) : undefined, next: index >= 0 ? item(index + 1) : undefined };
}

export function adminReeSourceRoute(path) {
  const match = /^\/admin\/dots\/([^/]+)\/sources\/([^/]+)$/.exec(path);
  if (!match) return null;
  try { return {reeId:decodeURIComponent(match[1]),sourceId:decodeURIComponent(match[2])}; }
  catch { return null; }
}

const normalizedText = value => {
  const text = typeof value === "string" ? value : "";
  return !text.includes("\n") && text.includes("\\n") ? text.replaceAll("\\n", "\n") : text;
};
export function adminSourceView(source, query) {
  const children = source.kind === "github" ? source.files || [] : source.kind === "site" ? source.pages || [] : [];
  const childQ = (query.get("childQ") || "").trim().slice(0,200), contentQ = (query.get("contentQ") || "").trim().slice(0,200);
  const requested = Number(query.get("child")), childIndex = Number.isInteger(requested) && requested >= 0 && requested < children.length ? requested : 0;
  const filtered = children.map((child,index)=>({child,index})).filter(({child})=>
    [child.path,child.title,child.url].join(" ").toLocaleLowerCase().includes(childQ.toLocaleLowerCase()));
  const pages = Math.max(1,Math.ceil(filtered.length/30)), requestedPage = Number(query.get("childPage"));
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.min(pages,Math.floor(requestedPage)) : 1;
  const selected = children[childIndex];
  const text = normalizedText(selected ? selected.content : source.content);
  const matches = contentQ ? text.toLocaleLowerCase().split(contentQ.toLocaleLowerCase()).length-1 : 0;
  return { children, selected, childIndex, childQ, contentQ, text, matches, total:filtered.length, page, pages, items:filtered.slice((page-1)*30,page*30) };
}
export function createAdminReeSource(ctx) {
  const { t, I, esc, n, title, route, go } = ctx;
  const link = (path,label,cls="text-link")=>`<a href="#${esc(path)}" class="${cls}">${label}</a>`;
  function record(reeId, sourceId) {
    if (!ctx.getState().admin) return undefined;
    const dot = ctx.reeRecord(reeId), source = dot?.knowledge?.find(item=>item.id===sourceId);
    return dot && source ? {dot,source} : undefined;
  }
  const filters = () => ({sourceQ:route().query.get("sourceQ"),sourceStatus:route().query.get("sourceStatus"),sourcePage:route().query.get("sourcePage")});
  const origin = dot => adminReeBackPath(route().query.get("from"),dot?.adminDemo);
  const returnPath = dot => adminReeDetailPath(dot,origin(dot),"sources",filters());
  function previewPath(dot,source,changes={}) {
    const query = route().query;
    return adminReeSourcePath(dot,source,origin(dot),filters(),{
      contentQ:query.get("contentQ"),childQ:query.get("childQ"),child:query.get("child"),childPage:query.get("childPage"),...changes,
    });
  }
  function navigation(reeId,sourceId) {
    const dot = ctx.reeRecord(reeId);
    const found = record(reeId,sourceId);
    let controls = "";
    if (found) {
      const sequence = adminSourceSequence(dot,sourceId,route().query);
      const adjacent = (item,label,direction) => {
        const content = direction === "previous" ? I("chevron") + `<span>${label}</span>` : `<span>${label}</span>` + I("chevron");
        if (!item) return `<button type="button" class="admin-source-adjacent ${direction}" aria-label="${label}" disabled>${content}</button>`;
        // Start each source at its own content; only the source-list scope travels.
        const href = adminReeSourcePath(dot,item.source,origin(dot),{...filters(),sourcePage:item.page});
        return `<a class="admin-source-adjacent ${direction}" href="#${esc(href)}" aria-label="${label}" title="${esc(item.source.title)}">${content}</a>`;
      };
      controls = `<div class="admin-source-sequence" role="group" aria-label="${t("连续审核来源","Review sources in sequence")}">${adjacent(sequence.previous,t("上一个来源","Previous source"),"previous")}<span class="admin-source-position" role="status" aria-label="${esc(sequence.position ? t(`当前筛选范围第 ${sequence.position} 个，共 ${sequence.total} 个来源`,`Source ${sequence.position} of ${sequence.total} in the current filter`) : t("当前来源不在筛选范围内","This source is outside the current filter"))}">${sequence.position ? n(sequence.position) + " / " + n(sequence.total) : t("不在筛选范围内","Outside filter")}</span>${adjacent(sequence.next,t("下一个来源","Next source"),"next")}</div>`;
    }
    return controls;
  }
  function marked(text,q) {
    if (!q) return esc(text);
    const lower=text.toLocaleLowerCase(),needle=q.toLocaleLowerCase();
    let start=0,at=lower.indexOf(needle),result="";
    while(at!==-1) { result+=esc(text.slice(start,at))+`<mark>${esc(text.slice(at,at+q.length))}</mark>`;start=at+q.length;at=lower.indexOf(needle,start); }
    return result+esc(text.slice(start));
  }
  function body(text,q,code) {
    if (code) return `<pre class="admin-source-code">${marked(text,q)}</pre>`;
    return text.split("\n").map(line=>{
      const heading=/^(#{1,3}) (.*)$/.exec(line);
      if(heading) return `<h${heading[1].length+1}>${marked(heading[2],q)}</h${heading[1].length+1}>`;
      return line.trim() ? `<p>${marked(line,q)}</p>` : '<div class="admin-source-gap"></div>';
    }).join("");
  }
  function collection(dot,source,data) {
    if (!data.children.length) return "";
    return `<aside class="card admin-source-collection"><div class="admin-source-collection-head"><h2>${source.kind === "github" ? t("仓库文件","Repository files") : t("站点页面","Website pages")} <small>${n(data.children.length)}</small></h2><form id="admin-source-child-search" data-ree="${esc(dot.id)}" data-source="${esc(source.id)}"><input name="childQ" aria-label="${t("查找子页面或文件","Find pages or files")}" placeholder="${t("搜索标题或路径…","Search title or path…")}" maxlength="200" value="${esc(data.childQ)}"><button class="btn secondary sm" type="submit">${I("search")}${t("查找","Find")}</button></form></div><div class="admin-source-child-list">${data.items.map(({child,index})=>`<a href="#${esc(previewPath(dot,source,{child:index}))}" class="${index===data.childIndex ? "active" : ""}" ${index===data.childIndex?'aria-current="true"':""}>${I(source.kind==="github"?"code":"file")}<span>${esc(child.path||child.title||child.url||t("未命名","Untitled"))}</span></a>`).join("") || `<p class="small muted">${t("没有匹配的页面或文件","No matching pages or files")}</p>`}</div><div class="admin-source-child-pagination"><span>${data.page} / ${data.pages}</span>${data.page>1?link(previewPath(dot,source,{childPage:data.page-1}),t("上一页","Previous")):""}${data.page<data.pages?link(previewPath(dot,source,{childPage:data.page+1}),t("下一页","Next")):""}</div></aside>`;
  }
  function page(reeId,sourceId) {
    const found=record(reeId,sourceId),dot=ctx.reeRecord(reeId);
    if(!found) return `<section class="card empty"><h1>${t("知识来源不存在或已移除","Source not found")}</h1>${link(dot?returnPath(dot):"/admin/dots",t("返回知识来源列表","Back to sources"),"btn secondary mt16")}</section>`;
    const {source}=found,data=adminSourceView(source,route().query);
    const state=source.status==="ready"?"ready":source.status==="failed"?"failed":"processing";
    const states={ready:t("已就绪","Ready"),processing:t("处理中","Processing"),failed:t("处理失败","Failed")};
    const meta=(label,value)=>`<div><dt>${label}</dt><dd>${esc(value||t("未记录","Not recorded"))}</dd></div>`;
    const timestamp=value=>value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString(ctx.getState().lang==="en"?"en-GB":"zh-CN") : "";
    const notice=state==="failed" ? source.error||t("这份来源处理失败。","This source could not be processed.") : state==="processing" ? t("这份来源仍在处理中。","This source is still processing.") : "";
    const code=source.kind==="github" && !/\.(md|txt|markdown)$/i.test(data.selected?.path||"README.md");
    return `<div class="admin-source-preview"><header class="admin-source-head"><span class="file-icon">${I(source.kind==="github"?"github":source.kind==="audio"?"audio":"file")}</span><div><h1>${esc(source.title)}</h1><p>${esc(title(dot))}<span> / </span>${esc(ctx.kindLabel(source.kind))}<span> / </span>${states[state]}${source.enabled===false?" · "+t("已暂停参与回答","Paused for answers"):""}</p></div><span class="tag blue">${t("只读审核","Read-only review")}</span></header>
    <div class="card admin-source-meta"><dl>${meta(t("来源定位","Location"),source.locator)}${meta(t("原始来源 / 文件名","Origin / filename"),source.source||source.fileName)}${meta(t("最近更新","Updated"),timestamp(source.updatedAt))}${meta(t("当前正文","Current text"),n(data.text.length)+t(" 字符"," characters"))}</dl></div>
    ${notice?`<div class="info-strip admin-source-notice">${I("info")}<span>${esc(notice)} ${data.text?t("下方展示当前保留的解析文本。","The saved extracted text is shown below."):t("暂时没有可预览的正文。","No extracted text is available yet.")}</span></div>`:""}
    <div class="admin-source-layout ${data.children.length?"has-collection":""}">${collection(dot,source,data)}<section class="card admin-source-reader"><div class="admin-source-reader-head"><div><h2>${data.selected?esc(data.selected.path||data.selected.title||t("解析正文","Extracted text")):t(source.kind==="audio"?"音频转写正文":"解析正文",source.kind==="audio"?"Audio transcript":"Extracted text")}</h2>${data.selected?.url?`<p>${esc(data.selected.url)}</p>`:""}</div><form id="admin-source-content-search" data-ree="${esc(dot.id)}" data-source="${esc(source.id)}"><input name="contentQ" aria-label="${t("查找正文内容","Find in content")}" placeholder="${t("查找正文…","Find in content…")}" maxlength="200" value="${esc(data.contentQ)}"><button class="btn secondary sm" type="submit">${t("查找","Find")}</button></form></div>${data.contentQ?`<div class="admin-source-search-result" role="status">${t("匹配","Matches")} ${n(data.matches)} ${t("处","")} ${link(previewPath(dot,source,{contentQ:null}),t("清除","Clear"))}</div>`:""}<article class="admin-source-content">${data.text?body(data.text,data.contentQ,code):`<div class="empty"><h3>${t("暂无可预览的解析内容","No extracted content available")}</h3><p>${t("原型只展示已保存的文本；此来源尚未保存正文或解析尚未完成。","This prototype shows saved text only. No content has been saved for this source, or processing is incomplete.")}</p></div>`}</article><footer>${t("按来源保存的解析文本展示，供管理员核对内容。","Saved extracted text for administrator review.")}</footer></section></div></div>`;
  }
  function onSubmit(form,data) {
    if(!["admin-source-content-search","admin-source-child-search"].includes(form.id)) return false;
    const found=record(form.dataset.ree,form.dataset.source);
    if(!found) {go("/admin/login");return true;}
    const changes=form.id==="admin-source-content-search"?{contentQ:data.get("contentQ")}:{childQ:data.get("childQ"),childPage:1};
    go(previewPath(found.dot,found.source,changes));return true;
  }
  return {record,page,navigation,returnPath,onSubmit};
}
