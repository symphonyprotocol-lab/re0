import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeRouteMotion } from '@/lib/client/route-motion';

class MotionElement {
  children: MotionElement[] = [];
  excluded = false;
  cancel = vi.fn();
  animate = vi.fn(() => ({ cancel: this.cancel }));
  matches = () => this.excluded;
}

let notify: () => void;
const observe = vi.fn();
const disconnect = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('HTMLElement', MotionElement);
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) { notify = callback; }
    observe = observe;
    disconnect = disconnect;
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('page transitions', () => {
  it('reveals streamed content after a loading fallback without replaying existing content', () => {
    const root = new MotionElement();
    const fallback = new MotionElement();
    fallback.excluded = true;
    root.children = [fallback];
    const stop = observeRouteMotion(root as unknown as HTMLElement, false);
    expect(fallback.animate).not.toHaveBeenCalled();

    const content = new MotionElement();
    root.children = [content];
    notify();
    expect(content.animate).toHaveBeenCalledOnce();
    notify();
    expect(content.animate).toHaveBeenCalledOnce();
    expect(observe.mock.calls.map(([target, options]) => ({ sameRoot: target === root, options })))
      .toEqual([{ sameRoot: true, options: { childList: true } }]);

    stop();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(content.cancel).toHaveBeenCalledOnce();
  });

  it('skips fixed headers and respects reduced motion', () => {
    const root = new MotionElement();
    const header = new MotionElement();
    header.excluded = true;
    const content = new MotionElement();
    root.children = [header, content];
    const stop = observeRouteMotion(root as unknown as HTMLElement, false);
    expect(header.animate).not.toHaveBeenCalled();
    expect(content.animate).toHaveBeenCalledOnce();
    stop();

    content.animate.mockClear();
    observe.mockClear();
    observeRouteMotion(root as unknown as HTMLElement, true)();
    expect(content.animate).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });
});
