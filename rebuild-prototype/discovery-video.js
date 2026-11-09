// External sample Rees ship with introductions; owned drafts need a generated script.
export function hasVideoIntroduction(dot) {
  return (
    !!dot && (dot.video ? dot.video.generated === true : dot.owner !== "me")
  );
}
// The built-in RE0 assistant has a default public introduction even when its
// authoring draft has not been generated. Other owned drafts stay unpublished.
export function hasPublicVideoIntroduction(dot) {
  return hasVideoIntroduction(dot) || !!dot && dot.id === "mine" && dot.slug === "re0-product";
}
export function publicVideoSource(dot) {
  return !dot || hasVideoIntroduction(dot) ? dot : { ...dot, video: undefined };
}
export function discoveryVideoStyle(dot) {
  const templates = ["editorial", "blueprint", "spotlight"];
  return {
    template: templates.includes(dot.video?.template)
      ? dot.video.template
      : "editorial",
    accent: /^#[0-9a-f]{6}$/i.test(dot.video?.accent || "")
      ? dot.video.accent
      : "#127ee3",
  };
}

// Shared empty state for discovery covers and public detail pages.
export function renderVideoPlaceholder(dot, { t, I, esc, title, avatar }) {
  return `<div class="public-dot-video-placeholder" role="img" aria-label="${esc(title(dot) + t("：暂无视频介绍", ": No video introduction yet"))}"><span class="public-dot-video-placeholder-brand" aria-hidden="true">RE0 <span>YOUR KNOWLEDGE. A NEW VOICE.</span></span><div>${avatar(dot)}<strong>${esc(title(dot))}</strong><span class="public-dot-video-placeholder-status">${I("film")}${t("暂无视频介绍", "No video introduction yet")}</span></div><span class="public-dot-video-placeholder-caption" aria-hidden="true">${t("认识这个 Ree，从一次对话开始。", "Get to know this Ree through a conversation.")}</span></div>`;
}
