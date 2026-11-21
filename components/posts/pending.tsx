import type { ReactNode } from 'react';

/**
 * What is still being written -- a Ree's answer, the AI general answer, a
 * review, a summary -- as one line: three dots that bounce in turn, then the
 * words. The same everywhere a post waits, so waiting reads alike; with
 * reduced motion the dots stay still (posts.css `.pending`). `role=status`
 * lets a screen reader announce it once.
 */
export function Pending({ label, className = '' }: { label: ReactNode; className?: string }) {
  return (
    <span className={`pending ${className}`.trim()} role="status">
      <span className="pending-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{label}</span>
    </span>
  );
}
