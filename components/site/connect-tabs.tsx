'use client';

import { useState } from 'react';
import { CheckIcon, CopyIcon } from '@/components/ui/icons';
import { useCopied } from '@/components/ui/use-copied';

export interface ConnectOption {
  id: string;
  /** Tab label. */
  label: string;
  /** The text the reader copies -- a prompt, an endpoint or a command. */
  value: string;
  copyLabel: string;
  copiedLabel: string;
  /** One line under the box saying what to do with it. */
  note: string;
  /** Commands and endpoints are set in mono; a prompt is prose and is not. */
  mono?: boolean;
}

/** The copyable box itself. Remounted per tab, so its copied flash resets with it. */
function CopyBox({ option }: { option: ConnectOption }) {
  const { copied, copy } = useCopied(option.value);
  return (
    <div className="flex w-full items-start gap-3 rounded-md border border-termline bg-inkdeep p-3 pl-4 text-left">
      <p
        className={`min-w-0 flex-1 py-1.5 text-caption break-words text-paper/85 ${
          option.mono ? 'font-mono' : ''
        }`}
      >
        {option.value}
      </p>
      <button
        type="button"
        onClick={copy}
        aria-live="polite"
        className="flex shrink-0 items-center gap-1.5 self-start rounded-md border border-termline px-2.5 py-1.5 text-caption text-paper/70 transition-colors hover:text-paper"
      >
        {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
        <span className="whitespace-nowrap">{copied ? option.copiedLabel : option.copyLabel}</span>
      </button>
    </div>
  );
}

/**
 * The hero's connect control: one box, two ways to get there.
 *
 * The two are ordered by how little the reader has to know. The prompt is
 * first because it asks nothing of them -- it is addressed to the model, and
 * the client they are already in does the install. The endpoint follows for
 * people who would rather wire it themselves.
 *
 * Each tab remounts its own box (the `key`), so switching away mid-flash does
 * not leave the next tab claiming something was copied.
 */
export function ConnectTabs({ options }: { options: ConnectOption[] }) {
  const [activeId, setActiveId] = useState(options[0]?.id);
  const active = options.find((o) => o.id === activeId) ?? options[0];
  if (!active) return null;

  return (
    <div className="flex w-full flex-col items-center gap-3 lg:items-start">
      <div className="flex items-center gap-1" role="tablist">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={option.id === active.id}
            onClick={() => setActiveId(option.id)}
            className={`h-9 rounded-md px-3.5 text-caption font-medium transition-colors ${
              option.id === active.id
                ? 'bg-brandsoft text-ink'
                : 'text-muted hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <CopyBox key={active.id} option={active} />

      <p className="max-w-[52ch] text-caption text-faint">{active.note}</p>
    </div>
  );
}
