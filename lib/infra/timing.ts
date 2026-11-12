/**
 * Step timings for one request, sent back as a `Server-Timing` header so a
 * slow response can be read step by step from the outside (`curl -sD -`,
 * the browser's network panel). Durations only, never values.
 */
export class Timing {
  private readonly steps: { name: string; ms: number }[] = [];

  /** Runs `work`, recording how long it took under `name` (also when it fails). */
  async measure<T>(name: string, work: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await work();
    } finally {
      this.steps.push({ name, ms: performance.now() - start });
    }
  }

  /** `name;dur=12.3, …` in the order the steps finished. */
  header(): string {
    return this.steps.map((step) => `${step.name};dur=${step.ms.toFixed(1)}`).join(', ');
  }

  get entries(): readonly { name: string; ms: number }[] {
    return this.steps;
  }
}

/** For callers that do not time: runs the work as is. */
export const untimed: Pick<Timing, 'measure'> = { measure: (_name, work) => work() };
