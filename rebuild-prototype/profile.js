// Local profile preferences and simulated OAuth identity; no external uploads.
export function avatarInitials(name = "Yu Zhao") {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (
    parts.length > 1
      ? parts[0][0] + parts.at(-1)[0]
      : Array.from(parts[0] || "YZ")
          .slice(0, 2)
          .join("")
  ).toUpperCase();
}
export function validateAvatarFile(file) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    return "type";
  if (!file.size || file.size > 5 * 1024 * 1024) return "size";
  return null;
}
export function avatarCrop(width, height, zoom = 1, x = 0, y = 0, size = 512) {
  const scale =
    Math.max(size / width, size / height) * Math.min(3, Math.max(1, zoom));
  const w = width * scale,
    h = height * scale;
  const dx = Math.min((w - size) / 2, Math.max(-(w - size) / 2, x));
  const dy = Math.min((h - size) / 2, Math.max(-(h - size) / 2, y));
  return {
    left: (size - w) / 2 + dx,
    top: (size - h) / 2 + dy,
    width: w,
    height: h,
    x: dx,
    y: dy,
  };
}
export function demoLoginIdentity(provider, name, email = "yu@example.com") {
  if (!["Google", "GitHub"].includes(provider)) return null;
  return {
    provider: provider === "Google" ? "google" : "github",
    name: name || "Yu Zhao",
    email,
    handle: provider === "GitHub" ? "yuzhao" : null,
    lastLoginAt: new Date().toISOString(),
    demo: true,
  };
}
export function createProfile(ctx) {
  const { t, I, esc, save, render, toast, modal, closeModal, cancelButton } =
    ctx;
  const S = () => ctx.getState(),
    U = () => ctx.getUi();
  let editing = null,
    generation = 0,
    drag = null;
  const camera =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 6h4l2-3h4l2 3h4v15H4z"/><circle cx="12" cy="13" r="4"/></svg>';
  const hasAvatar = () =>
    /^data:image\/(jpeg|png|webp);base64,[a-zA-Z0-9+/]+=*$/.test(
      S().profileAvatar || "",
    );
  function avatar(classes = "avatar user") {
    return `<span class="${classes}">${hasAvatar() ? `<img src="${esc(S().profileAvatar)}" alt="${t("我的头像", "My avatar")}">` : esc(avatarInitials(S().displayName || "Yu Zhao"))}</span>`;
  }
  function editor() {
    return `<div class="profile-avatar-field"><span class="field-label">${t("头像", "Profile photo")}</span><div class="profile-avatar-row"><button type="button" class="profile-avatar-edit" data-action="profile-avatar-edit" aria-label="${t("编辑头像", "Edit profile photo")}">${avatar("avatar profile-avatar-large")}<span>${camera}</span></button><div class="grow"><div class="profile-avatar-actions"><button type="button" class="btn secondary sm" data-action="profile-avatar-upload">${I("upload")}${t(hasAvatar() ? "更换头像" : "上传头像", hasAvatar() ? "Change photo" : "Upload photo")}</button>${hasAvatar() ? `<button type="button" class="btn ghost sm" data-action="profile-avatar-remove">${t("恢复默认", "Use initials")}</button>` : ""}<input id="profile-avatar-input" type="file" accept="image/jpeg,image/png,image/webp" hidden></div><p>${t("JPG、PNG 或 WebP，最大 5 MB。上传后可调整裁剪。", "JPG, PNG, or WebP. Up to 5 MB. Adjust the crop before saving.")}</p><p id="profile-avatar-error" class="profile-avatar-error" role="alert" hidden></p></div></div></div>`;
  }
  function loginInfo() {
    const identity = S().loginIdentity,
      provider = identity?.provider;
    const known = ["google", "github"].includes(provider),
      github = provider === "github";
    const providerName = github ? "GitHub" : "Google";
    const loggedAt =
      identity?.lastLoginAt && !Number.isNaN(Date.parse(identity.lastLoginAt))
        ? new Intl.DateTimeFormat(S().lang === "zh" ? "zh-CN" : "en-GB", {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(identity.lastLoginAt))
        : "";
    return `<section class="profile-login-info" aria-labelledby="profile-login-heading"><div class="between"><h3 id="profile-login-heading">${t("登录账号", "Signed-in account")}</h3><span class="tag">${t("本地演示", "Local demo")}</span></div><div class="profile-provider"><span class="profile-provider-icon">${known ? (github ? I("github") : '<b class="google-letter">G</b>') : I("users")}</span><div><strong>${known ? providerName + t(" 登录", " sign-in") : t("当前演示账号", "Current demo account")}</strong><p>${esc(identity?.email || "yu@example.com")}${github && identity.handle ? " · @" + esc(identity.handle) : ""}</p></div></div><dl><div><dt>${t("登录方式", "Provider")}</dt><dd>${known ? providerName : t("本次会话未记录", "Not recorded for this session")}</dd></div><div><dt>${t("平台账号", "Provider account")}</dt><dd>${esc(github && identity?.handle ? "@" + identity.handle : identity?.name || S().displayName || "Yu Zhao")}</dd></div><div><dt>${t("邮箱", "Email")}</dt><dd>${esc(identity?.email || "yu@example.com")}</dd></div>${loggedAt ? `<div><dt>${t("最近登录", "Last signed in")}</dt><dd>${esc(loggedAt)}</dd></div>` : ""}</dl><p class="profile-login-note">${known ? t("邮箱与平台账号由登录提供方管理；上方可自定义头像与显示名称。当前展示本地模拟登录信息。", "Your provider manages email and account details. Customize your photo and display name above. Sign-in information shown here is simulated locally.") : t("当前是已有演示会话。重新通过 Google 或 GitHub 登录后，会显示对应平台信息。", "This existing demo session has no recorded provider. Sign in again with Google or GitHub to see its details.")}</p></section>`;
  }
  function error(message) {
    const target = document.querySelector("#profile-avatar-error");
    if (target) {
      target.hidden = false;
      target.textContent = message;
    } else toast(message);
  }
  function draw() {
    const canvas = document.querySelector("#profile-avatar-canvas");
    if (!canvas || !editing) return;
    const rect = avatarCrop(
      editing.image.naturalWidth,
      editing.image.naturalHeight,
      editing.zoom,
      editing.x,
      editing.y,
    );
    editing.x = rect.x;
    editing.y = rect.y;
    const brush = canvas.getContext("2d");
    brush.fillStyle = "#fff";
    brush.fillRect(0, 0, 512, 512);
    brush.drawImage(
      editing.image,
      rect.left,
      rect.top,
      rect.width,
      rect.height,
    );
    const output = document.querySelector("#profile-avatar-zoom-value");
    if (output) output.textContent = Math.round(editing.zoom * 100) + "%";
  }
  function showCrop(image) {
    editing = { image, zoom: 1, x: 0, y: 0 };
    modal(
      t("调整头像", "Adjust your photo"),
      t(
        "拖动图片调整位置，缩放到你喜欢的大小。",
        "Drag to reposition and zoom to find your crop.",
      ),
      `<div class="profile-crop-editor"><canvas id="profile-avatar-canvas" width="512" height="512" role="img" aria-label="${t("头像裁剪预览", "Profile photo crop preview")}"></canvas><div class="profile-crop-zoom"><label for="profile-avatar-zoom">${t("缩放", "Zoom")}</label><input id="profile-avatar-zoom" type="range" min="1" max="3" step="0.01" value="1"><output id="profile-avatar-zoom-value" for="profile-avatar-zoom">100%</output></div><button type="button" class="text-link" data-action="profile-avatar-reset">${I("refresh")}${t("重置位置", "Reset crop")}</button></div>`,
      cancelButton() +
        `<button type="button" class="btn" data-action="profile-avatar-save">${t("保存头像", "Save photo")}</button>`,
    );
    document.querySelector(".modal")?.classList.add("profile-avatar-dialog");
    draw();
  }
  async function load(file) {
    const id = ++generation,
      invalid = validateAvatarFile(file);
    if (invalid)
      return error(
        invalid === "type"
          ? t(
              "请选择 JPG、PNG 或 WebP 图片。",
              "Choose a JPG, PNG, or WebP image.",
            )
          : t(
              "请选择不超过 5 MB 的有效图片。",
              "Choose a valid image up to 5 MB.",
            ),
      );
    const url = URL.createObjectURL(file),
      image = new Image();
    try {
      image.src = url;
      await image.decode();
      if (id !== generation || !document.querySelector("#profile-avatar-input"))
        return;
      if (image.naturalWidth * image.naturalHeight > 24_000_000)
        return error(
          t(
            "图片尺寸过大，请选择不超过 2400 万像素的图片。",
            "Choose an image no larger than 24 megapixels.",
          ),
        );
      const target = document.querySelector("#profile-avatar-error");
      if (target) target.hidden = true;
      showCrop(image);
    } catch {
      error(
        t(
          "无法读取这张图片，请尝试其他文件。",
          "This image could not be read. Try another file.",
        ),
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  async function onAction(action) {
    if (!action.startsWith("profile-avatar-")) return false;
    if (action === "profile-avatar-upload")
      document.querySelector("#profile-avatar-input")?.click();
    if (action === "profile-avatar-edit") {
      if (hasAvatar()) {
        const image = new Image();
        image.src = S().profileAvatar;
        try {
          await image.decode();
          showCrop(image);
        } catch {
          error(t("头像无法读取，请重新上传。", "Upload your photo again."));
        }
      } else document.querySelector("#profile-avatar-input")?.click();
    }
    if (action === "profile-avatar-reset" && editing) {
      Object.assign(editing, { zoom: 1, x: 0, y: 0 });
      document.querySelector("#profile-avatar-zoom").value = "1";
      draw();
    }
    if (action === "profile-avatar-save" && editing) {
      const canvas = document.querySelector("#profile-avatar-canvas");
      if (!canvas) return true;
      S().profileAvatar = canvas.toDataURL("image/jpeg", 0.88);
      const saved = save();
      editing = null;
      closeModal();
      render();
      if (saved !== false) toast(t("头像已更新", "Profile photo updated"));
    }
    if (action === "profile-avatar-remove") {
      delete S().profileAvatar;
      const saved = save();
      render();
      if (saved !== false) toast(t("已恢复默认头像", "Initials restored"));
    }
    return true;
  }
  function recordLogin(provider) {
    const identity = demoLoginIdentity(
      provider,
      S().displayName,
      S().email || "yu@example.com",
    );
    if (identity) S().loginIdentity = identity;
  }
  document.addEventListener("change", (e) => {
    if (e.target.id !== "profile-avatar-input") return;
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) load(file);
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "profile-avatar-zoom" && editing) {
      editing.zoom = Number(e.target.value);
      draw();
    }
    if (e.target.id === "profile-name") U().profileNameDraft = e.target.value;
  });
  document.addEventListener("pointerdown", (e) => {
    if (e.target.id !== "profile-avatar-canvas" || !editing) return;
    drag = {
      x: e.clientX,
      y: e.clientY,
      offsetX: editing.x,
      offsetY: editing.y,
    };
    e.target.setPointerCapture(e.pointerId);
  });
  document.addEventListener("pointermove", (e) => {
    if (!drag || !editing || e.target.id !== "profile-avatar-canvas") return;
    const ratio = 512 / e.target.getBoundingClientRect().width;
    editing.x = drag.offsetX + (e.clientX - drag.x) * ratio;
    editing.y = drag.offsetY + (e.clientY - drag.y) * ratio;
    draw();
  });
  document.addEventListener("pointerup", () => {
    drag = null;
  });
  document.addEventListener("pointercancel", () => {
    drag = null;
  });
  return { avatar, editor, loginInfo, recordLogin, onAction };
}
