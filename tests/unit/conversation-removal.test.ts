import { describe, expect, it, vi } from 'vitest';
import { animateConversationRemoval } from '@/lib/client/conversation-removal';

function row(finished: Promise<void>) {
  const animate = vi.fn(() => ({ finished }));
  return {
    element: { animate, getBoundingClientRect: () => ({ height: 88 }) } as unknown as HTMLElement,
    animate,
  };
}

describe('conversation deletion exit', () => {
  it('waits for every row before the caller can refresh a batch deletion', async () => {
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = row(new Promise<void>((resolve) => { finishFirst = resolve; }));
    const second = row(new Promise<void>((resolve) => { finishSecond = resolve; }));
    const refresh = vi.fn();
    const removal = animateConversationRemoval([first.element, second.element], false).then(refresh);
    expect(refresh).not.toHaveBeenCalled();
    finishFirst();
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
    finishSecond();
    await removal;
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('respects reduced motion without delaying list reconciliation', async () => {
    const target = row(new Promise<void>(() => {}));
    await animateConversationRemoval([target.element], true);
    expect(target.animate).not.toHaveBeenCalled();
  });

  it('still reconciles a successful deletion if an animation is canceled or unavailable', async () => {
    const canceled = row(Promise.reject(new Error('Animation canceled')));
    const unsupported = {} as HTMLElement;
    await expect(animateConversationRemoval([canceled.element, unsupported], false)).resolves.toBeUndefined();
  });

  it('does not turn an animation setup failure into a failed deletion', async () => {
    const target = row(Promise.resolve());
    target.animate.mockImplementation(() => { throw new Error('Animation unavailable'); });
    await expect(animateConversationRemoval([target.element], false)).resolves.toBeUndefined();
  });
});
