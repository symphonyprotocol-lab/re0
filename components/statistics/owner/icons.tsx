/*
 * The prototype's own icons (rebuild-prototype/app.js `paths`, statistics-period.js
 * `calendarIcon`) for the owner statistics pages, so the metric cards, empty
 * states and calendar match it stroke for stroke.
 */

const PATHS = {
  chat: (
    <>
      <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 2V11.5A8.5 8.5 0 0 1 9.5 3h3a8.5 8.5 0 0 1 8.5 8.5Z" />
      <path d="M7 10h8m-8 4h5" />
    </>
  ),
  wallet: (
    <>
      <path d="M20 7V4H5a3 3 0 0 0 0 6h16v10H5a3 3 0 0 1-3-3V7" />
      <path d="M21 10h-6v6h6M17 13h.01" />
    </>
  ),
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  file: <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8m-8 4h6" />,
  check: <path d="m5 12 4 4L19 6" />,
  layers: <path d="m12 2 10 6-10 6L2 8Zm-10 12 10 6 10-6M2 19l10 6 10-6" transform="scale(.9) translate(1 0)" />,
};

export type StatIconName = keyof typeof PATHS;

export function StatIcon({ name }: { name: StatIconName }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

export function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M7 3v4m10-4v4M3 11h18" />
    </svg>
  );
}
