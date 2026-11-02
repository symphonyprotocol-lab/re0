import {
  classificationValue,
  dotCategory,
  DOT_CATEGORIES,
} from "./dot-classification.js";
import { dotAvatarValue } from "./dot-avatar.js";

export const SETUP_STEPS = ["基本资料", "知识与个性", "添加知识", "发布与确认"];
export function newDotDraft() {
  return {
    name: "",
    description: "",
    avatar: "",
    color: "",
    category: "",
    tags: [],
    prompt: "",
    samples: "",
    visibility: "private",
    fee: 0,
    reached: 1,
    step: 1,
    source: {
      kind: "later",
      title: "",
      text: "",
      url: "",
      private: false,
      fileName: "",
    },
  };
}
export function validateDotDraft(draft, step) {
  if (!draft.name.trim() || draft.name.trim().length > 40)
    return { step: 1, error: "name" };
  if (draft.description.length > 240) return { step: 1, error: "description" };
  if (step < 2) return null;
  const classification = classificationValue(draft.category, draft.tags);
  if (classification.error) return { step: 2, error: classification.error };
  if (draft.prompt.length > 4000) return { step: 2, error: "prompt" };
  const samples = draft.samples
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (samples.length > 3 || samples.some((s) => Array.from(s).length > 160))
    return { step: 2, error: "samples" };
  if (
    step >= 4 &&
    (!Number.isInteger(Number(draft.fee)) ||
      Number(draft.fee) < 0 ||
      Number(draft.fee) > 10000)
  )
    return { step: 4, error: "fee" };
  return null;
}
export async function prepareSetupSource(source, state, file) {
  const kind = source.kind;
  if (kind === "later") return { cost: 0, source: null };
  let title = "",
    content = "",
    url = "",
    cost = 0;
  if (["document", "audio"].includes(kind)) {
    if (!file) throw new Error("file");
    const ext = file.name.split(".").pop().toLowerCase();
    if (
      !(
        kind === "audio" ? ["mp3", "m4a", "wav"] : ["pdf", "docx", "md", "txt"]
      ).includes(ext) ||
      !file.size ||
      file.size > (kind === "audio" ? 100 : 20) * 1024 * 1024
    )
      throw new Error("file-format");
    title = file.name;
    if (["md", "txt"].includes(ext))
      content = (await file.text()).slice(0, 10000);
    cost = content
      ? Math.max(1, Math.ceil(content.length / 1000))
      : kind === "audio"
        ? 300
        : 20;
  } else if (kind === "text") {
    title = source.title.trim();
    content = source.text.trim();
    if (!title || !content || title.length > 100 || content.length > 30000)
      throw new Error("source-text");
    cost = Math.max(1, Math.ceil(content.length / 1000));
  } else if (["page", "github", "site"].includes(kind)) {
    let parsed;
    try {
      parsed = new URL(source.url);
    } catch {
      throw new Error("url");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("url");
    if (
      kind === "github" &&
      (parsed.hostname !== "github.com" ||
        parsed.pathname.split("/").filter(Boolean).length < 2)
    )
      throw new Error("github-url");
    if (kind === "github" && source.private && !state.github)
      throw new Error("github-auth");
    if (
      kind === "site" &&
      !(state.domains || []).some(
        (d) => d.domain === parsed.hostname && d.status === "verified",
      )
    )
      throw new Error("domain");
    url = parsed.href;
    title =
      kind === "github"
        ? parsed.pathname.slice(1).replace(/\/$/, "")
        : parsed.hostname + parsed.pathname;
    cost = kind === "github" ? 120 : kind === "site" ? 500 : 20;
  } else throw new Error("source-kind");
  return {
    cost,
    source: {
      title,
      content,
      source: url,
      kind,
      private: kind === "github" && !!source.private,
    },
  };
}
export function dotFromDraft(draft, id) {
  const classification = classificationValue(draft.category, draft.tags);
  return {
    id,
    slug: "dot-" + id.slice(0, 8),
    name: draft.name.trim(),
    enName: draft.name.trim(),
    description: draft.description.trim(),
    enDescription: draft.description.trim(),
    avatar: dotAvatarValue(draft.avatar),
    color: draft.color,
    category: classification.category,
    tags: classification.tags,
    prompt: draft.prompt.trim(),
    samples: draft.samples
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    public: draft.visibility === "public",
    fee: Number(draft.fee),
    owner: "me",
    icon: "dot",
    answers: 0,
    rating: 0,
    knowledge: [],
  };
}

export function createDotSetup(ctx) {
  const {
    t,
    I,
    esc,
    n,
    shell,
    footer,
    go,
    save,
    render,
    toast,
    uid,
    avatar,
    dotAvatar,
    classification,
    knowledge,
  } = ctx;
  const S = ctx.getState,
    U = ctx.getUi;
  let file = null,
    errorMessage = "",
    creating = false;
  const draft = () => S().dotSetupDraft || (S().dotSetupDraft = newDotDraft());
  const labels = () => [
    t("基本资料", "Identity"),
    t("知识与个性", "Knowledge & personality"),
    t("添加知识", "Add knowledge"),
    t("发布与确认", "Publish & review"),
  ];
  const sourceNames = () => ({
    later: t("稍后添加", "Add later"),
    text: t("粘贴文本", "Paste text"),
    document: t("上传文档", "Document"),
    audio: t("上传音频", "Audio"),
    page: t("单个网页", "Web page"),
    github: "GitHub",
    site: t("整站抓取", "Website"),
  });
  const messages = () => ({
    name: t(
      "请输入 1–40 个字符的 Ree 名称。",
      "Enter a Ree name of 1–40 characters.",
    ),
    description: t(
      "简介最多 240 个字符。",
      "Description is limited to 240 characters.",
    ),
    category: t("请选择主分类。", "Choose a category."),
    limit: t("最多添加 3 个标签。", "Choose up to three tags."),
    length: t("标签最多 20 个字符。", "Tags are limited to 20 characters."),
    prompt: t(
      "提示词最多 4,000 个字符。",
      "Prompt is limited to 4,000 characters.",
    ),
    samples: t(
      "最多填写 3 个示例问题，每个最多 160 个字符。",
      "Add up to three sample questions, each up to 160 characters.",
    ),
    fee: t(
      "查询费应为 0–10,000 的整数。",
      "The query fee must be an integer from 0 to 10,000.",
    ),
    file: t(
      "请选择文件。刷新后需要重新选择文档或音频。",
      "Select a file. Reselect documents or audio after a refresh.",
    ),
    "file-format": t(
      "文件格式或大小不符合要求。文档最大 20 MB，音频最大 100 MB。",
      "Unsupported file format or size. Documents: 20 MB; audio: 100 MB.",
    ),
    "source-text": t(
      "请填写来源标题与知识正文（最多 30,000 字符）。",
      "Enter a source title and content, up to 30,000 characters.",
    ),
    url: t("请输入有效的 HTTP(S) 地址。", "Enter a valid HTTP(S) URL."),
    "github-url": t(
      "请输入有效的 GitHub 仓库地址。",
      "Enter a valid GitHub repository URL.",
    ),
    "github-auth": t(
      "私有仓库需要先在连接设置中授权 GitHub，也可以先选择稍后添加。",
      "Connect GitHub in Settings for private repositories, or add this source later.",
    ),
    domain: t(
      "整站抓取需要先在连接设置中验证域名，也可以先选择稍后添加。",
      "Verify the domain in Settings for website crawls, or add this source later.",
    ),
  });
  const field = (id, label, html, hint = "") =>
    `<div class="field"><label for="${id}">${label}</label>${html}${hint ? `<small>${hint}</small>` : ""}</div>`;
  function identity(dot) {
    return `${dotAvatar.editor(dot)}${field("edit-name", t("Ree 名称", "Ree name"), `<input id="edit-name" name="name" required maxlength="40" value="${esc(dot.name || "")}" placeholder="${t("例如：我的产品知识库", "e.g. My product knowledge")}">`)}${field("edit-description", t("一句话介绍", "Short introduction"), `<textarea id="edit-description" name="description" rows="3" maxlength="240" placeholder="${t("它了解什么，能帮助别人解决哪些问题？", "What does it know and how can it help?")}">${esc(dot.description || "")}</textarea>`)}<span class="field-label">${t("默认头像配色", "Default avatar color")}</span><input type="hidden" name="color" value="${esc(dot.color || "")}"><div class="color-options mt16">${["", "lilac", "sand", "sage", "rose", "slate"].map((color, i) => `<button type="button" class="color-option ${dot.color === color || (!dot.color && !color) ? "active" : ""}" data-action="setup-color" data-value="${color}" aria-label="${["Blue", "Lilac", "Sand", "Sage", "Rose", "Slate"][i]}" aria-pressed="${dot.color === color || (!dot.color && !color)}">${avatar({ color })}</button>`).join("")}</div>`;
  }
  function personality(dot, creating = false) {
    return `${classification.editor(dot, { creating })}${field("edit-prompt", t("回答方式与人设", "Answer style & personality"), `<textarea id="edit-prompt" name="prompt" rows="5" maxlength="4000" placeholder="${t("例如：用清晰的步骤回答，保持简洁，并解释关键术语。", "e.g. Answer in clear steps and explain key terms.")}">${esc(dot.prompt || "")}</textarea>`, t("无论如何设置，Ree 都只基于已启用的知识回答，不确定时会坦诚说明。", "Ree answers only from enabled knowledge and acknowledges uncertainty."))}${field("edit-samples", t("示例问题", "Sample questions"), `<textarea id="edit-samples" name="samples" rows="4" placeholder="${t("每行一个问题，最多 3 个", "One per line, up to three")}">${esc(Array.isArray(dot.samples) ? dot.samples.join("\n") : dot.samples || "")}</textarea>`, t("用于公开页引导提问，也方便在对话页测试。", "Shown on the public page and available for testing in Chat."))}`;
  }
  function publishing(dot) {
    const visibility =
      dot.visibility || (dot.public && !dot.moderated ? "public" : "private");
    return `<div class="setup-visibility">${["private", "public"].map((value) => `<label><input type="radio" name="visibility" value="${value}" ${visibility === value ? "checked" : ""} ${dot.moderated && value === "public" ? "disabled" : ""}><span>${I(value === "public" ? "globe" : "lock")}<strong>${value === "public" ? t("公开", "Public") : t("仅自己", "Private")}</strong><small>${value === "public" ? t("可被发现，其他用户登录后提问。", "Discoverable. Signed-in users can ask questions.") : t("留在个人空间，随时准备好再公开。", "Keep it in your workspace until you are ready.")}</small></span></label>`).join("")}</div>${dot.moderated ? `<p class="form-hint">${t("此 Ree 已下架，需等待管理员恢复公开。", "This Ree is taken down. Only administrators can restore public access.")}</p>` : ""}${field("edit-fee", t("查询费（credits / 次成功回答）", "Query fee (credits / successful answer)"), `<input id="edit-fee" name="fee" type="number" min="0" max="10000" step="1" value="${Number(dot.fee) || 0}" required>`, t("向其他用户收取，100% 计入你的收入。问自己的 Ree 仅收 20 credits 基本费，未作答不收费。", "The full query fee goes to you. Your own Ree charges only the 20-credit base fee; unanswered questions are free."))}`;
  }
  function settingsPage(dot) {
    return shell(
      `<div class="page dot-settings-page"><form id="dot-settings-form" data-id="${esc(dot.id)}"><div class="setup-page-heading"><div><h1>${t("让它，成为你的知识表达。", "Make it your kind of knowledge.")}</h1><p>${t("资料、回答方式与发布设置，都在这里管理。", "Manage its identity, answer style and publishing here.")}</p></div><button type="submit" class="btn">${t("保存设置", "Save changes")}${I("check")}</button></div><div class="dot-settings-grid"><div><section class="card setup-section"><h2>${t("基本资料", "Identity")}</h2>${identity(dot)}</section><section class="card setup-section"><h2>${t("知识与个性", "Knowledge & personality")}</h2>${personality(dot)}</section><section class="card setup-section"><h2>${t("发布与定价", "Publishing & pricing")}</h2>${publishing(dot)}</section><div class="setup-settings-actions"><button type="button" class="btn secondary" data-action="dot-settings-reset">${t("放弃更改", "Discard changes")}</button><button type="submit" class="btn">${t("保存设置", "Save changes")}</button></div></div><aside><section class="card setup-summary">${avatar(dot)}<h2>${esc(dot.name)}</h2><span class="tag blue">${classification.categoryLabel(dot)}</span><p>${esc(dot.description)}</p><a href="#/dots/${dot.id}/knowledge">${I("file")}${n(dot.knowledge.length)} ${t("个知识来源", "sources")}${I("arrow")}</a><a href="#/dots/${dot.id}/chat">${I("chat")}${t("在对话中测试", "Test in Chat")}${I("arrow")}</a>${dot.public && !dot.moderated ? `<a href="#/d/${esc(dot.slug)}">${I("external")}${t("查看公开页", "View public page")}${I("arrow")}</a>` : ""}<small>${t("右侧展示已保存的资料；编辑后点击保存生效。", "This preview shows saved details. Save to apply your edits.")}</small></section><section class="card setup-danger"><h3>${t("删除 Ree", "Delete Ree")}</h3><p>${t("删除前会再次确认，已有对话仍会保留。", "Deletion requires confirmation. Existing conversations are retained.")}</p><button type="button" class="text-link" data-action="delete-dot" data-id="${dot.id}">${I("trash")}${t("删除这个 Ree", "Delete this Ree")}</button></section></aside></div></form>${footer()}</div>`,
    );
  }
  function headerSteps() {
    const d = draft(),
      step = Math.max(
        1,
        Math.min(4, Number(ctx.route().query.get("step")) || d.step, d.reached),
      );
    return `<nav class="setup-progress" aria-label="${t("创建 Ree 步骤", "Ree setup progress")}">${labels()
      .map(
        (label, index) =>
          `<button data-action="setup-step" data-value="${index + 1}" ${index + 1 > d.reached ? "disabled" : ""} ${index + 1 === step ? 'aria-current="step"' : ""}><span>${index + 1 < step ? I("check") : index + 1}</span>${label}</button>`,
      )
      .join("")}</nav>`;
  }
  function sourceFields(d) {
    const s = d.source,
      names = sourceNames();
    return `${field(
      "setup-source-kind",
      t("第一份知识来源", "Your first source"),
      `<select id="setup-source-kind" name="source-kind">${Object.entries(names)
        .map(
          ([value, label]) =>
            `<option value="${value}" ${s.kind === value ? "selected" : ""}>${label}</option>`,
        )
        .join("")}</select>`,
    )}${s.kind === "later" ? `<div class="setup-source-later">${I("file")}<h3>${t("先创建，再慢慢充实。", "Create first. Grow it over time.")}</h3><p>${t("知识管理支持文档、音频、GitHub、网页、整站与文本，之后可分组、批量整理。", "Add documents, audio, GitHub, web pages, websites or text later. Organize them with folders and bulk actions.")}</p></div>` : s.kind === "text" ? `${field("setup-source-title", t("来源标题", "Source title"), `<input id="setup-source-title" name="source-title" maxlength="100" value="${esc(s.title)}" required>`)}${field("setup-source-text", t("知识正文", "Knowledge content"), `<textarea id="setup-source-text" name="source-text" rows="8" maxlength="30000" required>${esc(s.text)}</textarea>`, t("每 1,000 字符约 1 credit，创建时才开始处理。", "About 1 credit per 1,000 characters. Processing starts after creation."))}` : ["document", "audio"].includes(s.kind) ? `<div class="setup-file"><input type="file" id="setup-source-file" accept="${s.kind === "audio" ? ".mp3,.m4a,.wav" : ".pdf,.docx,.md,.txt"}"><p>${esc(file?.name || s.fileName || t("尚未选择文件", "No file selected"))}</p><small>${s.kind === "audio" ? "MP3 / M4A / WAV · 100 MB" : "PDF / DOCX / MD / TXT · 20 MB"} · ${t("刷新后请重新选择文件。", "Reselect after a refresh.")}</small></div>` : `${field("setup-source-url", t("来源地址", "Source URL"), `<input id="setup-source-url" name="source-url" type="url" value="${esc(s.url)}" placeholder="https://" required>`)}${s.kind === "github" ? `<label class="check-row"><input type="checkbox" name="source-private" ${s.private ? "checked" : ""}>${t("这是私有仓库（需已连接 GitHub）", "Private repository (requires GitHub connection)")}</label>` : ""}${s.kind === "site" ? `<p class="form-hint">${t("整站抓取需要先验证域名。", "Website crawls require domain verification.")}</p>` : ""}`}${s.kind === "audio" ? `<label class="check-row setup-audio-consent"><input type="checkbox" name="audio-consent" ${s.consent ? "checked" : ""} required>${t("我了解真实产品需将音频发送给转写服务；当前仅本地演示。", "I understand the real product uses a transcription service. This prototype is local only.")}</label>` : ""}<div class="info-strip mt24">${I("info")}<span>${t("选择来源不会立即扣费。下一步确认费用，点击创建后才处理。", "Selecting a source does not charge credits. Review the cost before creating.")}</span></div>`;
  }
  function estimatedCost(d) {
    const kind = d.source.kind;
    return kind === "later"
      ? 0
      : kind === "text"
        ? Math.max(1, Math.ceil(d.source.text.trim().length / 1000))
        : kind === "audio"
          ? 300
          : kind === "github"
            ? 120
            : kind === "site"
              ? 500
              : 20;
  }
  function wizardPage(query) {
    const d = draft(),
      step = Math.min(
        4,
        Math.max(1, Number(query.get("step")) || d.step),
        d.reached,
      );
    const content =
      step === 1
        ? identity(d)
        : step === 2
          ? personality(d, true)
          : step === 3
            ? sourceFields(d)
            : `${publishing(d)}<div class="setup-review"><h3>${t("创建前确认", "Ready to create")}</h3><div>${avatar(d)}<strong>${esc(d.name)}</strong><span class="tag">${classification.categoryLabel(d)}</span></div><p>${esc(d.description)}</p><dl><div><dt>${t("细分标签", "Tags")}</dt><dd>${d.tags.map(esc).join(" · ") || "—"}</dd></div><div><dt>${t("第一份知识", "First source")}</dt><dd>${esc(d.source.kind === "later" ? sourceNames().later : d.source.title || d.source.fileName || d.source.url || sourceNames()[d.source.kind])}</dd></div><div><dt>${t("预计处理费用", "Estimated processing cost")}</dt><dd>${n(estimatedCost(d))} credits</dd></div></dl><small>${t("创建本身免费。文档与文本按实际可读取内容计费；处理失败会退回预留额度。", "Creation is free. Document and text costs use readable content; failed processing releases the reserved credits.")}</small></div>`;
    return shell(
      `<div class="page dot-setup-page"><div class="setup-page-heading"><div><p class="eyebrow">GIVE YOUR KNOWLEDGE A NEW POSSIBILITY</p><h1>${t("创建你的 Ree", "Create your Ree")}</h1><p>${t("从一个名字开始，准备好它的知识、个性与公开方式。", "Start with a name, then shape its knowledge, personality and audience.")}</p></div><button class="btn secondary sm" data-action="setup-exit">${t("保存草稿并退出", "Save draft & exit")}</button></div><div class="setup-wizard-grid"><form id="dot-setup-form" data-step="${step}"><section class="card setup-section"><div class="setup-step-title"><span>0${step} / 04</span><h2>${labels()[step - 1]}</h2></div>${errorMessage ? `<p class="form-error" role="alert">${esc(errorMessage)}</p>` : ""}${content}<div class="setup-step-actions">${step > 1 ? `<button type="button" class="btn secondary" data-action="setup-back">${I("arrow")}${t("上一步", "Back")}</button>` : `<a class="text-link" href="#/dots">${t("返回我的 Ree", "Back to my Rees")}</a>`}<button type="submit" class="btn" ${creating ? "disabled" : ""}>${step === 4 ? t("创建 Ree", "Create Ree") : t("下一步", "Continue")}${I(step === 4 ? "check" : "arrow")}</button></div></section></form><aside class="setup-wizard-note"><span>${I("dot")}</span><h2>${[t("一个清楚的名字，一个新的起点。", "A clear identity. A new beginning."), t("让知识带着你的表达方式回答。", "Let knowledge answer in your voice."), t("先从一份最了解的资料开始。", "Begin with a source you know well."), t("准备好了，就让它开始回应。", "Ready to give your knowledge a voice.")][step - 1]}</h2><p>${t("步骤切换时保存草稿，完成创建前不会生成 Ree。你可以随时回来继续。", "Drafts are saved when you change steps. No Ree is created until you finish. Return anytime to continue.")}</p><button class="text-link" data-action="setup-restart">${I("refresh")}${t("重新开始", "Start over")}</button></aside></div>${footer()}</div>`,
    );
  }
  function capture(form) {
    if (!form) return;
    const d = draft(),
      f = new FormData(form),
      step = Number(form.dataset.step);
    for (const key of [
      "name",
      "description",
      "prompt",
      "samples",
      "category",
      "visibility",
      "fee",
      "color",
    ])
      if (f.has(key)) d[key] = String(f.get(key));
    if (f.has("avatar")) d.avatar = dotAvatarValue(f.get("avatar"));
    if (step === 2) d.tags = f.getAll("tags");
    for (const [field, key] of [
      ["source-kind", "kind"],
      ["source-title", "title"],
      ["source-text", "text"],
      ["source-url", "url"],
    ])
      if (f.has(field)) d.source[key] = String(f.get(field));
    if (step === 3) {
      d.source.private = f.has("source-private");
      d.source.consent = f.has("audio-consent");
    }
    d.step = step;
  }
  function formError(form, message) {
    form.querySelector(".form-error")?.remove();
    form.insertAdjacentHTML(
      "afterbegin",
      `<p class="form-error" role="alert">${esc(message)}</p>`,
    );
    form
      .querySelector(".form-error")
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  async function onSubmit(form, f) {
    if (form.id === "dot-settings-form") {
      const dot = ctx.dotById(form.dataset.id);
      if (!dot || dot.owner !== "me") return true;
      const data = {
        name: String(f.get("name") || ""),
        description: String(f.get("description") || ""),
        prompt: String(f.get("prompt") || ""),
        samples: String(f.get("samples") || ""),
        category: String(f.get("category") || ""),
        tags: f.getAll("tags"),
        fee: f.get("fee"),
        avatar: f.get("avatar"),
        color: f.get("color"),
        visibility: dot.moderated ? "private" : f.get("visibility"),
      };
      const invalid = validateDotDraft(data, 4);
      if (invalid) {
        formError(form, messages()[invalid.error]);
        return true;
      }
      const saved = dotFromDraft(data, dot.id);
      for (const key of [
        "name",
        "enName",
        "description",
        "enDescription",
        "avatar",
        "color",
        "category",
        "tags",
        "prompt",
        "samples",
        "public",
        "fee",
      ])
        dot[key] = saved[key];
      save();
      render();
      toast(t("设置已保存", "Settings saved"));
      return true;
    }
    if (form.id !== "dot-setup-form") return false;
    if (creating) return true;
    capture(form);
    const d = draft(),
      step = Number(form.dataset.step),
      invalid = validateDotDraft(d, step === 3 ? 2 : step);
    if (invalid) {
      errorMessage = messages()[invalid.error];
      save();
      go("/dots/new?step=" + invalid.step);
      return true;
    }
    if (step === 3) {
      try {
        if (d.source.kind === "audio" && !d.source.consent)
          throw new Error("audio-consent");
        await prepareSetupSource(d.source, S(), file);
      } catch (error) {
        formError(
          form,
          messages()[error.message] ||
            t(
              "请确认来源信息与音频转写同意项。",
              "Check source details and audio consent.",
            ),
        );
        return true;
      }
    }
    errorMessage = "";
    if (step < 4) {
      d.reached = Math.max(d.reached, step + 1);
      d.step = step + 1;
      save();
      go("/dots/new?step=" + d.step);
      return true;
    }
    creating = true;
    try {
      let prepared;
      try {
        if (d.source.kind === "audio" && !d.source.consent)
          throw new Error("audio-consent");
        prepared = await prepareSetupSource(d.source, S(), file);
      } catch (error) {
        formError(
          form,
          messages()[error.message] ||
            t(
              "请返回上一步检查来源信息。",
              "Go back and check the source details.",
            ),
        );
        return true;
      }
      if (prepared.cost && !ctx.debit(prepared.cost)) {
        formError(
          form,
          t(
            "可用 credits 不足，请补充余额或返回选择稍后添加知识。",
            "Insufficient credits. Add credits or choose to add knowledge later.",
          ),
        );
        return true;
      }
      const dot = dotFromDraft(d, uid());
      if (prepared.source) {
        const source = {
          ...prepared.source,
          id: uid(),
          status: "processing",
          hold: U().lastDeduction,
          processingCost: prepared.cost,
          locator: t("等待解析与索引", "Preparing and indexing"),
          simulateFailure: /fail|失败/i.test(prepared.source.title),
        };
        knowledge.ingested(dot, source, file);
        dot.knowledge.push(source);
        ctx.creditEntry(
          source.title + " · " + t("知识处理预留", "Knowledge processing"),
          -prepared.cost,
          "knowledge",
        );
      }
      S().dots.push(dot);
      delete S().dotSetupDraft;
      save();
      file = null;
      if (dot.knowledge[0])
        ctx.scheduleProcessing(
          dot,
          dot.knowledge[0],
          prepared.cost,
          dot.knowledge[0].simulateFailure,
        );
      go(
        "/dots/" + dot.id + (dot.knowledge.length ? "/knowledge" : "/settings"),
      );
      toast(
        t(
          "Ree 已创建，随时可以继续完善和测试。",
          "Ree created. Continue shaping and testing it anytime.",
        ),
      );
    } finally {
      creating = false;
    }
    return true;
  }
  async function onAction(action, data, el) {
    if (action === "setup-color") {
      document.querySelector('input[name="color"]').value = data.value;
      dotAvatar.setColor(data.value);
      for (const button of document.querySelectorAll(
        '[data-action="setup-color"]',
      )) {
        button.classList.toggle("active", button === el);
        button.setAttribute("aria-pressed", String(button === el));
      }
      return true;
    }
    if (action === "dot-settings-reset") {
      render();
      return true;
    }
    if (!action.startsWith("setup-")) return false;
    const form = document.querySelector("#dot-setup-form");
    if (action === "setup-restart") {
      ctx.confirmModal(
        t("重新开始创建？", "Start over?"),
        t(
          "只会清除此创建草稿，已有 Ree 不受影响。",
          "Only this setup draft will be cleared. Existing Rees are preserved.",
        ),
        t("重新开始", "Start over"),
        () => {
          S().dotSetupDraft = newDotDraft();
          file = null;
          errorMessage = "";
          save();
          go("/dots/new?step=1");
        },
      );
      return true;
    }
    if (dotAvatar.beforeSubmit(form)) return true;
    capture(form);
    save();
    errorMessage = "";
    if (action === "setup-exit") go("/dots");
    if (action === "setup-back") {
      draft().step = Math.max(1, draft().step - 1);
      save();
      go("/dots/new?step=" + draft().step);
    }
    if (action === "setup-step" && Number(data.value) <= draft().reached) {
      draft().step = Number(data.value);
      save();
      go("/dots/new?step=" + data.value);
    }
    return true;
  }
  function resolve(path, query) {
    if (!S().signed || S().disabled) return null;
    if (path === "/dots/new")
      return { html: wizardPage(query), title: t("创建 Ree", "Create Ree") };
    const match = path.match(/^\/dots\/([^/]+)(?:\/(settings))?$/);
    if (!match) return null;
    const dot = ctx.dotById(match[1]);
    if (!dot || dot.owner !== "me") return { redirect: "/dots" };
    return match[2]
      ? { html: settingsPage(dot), title: t("Ree 设置", "Ree settings") }
      : { redirect: "/dots/" + dot.id + "/settings" };
  }
  document.addEventListener("change", (event) => {
    if (event.target.id === "setup-source-kind") {
      capture(event.target.form);
      file = null;
      draft().source.fileName = "";
      save();
      render();
    }
    if (event.target.id === "setup-source-file") {
      file = event.target.files?.[0] || null;
      draft().source.fileName = file?.name || "";
      save();
    }
  });
  return { resolve, onAction, onSubmit, headerSteps };
}
