// Expand the existing node immediately; use native fullscreen when the host allows it.
// The viewport layout also works in embedded browsers that cannot enter native fullscreen.
export async function toggleInlineFullscreen(player, doc = document) {
  if (!player) return false;
  const expanded = player.classList.contains("is-page-fullscreen") || doc.fullscreenElement === player;
  if (expanded) {
    player.classList.remove("is-page-fullscreen");
    doc.body.classList.remove("has-dot-fullscreen");
    if (doc.fullscreenElement === player) await doc.exitFullscreen();
    return false;
  }
  player.classList.add("is-page-fullscreen");
  doc.body.classList.add("has-dot-fullscreen");
  try {
    const request = player.requestFullscreen?.();
    request?.then(() => {
      // A slow native request must not re-enter fullscreen after the user exited.
      if (!player.classList.contains("is-page-fullscreen") && doc.fullscreenElement === player)
        doc.exitFullscreen().catch(() => {});
    }).catch(() => {});
  } catch {}
  return true;
}
