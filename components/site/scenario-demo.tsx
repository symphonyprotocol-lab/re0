import { BotIcon } from '@/components/ui/icons';

export interface DemoTurn {
  role: string;
  text: string;
  note: string;
}

/**
 * A scenario's demo conversation (agent-first-proposal.md 4.2): fixed copy
 * from the dictionary, rendered on the server. It calls no model and looks
 * up nothing; the label above it says so.
 */
export function ScenarioDemo({
  turns,
  labels,
}: {
  turns: readonly DemoTurn[];
  labels: { demoLabel: string; demoNote: string; you: string; agent: string };
}) {
  return (
    <figure className="rounded-lg border border-line bg-card p-4">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2.5">
        <span className="text-[12.5px] font-medium text-ink">{labels.demoLabel}</span>
        <span className="text-[11px] text-faint">{labels.demoNote}</span>
      </figcaption>
      <ol className="mt-3 flex flex-col gap-3">
        {turns.map((turn, index) =>
          turn.role === 'user' ? (
            <li key={index} className="flex justify-end">
              <p className="max-w-[85%] rounded-lg bg-subtle px-3 py-2 text-[12.5px] leading-[1.6] text-ink">
                <span className="sr-only">{labels.you}: </span>
                {turn.text}
              </p>
            </li>
          ) : (
            <li key={index} className="flex gap-2">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-brandsoft text-brandink">
                <BotIcon size={13} />
              </span>
              <div className="min-w-0 rounded-lg bg-reply px-3 py-2">
                <p className="text-[12.5px] leading-[1.6] text-ink">
                  <span className="sr-only">{labels.agent}: </span>
                  {turn.text}
                </p>
                {turn.note ? <p className="mt-1 text-[11px] text-muted">{turn.note}</p> : null}
              </div>
            </li>
          ),
        )}
      </ol>
    </figure>
  );
}
