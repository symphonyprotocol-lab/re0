import { avatarCrop, validateAvatarFile } from "./profile.js";

// A knowledge node and its connections: a Ree has no face or robot features.
export const DOT_MARK =
  '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/><path d="M8.3 5.1a7.8 7.8 0 0 1 10.6 10.6M15.7 18.9A7.8 7.8 0 0 1 5.1 8.3"/><circle cx="6" cy="6" r="1.7" fill="currentColor" stroke="none"/><circle cx="18" cy="18" r="1.7" fill="currentColor" stroke="none"/>';
export function dotAvatarValue(value) {
  return typeof value === "string" &&
    value.length <= 700000 &&
    /^data:image\/(jpeg|png|webp);base64,[a-zA-Z0-9+/]+=*$/.test(value)
    ? value
    : "";
}
export function renderDotAvatar(dot, { small = false, esc } = {}) {
  const color = ["lilac", "sand", "sage", "rose", "slate"].includes(dot.color)
    ? dot.color
    : "";
  const photo = dotAvatarValue(dot.avatar);
  return `<span class="dot-avatar ${color} ${small ? "sm" : ""}" aria-hidden="true">${photo ? `<img src="${esc(photo)}" alt="">` : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${DOT_MARK}</svg>`}</span>`;
}

export function createDotAvatar(ctx) {
  const { t, I, esc } = ctx;
  let crop = null,
    sequence = 0;
  const root = () => document.querySelector(".dot-avatar-editor");
  function editor(dot = {}) {
    crop = null;
    sequence++;
    return `<section class="dot-avatar-editor" data-color="${esc(dot.color || "")}"><span class="field-label">${t("Ree 头像", "Ree avatar")}</span><div class="dot-avatar-edit-row"><div class="dot-avatar-preview">${renderDotAvatar(dot, { esc })}</div><div class="grow"><div class="dot-avatar-buttons"><button type="button" class="btn secondary sm" data-action="dot-avatar-upload">${I("upload")}${t(dotAvatarValue(dot.avatar) ? "更换头像" : "上传头像", dotAvatarValue(dot.avatar) ? "Change image" : "Upload image")}</button><button type="button" class="btn ghost sm" data-action="dot-avatar-default">${t("使用默认", "Use default")}</button></div><p>${t("默认以点和环形连接代表知识节点。支持 JPG、PNG、WebP，最大 5 MB。", "The default mark represents a connected knowledge node. JPG, PNG or WebP, up to 5 MB.")}</p></div></div><input type="hidden" name="avatar" value="${esc(dotAvatarValue(dot.avatar))}"><input type="file" id="dot-avatar-file" accept="image/jpeg,image/png,image/webp" hidden><p class="dot-avatar-error" role="alert" hidden></p><div class="dot-avatar-crop" hidden></div><small class="dot-avatar-save-note">${t("随下方表单一起保存，取消不会修改头像。", "Saved with this form. Cancel keeps your current avatar.")}</small></section>`;
  }
  function error(text) {
    const el = root()?.querySelector(".dot-avatar-error");
    if (el) {
      el.textContent = text;
      el.hidden = !text;
    }
  }
  function paintPreview(value) {
    const el = root();
    if (!el) return;
    el.querySelector('[name="avatar"]').value = value;
    el.querySelector(".dot-avatar-preview").innerHTML = renderDotAvatar(
      { avatar: value, color: el.dataset.color },
      { esc },
    );
    el.querySelector('[data-action="dot-avatar-upload"]').innerHTML =
      I("upload") +
      (value ? t("更换头像", "Change image") : t("上传头像", "Upload image"));
  }
  function clearCrop() {
    crop = null;
    const panel = root()?.querySelector(".dot-avatar-crop");
    if (panel) {
      panel.innerHTML = "";
      panel.hidden = true;
    }
  }
  function draw() {
    const canvas = root()?.querySelector("canvas");
    if (!canvas || !crop) return;
    const { image, zoom, x, y } = crop;
    const centered = avatarCrop(image.naturalWidth, image.naturalHeight, zoom);
    const rect = avatarCrop(
      image.naturalWidth,
      image.naturalHeight,
      zoom,
      (x * (centered.width - 512)) / 200,
      (y * (centered.height - 512)) / 200,
    );
    const brush = canvas.getContext("2d");
    brush.clearRect(0, 0, 512, 512);
    brush.drawImage(image, rect.left, rect.top, rect.width, rect.height);
  }
  async function load(file) {
    const host = root(),
      request = ++sequence;
    if (!host) return;
    const invalid = validateAvatarFile(file);
    if (invalid)
      return error(
        invalid === "type"
          ? t("请选择 JPG、PNG 或 WebP 图片。", "Choose JPG, PNG or WebP.")
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
      if (request !== sequence || root() !== host) return;
      if (image.naturalWidth * image.naturalHeight > 24000000)
        return error(
          t(
            "图片过大，请选择不超过 2400 万像素的图片。",
            "Choose an image up to 24 megapixels.",
          ),
        );
      error("");
      crop = { image, zoom: 1, x: 0, y: 0 };
      const panel = host.querySelector(".dot-avatar-crop");
      panel.hidden = false;
      panel.innerHTML = `<h3>${t("调整头像", "Adjust avatar")}</h3><canvas width="512" height="512" role="img" aria-label="${t("Ree 头像裁剪预览", "Ree avatar crop preview")}"></canvas>${[
        ["zoom", t("缩放", "Zoom"), 1, 3, 0.01, 1],
        ["x", t("水平位置", "Horizontal position"), -100, 100, 1, 0],
        ["y", t("垂直位置", "Vertical position"), -100, 100, 1, 0],
      ]
        .map(
          ([key, label, min, max, step, value]) =>
            `<label>${label}<input type="range" aria-label="${label}" data-dot-avatar-crop="${key}" min="${min}" max="${max}" step="${step}" value="${value}"></label>`,
        )
        .join(
          "",
        )}<div class="dot-avatar-buttons"><button type="button" class="btn sm" data-action="dot-avatar-apply">${t("使用此头像", "Use this crop")}</button><button type="button" class="btn secondary sm" data-action="dot-avatar-cancel">${t("取消裁剪", "Cancel crop")}</button></div>`;
      draw();
      panel.querySelector("input")?.focus({ preventScroll: true });
    } catch {
      if (request === sequence && root() === host)
        error(
          t(
            "图片无法读取，请尝试其他文件。",
            "Unable to read this image. Try another file.",
          ),
        );
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  async function onAction(action) {
    if (!action.startsWith("dot-avatar-")) return false;
    if (action === "dot-avatar-upload")
      root()?.querySelector('input[type="file"]')?.click();
    if (action === "dot-avatar-cancel") {
      clearCrop();
      error("");
    }
    if (action === "dot-avatar-default") {
      sequence++;
      clearCrop();
      paintPreview("");
      error("");
    }
    if (action === "dot-avatar-apply" && crop) {
      const value = root().querySelector("canvas").toDataURL("image/webp", 0.9);
      if (!dotAvatarValue(value))
        return error(
          t(
            "裁剪后的图片过大，请换用更小的图片。",
            "The crop is too large. Choose a smaller image.",
          ),
        );
      paintPreview(value);
      clearCrop();
      error("");
    }
    return true;
  }
  function beforeSubmit(form) {
    if (
      !["create-dot-form", "dot-settings-form", "dot-setup-form"].includes(form.id) ||
      !form.querySelector(".dot-avatar-crop:not([hidden])")
    )
      return false;
    error(
      t(
        "请先选择“使用此头像”或取消裁剪，再保存。",
        "Apply or cancel the crop before saving.",
      ),
    );
    return true;
  }
  document.addEventListener("change", (e) => {
    if (e.target.id !== "dot-avatar-file") return;
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) load(file);
  });
  document.addEventListener("input", (e) => {
    const key = e.target.dataset.dotAvatarCrop;
    if (crop && ["zoom", "x", "y"].includes(key)) {
      crop[key] = Number(e.target.value);
      draw();
    }
  });
  function setColor(color) {
    const el = root();
    if (!el) return;
    el.dataset.color = color;
    paintPreview(el.querySelector('[name="avatar"]').value);
  }
  return { editor, onAction, beforeSubmit, setColor };
}
