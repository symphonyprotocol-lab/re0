export const DOT_CATEGORIES = [
  {
    id: "technology",
    name: "技术与 AI",
    en: "Technology & AI",
    tags: [
      "技术开发",
      "AI 应用",
      "React",
      "Next.js",
      "Python",
      "数据分析",
      "开源项目",
      "自动化",
    ],
  },
  {
    id: "design",
    name: "设计与创作",
    en: "Design & creation",
    tags: [
      "产品设计",
      "用户体验",
      "设计系统",
      "视觉设计",
      "品牌设计",
      "内容创作",
      "摄影",
      "视频制作",
    ],
  },
  {
    id: "business",
    name: "商业与职场",
    en: "Business & work",
    tags: [
      "商业增长",
      "市场营销",
      "产品管理",
      "独立开发",
      "创业",
      "团队管理",
      "职场技能",
      "销售",
    ],
  },
  {
    id: "learning",
    name: "学习与研究",
    en: "Learning & research",
    tags: [
      "阅读写作",
      "学习方法",
      "语言学习",
      "科学研究",
      "历史",
      "教育",
      "读书笔记",
      "知识管理",
    ],
  },
  {
    id: "professional",
    name: "专业知识",
    en: "Professional knowledge",
    tags: [
      "金融财经",
      "法律合规",
      "医学健康",
      "工程制造",
      "建筑",
      "行业研究",
      "财务会计",
      "供应链",
    ],
  },
  {
    id: "life",
    name: "生活与兴趣",
    en: "Life & interests",
    tags: [
      "生活方式",
      "旅行文化",
      "艺术鉴赏",
      "运动健身",
      "个人成长",
      "效率工具",
      "烹饪",
      "音乐",
    ],
  },
  { id: "other", name: "其他知识", en: "Other knowledge", tags: [] },
];
export function dotCategory(dot) {
  if (DOT_CATEGORIES.some((c) => c.id === dot.category)) return dot.category;
  for (const tag of dot.tags || []) {
    const category = DOT_CATEGORIES.find((c) =>
      c.tags.some(
        (value) =>
          value.toLocaleLowerCase() === String(tag).toLocaleLowerCase(),
      ),
    );
    if (category) return category.id;
  }
  return "other";
}
export function normalizedTag(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}
export function classificationValue(category, rawTags) {
  if (!DOT_CATEGORIES.some((c) => c.id === category))
    return { error: "category" };
  const tags = [];
  for (const raw of rawTags) {
    const tag = normalizedTag(raw);
    if (!tag) continue;
    if (Array.from(tag).length > 20) return { error: "length" };
    if (
      !tags.some(
        (value) => value.toLocaleLowerCase() === tag.toLocaleLowerCase(),
      )
    )
      tags.push(tag);
  }
  if (tags.length > 3) return { error: "limit" };
  return { category, tags };
}
export function createDotClassification(ctx) {
  const { t, I, esc } = ctx;
  const label = (c) => t(c.name, c.en);
  const root = () => document.querySelector(".dot-classification-editor");
  const selected = (el) =>
    [...el.querySelectorAll('input[name="tags"]')].map((input) => input.value);
  function error(el, message = "") {
    const output = el.querySelector('[role="alert"]');
    output.textContent = message;
    output.hidden = !message;
  }
  function chips(tags) {
    return tags
      .map(
        (tag) =>
          `<span class="classification-chip"><input type="hidden" name="tags" value="${esc(tag)}"><span>${esc(tag)}</span><button type="button" data-action="classification-remove" data-tag="${esc(tag)}" aria-label="${esc(t("移除标签：", "Remove tag: ") + tag)}">${I("close")}</button></span>`,
      )
      .join("");
  }
  function suggestions(el) {
    const tags = selected(el),
      q = normalizedTag(el.querySelector("[data-tag-search]").value);
    const category = DOT_CATEGORIES.find(
      (c) => c.id === el.querySelector('[name="category"]').value,
    );
    const pool = q
      ? DOT_CATEGORIES.flatMap((c) => c.tags)
      : category?.tags || [];
    const options = pool
      .filter(
        (tag) =>
          !tags.some(
            (value) => value.toLocaleLowerCase() === tag.toLocaleLowerCase(),
          ) &&
          (!q || tag.toLocaleLowerCase().includes(q.toLocaleLowerCase())),
      )
      .slice(0, 8);
    el.querySelector(".classification-suggestions").innerHTML =
      options
        .map(
          (tag) =>
            `<button type="button" class="classification-suggestion" data-action="classification-add" data-tag="${esc(tag)}" ${tags.length >= 3 ? "disabled" : ""}>${I("plus")}${esc(tag)}</button>`,
        )
        .join("") ||
      `<span class="classification-hint">${q ? t("没有匹配的推荐标签，可添加自己的标签。", "No matching suggestions. Add your own tag.") : t("选择主分类可查看推荐标签，也可以添加自己的标签。", "Choose a category for suggestions, or add your own tag.")}</span>`;
    el.querySelector(".classification-count").textContent =
      tags.length + " / 3";
    el.querySelector('[data-action="classification-custom"]').disabled =
      !q || tags.length >= 3;
  }
  function editor(dot, { creating = false } = {}) {
    const category = dot && (!creating || dot.category) ? dotCategory(dot) : "";
    const tags = dot?.tags || [];
    const html = `<section class="dot-classification-editor"><div class="field"><label for="dot-category">${t("主分类（选 1 个）", "Primary category (choose one)")}</label><select id="dot-category" name="category" required><option value="" ${!category ? "selected" : ""} disabled>${t("请选择主分类", "Choose a category")}</option>${DOT_CATEGORIES.map((c) => `<option value="${c.id}" ${category === c.id ? "selected" : ""}>${label(c)}</option>`).join("")}</select><small>${t("用于发现页筛选，选择最贴近这个 Ree 的领域。", "Used for discovery filters. Choose this Ree's main subject.")}</small></div><div class="between classification-label"><span class="field-label">${t("细分标签（最多 3 个）", "Topic tags (up to three)")}</span><span class="classification-count">${tags.length} / 3</span></div><div class="classification-selected">${chips(tags)}</div><div class="classification-search">${I("search")}<input type="search" data-tag-search aria-label="${t("搜索或添加标签", "Search or add tags")}" placeholder="${t("如 React、设计系统、读书笔记…", "e.g. React, design systems, reading notes…")}" maxlength="100"><button type="button" class="btn secondary sm" data-action="classification-custom" disabled>${t("添加", "Add")}</button></div><div class="classification-suggestions">${(
      DOT_CATEGORIES.find((c) => c.id === category)?.tags || []
    )
      .filter((tag) => !tags.includes(tag))
      .slice(0, 8)
      .map(
        (tag) =>
          `<button type="button" class="classification-suggestion" data-action="classification-add" data-tag="${esc(tag)}" ${tags.length >= 3 ? "disabled" : ""}>${I("plus")}${esc(tag)}</button>`,
      )
      .join(
        "",
      )}</div><small class="classification-hint">${t("标签可跨领域，也可自定义；每个最多 20 个字符。", "Tags can cross subjects or be custom; up to 20 characters each.")}</small><p class="classification-error" role="alert" hidden></p></section>`;
    return html;
  }
  function add(el, raw) {
    const tag = normalizedTag(raw),
      tags = selected(el);
    if (!tag) return;
    if (Array.from(tag).length > 20)
      return error(
        el,
        t("每个标签最多 20 个字符。", "Tags can contain up to 20 characters."),
      );
    if (
      tags.some(
        (value) => value.toLocaleLowerCase() === tag.toLocaleLowerCase(),
      )
    )
      return error(
        el,
        t("这个标签已经添加。", "This tag is already selected."),
      );
    if (tags.length >= 3)
      return error(
        el,
        t(
          "最多添加 3 个标签，请先移除一个。",
          "Up to three tags. Remove one first.",
        ),
      );
    el.querySelector(".classification-selected").innerHTML = chips([
      ...tags,
      tag,
    ]);
    el.querySelector("[data-tag-search]").value = "";
    error(el);
    suggestions(el);
  }
  async function onAction(action, data) {
    if (!action.startsWith("classification-")) return false;
    const el = root();
    if (!el) return true;
    if (action === "classification-remove") {
      el.querySelector(".classification-selected").innerHTML = chips(
        selected(el).filter((tag) => tag !== data.tag),
      );
      error(el);
      suggestions(el);
    }
    if (action === "classification-add") add(el, data.tag);
    if (action === "classification-custom")
      add(el, el.querySelector("[data-tag-search]").value);
    return true;
  }
  function validate(category, tags) {
    const value = classificationValue(category, tags);
    if (value.error) {
      const el = root();
      if (el)
        error(
          el,
          value.error === "category"
            ? t("请选择一个主分类。", "Choose a primary category.")
            : value.error === "length"
              ? t(
                  "每个标签最多 20 个字符。",
                  "Tags can contain up to 20 characters.",
                )
              : t("最多添加 3 个标签。", "Up to three tags."),
        );
    }
    return value;
  }
  document.addEventListener("input", (event) => {
    if (event.target.matches("[data-tag-search]"))
      suggestions(event.target.closest(".dot-classification-editor"));
  });
  document.addEventListener("change", (event) => {
    if (event.target.id === "dot-category") {
      const el = event.target.closest(".dot-classification-editor");
      error(el);
      suggestions(el);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.target.matches("[data-tag-search]") &&
      event.key === "Enter" &&
      !event.isComposing
    ) {
      event.preventDefault();
      add(
        event.target.closest(".dot-classification-editor"),
        event.target.value,
      );
    }
  });
  return {
    editor,
    onAction,
    validate,
    categoryLabel: (dot) =>
      label(DOT_CATEGORIES.find((c) => c.id === dotCategory(dot))),
  };
}
