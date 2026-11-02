export function conversationReadiness(dot) {
  const sources = dot.knowledge || [];
  return {
    ready: sources.filter(
      (source) => source.status === "ready" && source.enabled !== false,
    ).length,
    processing: sources.filter(
      (source) =>
        ["pending", "processing"].includes(source.status) &&
        source.enabled !== false,
    ).length,
  };
}

export function createDotConversation(ctx) {
  const { t, I, esc, title, avatar, fee } = ctx;
  const U = ctx.getUi;
  function empty(dot) {
    const readiness = conversationReadiness(dot);
    const heading = readiness.ready
      ? t("让你的知识，开口回答。", "Give your knowledge a voice.")
      : readiness.processing
        ? t("知识正在整理，稍等片刻。", "Your knowledge is getting ready.")
        : t("这个 Ree，还在等待知识。", "This Ree is waiting for knowledge.");
    const description = readiness.ready
      ? t(
          "问一个你熟悉的问题，看看它能否清楚回答，并给出依据。",
          "Ask a question you know well. See how clearly it answers and cites its sources.",
        )
      : readiness.processing
        ? t(
            "处理完成后，即可在这里检验回答效果。你也可以先写下想测试的问题。",
            "Test its answers once processing finishes. You can prepare a question now.",
          )
        : t(
            "在「知识管理」中准备好资料后，再回来试试。它不会在缺少依据时编造答案。",
            "Prepare sources in Knowledge, then return to try it. It will not invent answers without evidence.",
          );
    return `<div class="studio-empty"><span class="studio-empty-mark">${avatar(dot)}</span><span class="studio-eyebrow">YOUR KNOWLEDGE. YOUR NEXT QUESTION.</span><h1>${heading}</h1><p>${description}</p>${
      readiness.ready && dot.samples?.length
        ? `<div class="studio-starters">${dot.samples
            .slice(0, 3)
            .map(
              (question, i) =>
                `<button type="button" data-action="studio-prompt" data-value="${esc(question)}"><span>0${i + 1}</span><strong>${esc(question)}</strong>${I("arrow")}</button>`,
            )
            .join("")}</div>`
        : `<div class="studio-empty-assurance">${I("shield")}${t("知识未就绪或无法作答时，不收取回答费用。", "No answer fees when knowledge is unavailable or no answer is given.")}</div>`
    }</div>`;
  }
  function unanswered(message, dot) {
    const readiness = conversationReadiness(dot);
    const missing =
      message.reason === "no-sources" || (!message.reason && !readiness.ready);
    return `<article class="message studio-unanswered" data-message="${esc(message.id)}"><div class="message-head">${avatar(dot, true)}<strong>${esc(title(dot))}</strong>${ctx.userRoles?.badgeForRee(dot)||""}<small>${t("知识范围提示", "Knowledge boundary")}</small></div><div class="studio-unanswered-body"><span class="studio-unanswered-icon">${I("file")}</span><div><h3>${missing ? t("目前还没有可用的知识依据", "No knowledge is available yet") : t("这个问题，暂时超出了我的知识范围", "This question is outside my knowledge for now")}</h3><p>${missing ? t("这个 Ree 暂无已就绪、已启用的知识，因此无法给出有依据的回答。", "This Ree has no ready, enabled sources to ground an answer.") : t("现有知识里没有找到足够的依据。试着补充问题的背景，或换一个更具体的问法。", "The available knowledge did not provide enough evidence. Add some context or ask a more specific question.")}</p><span class="studio-no-charge">${I("shield")}${t("未作答 · 本次未收费", "No answer · No credits charged")}</span></div></div></article>`;
  }
  function composer(dot) {
    const ready = conversationReadiness(dot).ready;
    return `<div class="studio-compose-dock"><div class="studio-compose-inner"><form id="compose" class="composer studio-composer" data-context="dot:${esc(dot.id)}"><div id="mention-menu"></div><textarea id="message-input" aria-label="${t("输入你的问题", "Your question")}" placeholder="${ready ? t("问一个关于这个 Ree 的问题…", "Ask this Ree a question…") : t("写下你想测试的问题…", "Write a question to test…")}" rows="2" maxlength="4000" required ${U().busy ? "disabled" : ""}></textarea><div class="studio-compose-tools"><span class="studio-current-dot">${avatar(dot, true)}<span>${esc(title(dot))}</span></span><div>${
      dot.samples?.length
        ? `<details class="studio-examples"><summary>${I("light")}${t("示例问题", "Example questions")}${I("down")}</summary><div class="studio-example-popover"><strong>${t("试着问问", "Try asking")}</strong>${dot.samples
            .slice(0, 3)
            .map(
              (question) =>
                `<button type="button" data-action="studio-prompt" data-value="${esc(question)}">${esc(question)}${I("arrow")}</button>`,
            )
            .join("")}</div></details>`
        : ""
    }<button type="submit" class="btn studio-send" aria-label="${t("发送问题", "Send question")}" ${U().busy ? "disabled" : ""}>${U().busy ? '<i class="spinner"></i>' : I("send")}</button></div></div></form><div class="studio-compose-meta"><span>${I("shield")}<span id="cost-label">${t("最多", "Up to")} <strong>${fee(dot)}</strong> credits</span><span class="studio-no-answer-note">· ${t("未作答不收费", "No answer, no charge")}</span></span><small>${t("Enter 发送 · Shift + Enter 换行", "Enter to send · Shift + Enter for a new line")}</small></div><p class="studio-demo-note">${t("本地演示回答 · 回答依据与引用随消息展示", "Local demo answers · Evidence and citations appear with each response")}</p></div></div>`;
  }
  function page(dot, messages) {
    const readiness = conversationReadiness(dot);
    return `<section class="work-page dot-test-page studio-conversation" aria-label="${esc(title(dot))} · ${t("对话", "Chat")}"><header class="studio-chat-toolbar"><div class="studio-chat-identity">${avatar(dot)}<div><strong>${esc(title(dot))}</strong><span>${t("仅基于当前启用的知识作答", "Answers grounded in enabled knowledge")}</span></div></div><div class="studio-chat-actions"><span class="studio-readiness ${readiness.ready ? "ready" : "waiting"}"><i></i>${readiness.ready ? t("可以开始对话", "Ready to chat") : readiness.processing ? t("知识整理中", "Preparing knowledge") : t("知识未就绪", "Knowledge not ready")}</span><button type="button" class="studio-clear" data-action="studio-clear" data-id="${esc(dot.id)}" ${!messages.length || U().busy ? "disabled" : ""}>${I("trash")}${t("清空对话", "Clear chat")}</button></div></header><div class="chat-area dot-test-chat"><div class="chat-transcript studio-messages ${messages.length ? "has-messages" : "is-empty"}" id="transcript" role="region" aria-label="${t("对话消息", "Conversation messages")}" tabindex="0">${messages.length ? `<div class="studio-thread">${messages.map(ctx.messageHTML).join("")}</div>` : empty(dot)}</div>${composer(dot)}</div></section>`;
  }
  function syncComposer() {
    const input = document.querySelector(".studio-composer textarea");
    if (!input) return;
    const send = input.form.querySelector('button[type="submit"]');
    if (send) send.disabled = !!U().busy || !input.value.trim();
    input.style.height = "auto";
    input.style.height = Math.min(160, Math.max(52, input.scrollHeight)) + "px";
  }
  async function onAction(action, data) {
    if (action === "studio-clear") {
      const dot = ctx.dotById(data.id);
      const key = `dot:${data.id}`;
      const canClear = () =>
        ctx.getState().signed &&
        ctx.dotById(data.id)?.owner === "me" &&
        ctx.route().path === `/dots/${data.id}/chat` &&
        !U().busy &&
        ctx.getState().dotMessages?.[key]?.length;
      if (!canClear()) return true;
      ctx.confirmModal(
        t("清空当前对话？", "Clear this conversation?"),
        t(
          `将清空「${esc(title(dot))}」在此页面的全部测试消息，清空后无法恢复。知识来源、累计使用统计与已产生的费用不受影响。`,
          `All test messages for “${esc(title(dot))}” on this page will be permanently cleared. Knowledge sources, cumulative usage and previous charges remain unchanged.`,
        ),
        t("清空对话", "Clear chat"),
        () => {
          if (!canClear()) return;
          ctx.getState().dotMessages[key] = [];
          ctx.save();
          ctx.render();
          ctx.toast(
            t(
              "对话已清空，可以重新测试了",
              "Conversation cleared. Ready to test again.",
            ),
          );
          document.querySelector(".studio-composer textarea")?.focus();
        },
        true,
      );
      return true;
    }
    if (action !== "studio-prompt") return false;
    const input = document.querySelector(".studio-composer textarea");
    if (!input || U().busy) return true;
    input.value = data.value;
    input.form.querySelector("details")?.removeAttribute("open");
    input.focus();
    ctx.updateCompose(false);
    syncComposer();
    return true;
  }
  document.addEventListener("input", (event) => {
    if (event.target.matches(".studio-composer textarea")) syncComposer();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape")
      document.querySelector(".studio-examples[open]")?.removeAttribute("open");
  });
  document.addEventListener("click", (event) => {
    const examples = document.querySelector(".studio-examples[open]");
    if (examples && !examples.contains(event.target))
      examples.removeAttribute("open");
  });
  return { page, unanswered, onAction, afterRender: syncComposer };
}
