// Focused conversation view for the chat experience.
export function createChatRoom(ctx) {
  const {
    t,
    I,
    esc,
    title,
    desc,
    avatar,
    fee,
    dotById,
    mine,
    publicDots,
    route,
    save,
    render,
    toast,
  } = ctx;
  const U = () => ctx.getUi();
  let picker = null;
  const draftId = "new-conversation",
    draftContext = "draft:conversation";
  function draftChat() {
    if (!U().talkDots) {
      const all = [...mine(), ...publicDots()].filter((b) =>
        b.knowledge?.some((k) => k.status === "ready" && k.enabled !== false),
      );
      U().talkDots = [
        all.find((b) => b.id === "design")?.id || all[0]?.id,
      ].filter(Boolean);
    }
    return {
      id: draftId,
      messages: [],
      get dots() {
        return U().talkDots;
      },
      set dots(ids) {
        U().talkDots = ids;
      },
    };
  }
  const current = () =>
    route().path === "/talk"
      ? draftChat()
      : ctx.chatById(route().path.split("/")[2]);
  const members = (c) => (c?.dots || []).map(dotById).filter(Boolean);
  function candidates(c) {
    return [
      ...new Map(
        [...members(c), ...mine(), ...publicDots()]
          .filter((b) => b.owner === "me" || b.public)
          .map((b) => [b.id, b]),
      ).values(),
    ];
  }
  const scopes = () => (U().roomScopes ||= {});
  function targets(c, text = "") {
    const dots = members(c);
    if (text.includes("@"))
      return dots.filter((b) =>
        [b.name, title(b), b.enName].some(
          (name) => name && text.includes("@" + name),
        ),
      );
    const selected = dots.find((b) => b.id === scopes()[c?.id]);
    return selected ? [selected] : dots;
  }
  function button(label, action, extra = "") {
    return `<button type="button" data-action="room-${action}" ${extra}>${label}</button>`;
  }
  function composer(c) {
    const draft = c.id === draftId;
    const dots = members(c),
      target = dots.find((b) => b.id === scopes()[c.id]);
    const selected = target || (dots.length === 1 ? dots[0] : null);
    return `<div class="room-input-wrap"><div id="room-popover-host"></div><form class="composer room-composer" id="compose" data-context="${draft ? draftContext : "chat:" + c.id}"><div id="mention-menu"></div><textarea id="message-input" name="question" aria-label="${t("输入你的问题", "Your question")}" placeholder="${dots.length ? (draft ? t("问一个问题，或输入 @ 指定一个 Ree…", "Ask a question, or @ a Ree…") : t("继续聊聊，或输入 @ 指定一个 Ree…", "Continue the conversation, or @ a Ree…")) : t("先添加一个 Ree，再开始聊聊…", "Add a Ree to start chatting…")}" rows="2" maxlength="4000" ${U().busy ? "disabled" : ""}>${draft ? esc(U().chatDrafts?.[draftContext] || "") : ""}</textarea><div class="room-compose-tools"><div class="room-dot-tools">${button(`${selected ? avatar(selected, true) : I("users")}<span>${selected ? esc(title(selected)) : dots.length ? t("全部 Ree", "All Rees") + ` <small>· ${dots.length}</small>` : t("选择 Ree", "Choose Rees")}</span>${selected?(ctx.userRoles?.badgeForRee(selected)||""):""}${I("down")}`, "scope", `class="room-scope-control" aria-label="${t("选择本次提问对象", "Choose who answers")}" aria-haspopup="dialog" aria-expanded="false" ${U().busy ? "disabled" : ""}`)}</div><button class="btn room-send" type="submit" aria-label="${t("发送问题", "Send question")}" ${U().busy || !dots.length ? "disabled" : ""}>${U().busy ? '<i class="spinner"></i>' : I("send")}</button></div></form><div class="room-compose-meta"><span>${I("shield")}<span id="cost-label">${t("最多", "Up to")} <strong>${targets(c, draft ? U().chatDrafts?.[draftContext] || "" : "").reduce((sum, b) => sum + fee(b), 0)}</strong> credits</span><span>· ${t("未作答不收费", "No answer, no charge")}</span></span><small>${t("Enter 发送 · Shift + Enter 换行", "Enter to send · Shift + Enter for a new line")}</small></div><p class="room-demo-note">${t("演示回答，不连接真实模型 · 每个答案都可以追溯到知识来源", "Demo answers · Every answer traces back to its knowledge sources")}</p></div>`;
  }
  function empty(c) {
    const dots = members(c),
      only = dots.length === 1 ? dots[0] : null;
    const samples = (
      only?.samples?.length
        ? only.samples
        : [
            t(
              "搭建设计系统时，设计和前端应该如何协作？",
              "How should designers and developers collaborate on a design system?",
            ),
            t(
              "从想法到上线，需要关注哪些问题？",
              "What should I consider from idea to launch?",
            ),
          ]
    ).slice(0, 3);
    return `<div class="room-empty"><span class="room-empty-avatar">${only ? avatar(only) : I("sparkle")}</span><p class="eyebrow">A GOOD CONVERSATION STARTS HERE</p><h2>${only ? t("和" + title(only) + "聊聊", "Talk with " + title(only)) : dots.length ? t("让不同的知识，一起想一想。", "Bring a few perspectives together.") : t("这次，想和谁聊聊？", "Who would you like to talk with?")}</h2><p>${only ? esc(desc(only)) : dots.length ? t("每个 Ree 从自己的知识出发，为同一个问题带来新的视角。", "Each Ree brings a perspective grounded in its own knowledge.") : t("在输入框旁添加 Ree，让你的问题遇见合适的知识。", "Add Rees beside the composer and find the right knowledge for your question.")}</p>${dots.length ? `<div class="room-starters">${samples.map((s) => `<button data-action="sample" data-context="chat:${c.id}" data-value="${esc(s)}">${esc(s)}${I("arrow")}</button>`).join("")}</div>` : button(I("plus") + t("选择知识伙伴", "Choose your Rees"), "manage", 'class="btn secondary"')}</div>`;
  }
  function page(c) {
    return `<section class="chat-room" aria-label="${esc(c.title)}"><h1 class="room-sr-only">${esc(c.title)}</h1><div class="room-messages" id="transcript" role="region" aria-label="${t("对话消息", "Conversation messages")}" tabindex="0">${c.messages.length ? `<div class="room-thread">${c.messages.map(ctx.messageHTML).join("")}</div>` : empty(c)}</div><div class="room-compose-dock">${composer(c)}</div></section>`;
  }
  function redraw() {
    captureDraft();
    const top = document.querySelector("#transcript")?.scrollTop;
    render();
    const transcript = document.querySelector("#transcript");
    if (transcript && top != null) transcript.scrollTop = top;
  }
  function captureDraft() {
    const form = document.querySelector("#compose"),
      input = document.querySelector("#message-input");
    if (form?.dataset.context === draftContext && input)
      (U().chatDrafts ||= {})[draftContext] = input.value;
  }
  function transferDraftScope(chatId) {
    scopes()[chatId] = scopes()[draftId] || null;
  }
  function clearDraft() {
    (U().chatDrafts ||= {})[draftContext] = "";
    scopes()[draftId] = null;
    const form = document.querySelector("#compose");
    if (form?.dataset.context === draftContext)
      form.querySelector("textarea").value = "";
  }
  function closePicker(focus = false) {
    picker = null;
    document.querySelector("#room-popover-host")?.replaceChildren();
    for (const control of document.querySelectorAll(
      ".room-dot-tools [aria-expanded]",
    ))
      control.setAttribute("aria-expanded", "false");
    if (focus)
      document.querySelector('[data-action="room-scope"]')?.focus();
  }
  function summary(c) {
    const selected = candidates(c).filter((b) => picker.ids.includes(b.id));
    return `<span>${selected.length}/5 ${t("个 Ree", "Rees")}</span><strong>${t("最多", "Up to")} ${selected.reduce((s, b) => s + fee(b), 0)} credits</strong>`;
  }
  function rows(c) {
    const q = picker.q.trim().toLocaleLowerCase();
    const all = candidates(c).filter(
      (b) =>
        !q ||
        [title(b), desc(b), ...(b.tags || [])]
          .join(" ")
          .toLocaleLowerCase()
          .includes(q),
    );
    all.sort(
      (a, b) => Number(c.dots.includes(b.id)) - Number(c.dots.includes(a.id)),
    );
    return (
      all
        .map(
          (b) =>
            `<label class="room-picker-row">${avatar(b, true)}<span><strong>${esc(title(b))}${ctx.userRoles?.badgeForRee(b)||""}${c.dots.includes(b.id) ? `<small>${t("已加入", "Joined")}</small>` : ""}</strong><small>${fee(b)} credits / ${t("成功回答", "successful answer")}${b.owner === "me" ? " · " + t("我的 Ree", "My Ree") : ""}</small></span><input type="checkbox" name="room-members" value="${esc(b.id)}" aria-label="${t("参与者：", "Participant: ") + esc(title(b))}" ${picker.ids.includes(b.id) ? "checked" : ""} ${!picker.ids.includes(b.id) && picker.ids.length >= 5 ? "disabled" : ""}></label>`,
        )
        .join("") ||
      `<p class="room-picker-empty">${t("没有找到匹配的 Ree", "No matching Rees found")}</p>`
    );
  }
  function paintPicker() {
    const host = document.querySelector("#room-popover-host"),
      c = current();
    if (!host || !picker || !c || picker.chat !== c.id) return;
    const manage = picker.view === "manage",
      selected = scopes()[c.id];
    host.innerHTML = `<section class="room-picker" role="dialog" aria-modal="false" aria-labelledby="room-picker-heading"><header><div><h2 id="room-picker-heading">${manage ? t("对话参与者", "Conversation participants") : t("本次提问，想听谁的回答？", "Who should answer this question?")}</h2><p>${manage ? (c.id === draftId ? t("选择最多 5 个 Ree，点击完成后加入这场对话。", "Choose up to 5 Rees and click Done to add them.") : t("调整后只影响后续提问，历史回答会保留。", "Changes affect future questions. Past answers stay.")) : t("切换提问对象，不会将 Ree 移出对话。", "Choosing an answerer does not remove other Rees.")}</p></div>${button(I("close"), "close", `class="icon-btn" aria-label="${t("关闭 Ree 选择", "Close Ree picker")}"`)}</header>${
      manage
        ? `<div class="room-picker-search">${I("search")}<input id="room-dot-search" type="search" aria-label="${t("搜索可加入的 Ree", "Search available Rees")}" placeholder="${t("搜索名称、专长或关键词…", "Search names, expertise, or keywords…")}" value="${esc(picker.q)}"></div><div class="room-picker-list" id="room-picker-list">${rows(c)}</div><div class="room-picker-summary" id="room-picker-summary">${summary(c)}</div><footer><a href="#/explore">${I("compass")}${t("发现更多 Ree", "Discover more Rees")}</a>${button(t("完成", "Done") + I("check"), "apply", 'class="btn sm"')}</footer>`
        : `<div class="room-scope-list" role="radiogroup" aria-label="${t("本次提问对象", "Who answers")}">${members(c).length > 1 ? button(`${I("users")}<span><strong>${t("全部 Ree 一起回答", "Let all Rees answer")}</strong><small>${t("每个 Ree 回答自己了解的部分", "Each Ree answers what it knows")}</small></span>${!selected ? I("check") : ""}`, "select", `data-id="all" role="radio" aria-checked="${!selected}"`) : ""}${
            members(c)
              .map((b) =>
                button(
                  `${avatar(b, true)}<span><strong>${esc(title(b))}</strong>${ctx.userRoles?.badgeForRee(b)||""}<small>${fee(b)} credits · ${t("只问这个 Ree", "Ask only this Ree")}</small></span>${selected === b.id || members(c).length === 1 ? I("check") : ""}`,
                  "select",
                  `data-id="${esc(b.id)}" role="radio" aria-checked="${selected === b.id || members(c).length === 1}"`,
                ),
              )
              .join("") ||
            `<p class="room-picker-empty">${t("先添加一个知识伙伴吧", "Add a knowledge companion first")}</p>`
          }</div><footer>${button(I("plus") + t("管理参与者", "Manage participants") + `<small>${members(c).length}/5</small>`, "manage", 'class="room-picker-manage"')}</footer>`
    }</section>`;
    document.querySelector('[data-action="room-scope"]')?.setAttribute("aria-expanded", "true");
    const panel = host.querySelector(".room-picker"),
      list = panel.querySelector(".room-picker-list,.room-scope-list");
    const wrap = host.parentElement.getBoundingClientRect();
    const anchor = host.parentElement
      .querySelector(".room-dot-tools")
      .getBoundingClientRect();
    const barBottom =
      document.querySelector(".topbar")?.getBoundingClientRect().bottom || 0;
    const above = anchor.top - barBottom - 14,
      below =
        (window.visualViewport?.height || window.innerHeight) -
        anchor.bottom -
        14;
    const isBelow = below > above;
    panel.classList.toggle("is-below", isBelow);
    panel.style.top = isBelow ? anchor.bottom - wrap.top + 10 + "px" : "auto";
    panel.style.bottom = isBelow
      ? "auto"
      : wrap.bottom - anchor.top + 10 + "px";
    if (list) {
      const fixed =
        panel.getBoundingClientRect().height -
        list.getBoundingClientRect().height;
      list.style.minHeight = "0";
      list.style.maxHeight =
        Math.max(
          40,
          Math.min(manage ? 250 : 260, Math.max(above, below) - fixed),
        ) + "px";
    }
  }
  function applyParticipants(c, ids) {
    const unique = [...new Set(ids)];
    if (unique.length > 5 || U().busy) return false;
    const allowed = new Set(candidates(c).map((b) => b.id));
    c.dots = unique.filter((id) => allowed.has(id));
    if (!c.dots.includes(scopes()[c.id])) scopes()[c.id] = null;
    save();
    return true;
  }
  async function onAction(a, d) {
    if (!a.startsWith("room-")) return false;
    const c = current();
    if (!c) return true;
    if (a === "room-close") {
      closePicker(true);
      return true;
    }
    if (U().busy) {
      toast(
        t(
          "请等当前回答结束后再调整 Ree",
          "Wait for the current response before changing Rees",
        ),
      );
      return true;
    }
    if (a === "room-scope" || a === "room-manage") {
      const view = a === "room-scope" && c.dots.length ? "scope" : "manage";
      if (
        picker?.view === view &&
        !document.activeElement?.closest(".room-picker")
      ) {
        closePicker(true);
        return true;
      }
      picker = { chat: c.id, view, ids: [...c.dots], q: "" };
      paintPicker();
      (
        document.querySelector("#room-dot-search") ||
        document.querySelector('.room-picker [role="radio"]') ||
        document.querySelector('[data-action="room-close"]')
      )?.focus();
    }
    if (a === "room-select") {
      if (d.id !== "all" && !c.dots.includes(d.id)) return true;
      scopes()[c.id] = d.id === "all" ? null : d.id;
      closePicker();
      redraw();
      document.querySelector("#message-input")?.focus();
    }
    if (a === "room-apply" && picker?.chat === c.id) {
      if (!applyParticipants(c, picker.ids)) return true;
      closePicker();
      redraw();
      document.querySelector("#message-input")?.focus();
      toast(
        t(
          "参与者已更新，历史回答仍然保留",
          "Participants updated. Past answers are preserved.",
        ),
      );
    }
    return true;
  }
  function afterRender() {
    picker = null;
    if (!document.querySelector(".chat-room,.new-conversation-page")) return;
    ctx.updateCompose(false);
  }
  document.addEventListener("input", (e) => {
    if (e.target.id === "room-dot-search" && picker) {
      picker.q = e.target.value;
      document.querySelector("#room-picker-list").innerHTML = rows(current());
    }
    if (
      e.target.id === "message-input" &&
      e.target.closest(".chat-room,.new-conversation-page")
    ) {
      captureDraft();
      e.target.style.height = "auto";
      e.target.style.height =
        Math.min(150, Math.max(54, e.target.scrollHeight)) + "px";
    }
  });
  document.addEventListener("change", (e) => {
    if (e.target.name !== "room-members" || !picker || U().busy) return;
    const id = e.target.value;
    if (e.target.checked && !picker.ids.includes(id) && picker.ids.length < 5)
      picker.ids.push(id);
    else if (!e.target.checked)
      picker.ids = picker.ids.filter((value) => value !== id);
    document.querySelector("#room-picker-summary").innerHTML =
      summary(current());
    for (const input of document.querySelectorAll('[name="room-members"]'))
      input.disabled = !input.checked && picker.ids.length >= 5;
  });
  document.addEventListener("click", (e) => {
    if (
      picker &&
      !e.target.closest(
        '.room-picker,.room-dot-tools,[data-action="room-manage"]',
      )
    )
      closePicker();
  });
  document.addEventListener("keydown", (e) => {
    if (picker && e.key === "Escape") {
      e.preventDefault();
      closePicker(true);
    }
  });
  return {
    page,
    composer,
    draftChat,
    draftContext,
    transferDraftScope,
    clearDraft,
    targets,
    candidates,
    applyParticipants,
    onAction,
    afterRender,
  };
}
