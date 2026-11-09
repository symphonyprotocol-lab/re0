/** The RE0 mark (prototype icon.svg): a blue tile with the voice ring. */
export function BrandMark({ className, size }: { className?: string; size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" className={className}>
      <rect width="32" height="32" rx="10.6667" fill="#127ee3" />
      <g fill="#ffffff" stroke="#ffffff" strokeWidth="1" strokeLinejoin="round">
        <path d="M17.25 8.91 A 7.2 7.2 0 1 0 23.2 16" fill="none" strokeWidth="3" />
        <circle cx="17.25" cy="8.91" r="1.5" stroke="none" />
        <path d="M23.2 11.4 L 25.75 16 L 20.65 16 Z" />
        <circle cx="16" cy="16" r="2.5" stroke="none" />
      </g>
    </svg>
  );
}

export function BrandName() {
  return <span>RE<span className="brand-zero">0</span></span>;
}
