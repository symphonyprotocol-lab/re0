/** Animate route commits and streamed content, without replaying on nested form edits. */
export function observeRouteMotion(root: HTMLElement, reducedMotion: boolean): () => void {
  if (reducedMotion) return () => {};
  const seen = new WeakSet<Element>();
  const animations: Animation[] = [];
  const reveal = () => {
    for (const node of Array.from(root.children)) {
      if (!(node instanceof HTMLElement) || node.matches('header, .topbar-spacer, .route-loading, dialog, script, style, link, [hidden]') || seen.has(node)) continue;
      seen.add(node);
      if (typeof node.animate !== 'function') continue;
      animations.push(node.animate(
        [{ opacity: 0, translate: '0 10px' }, { opacity: 1, translate: '0 0' }],
        { duration: 280, easing: 'cubic-bezier(.22, 1, .36, 1)' },
      ));
    }
  };
  reveal();
  const observer = new MutationObserver(reveal);
  observer.observe(root, { childList: true });
  return () => {
    observer.disconnect();
    animations.forEach((animation) => animation.cancel());
  };
}
