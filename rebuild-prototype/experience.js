// Separate conversation creation from the workspace overview.
export function createExperience(ctx) {
  const { t, I, esc, uid, route, go, save, render, toast } = ctx;
  const S = () => ctx.getState(), U = () => ctx.getUi();
  const home = () => "/dashboard";
  const label = () => t("工作台", "Dashboard");
  function safeNext(value) {
    if (!value || !value.startsWith("/") || /[\\\x00-\x20]/.test(value) || value.startsWith("//")) return "";
    return /^\/(?:dashboard|checkout|explore|billing|settings|videos|dots|chats|workspace|talk|d)(?:\/|$)/.test(value.split("?")[0]) ? value : "";
  }
  function newConversationPage() {
    const prompts = [
      t("设计和前端如何协作搭建设计系统？", "How can design and frontend build a design system together?"),
      t("梳理知识里的关键观点", "Find the key ideas in my knowledge"),
    ];
    return `<section class="new-conversation-page" aria-labelledby="new-conversation-heading"><div class="new-conversation-stage"><header class="new-conversation-heading"><p class="eyebrow">A GOOD CONVERSATION STARTS HERE</p><h1 id="new-conversation-heading">${t("新建对话", "New conversation")}</h1><p>${t("选择知识伙伴，让一个好问题开启对话。", "Choose your knowledge companions and start with a good question.")}</p></header><div class="new-conversation-composer" aria-label="${t("开始对话", "Start a conversation")}">${ctx.chatRoom.composer(ctx.chatRoom.draftChat())}</div><div class="conversation-prompts"><span>${t("试着问问", "Try asking")}</span>${prompts.map(p => `<button type="button" data-action="talk-prompt" data-question="${esc(p)}">${I("sparkle")}${esc(p)}</button>`).join("")}</div></div></section>`;
  }
  function resolve(path, query) {
    const protectedPage = /^\/(dashboard|workspace|talk|welcome|dots|videos|chats|billing|settings)(\/|$)/.test(path);
    if (!S().signed) return protectedPage ? { redirect: "/login?next=" + encodeURIComponent(path + (query.size ? "?" + query : "")) } : null;
    if (S().disabled) return null;
    if (path === "/talk") return { html: ctx.shell(newConversationPage()), title: t("新建对话", "New conversation") };
    if (path === "/billing") return { redirect: "/settings?tab=billing" };
    if (["/workspace", "/welcome"].includes(path))
      return { redirect: path === "/welcome" ? safeNext(query.get("next")) || home() : home() };
    return null;
  }
  function signIn(next) { go(safeNext(next) || home()); }
  async function onAction(a, d) {
    if (a === "new-chat" || a === "experience-switch") {
      if (U().busy) {
        toast(t("请等待当前回答结束", "Wait for the current response"));
        return true;
      }
      const destination = a === "new-chat" ? "/talk" : home();
      if (a === "new-chat") {
        ctx.chatRoom.clearDraft();
        U().focusConversationComposer = true;
      }
      if (route().path === destination) render();
      else go(destination);
      return true;
    }
    if (a === "talk-prompt") {
      const input = document.querySelector("#message-input");
      if (input && !U().busy) {
        input.value = d.question;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
      }
      return true;
    }
    return false;
  }
  async function onSubmit(form, f) {
    if (
      form.id === "compose" &&
      form.dataset.context === ctx.chatRoom.draftContext
    ) {
      const text = String(f.get("question") || "").trim(),
        draft = ctx.chatRoom.draftChat(),
        dots = [...draft.dots];
      if (!text || U().busy) return true;
      if (!ctx.chatRoom.targets(draft, text).length) {
        toast(t("请选择参与者，或使用完整的 @Ree 名称", "Choose a participant or use a complete @Ree name"));
        return true;
      }
      const id = uid(),
        at = new Date().toISOString();
      S().chats.unshift({
        id,
        title: text.slice(0, 80),
        dots,
        messages: [],
        updated: t("刚刚", "Just now"),
        createdAt: at,
        updatedAt: at,
      });
      ctx.chatRoom.transferDraftScope(id);
      ctx.chatRoom.clearDraft();
      U().talkSubmission = { id, text };
      save();
      go("/chats/" + id);
      return true;
    }
    return false;
  }
  function afterRender() {
    if (U().focusConversationComposer && route().path === "/talk") {
      U().focusConversationComposer = false;
      document.querySelector("#message-input")?.focus();
    }
    const pending = U().talkSubmission;
    if (pending) {
      U().talkSubmission = null;
      if (route().path === "/chats/" + pending.id)
        queueMicrotask(() =>
          ctx.sendMessage("chat:" + pending.id, pending.text),
        );
    }
  }
  return { home, label, newConversationPage, resolve, signIn, onAction, onSubmit, afterRender };
}
