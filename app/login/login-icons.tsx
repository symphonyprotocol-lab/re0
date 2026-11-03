/**
 * The prototype's own icon set (rebuild-prototype/app.js `paths`, 1.5 stroke),
 * for the few icons the sign-in page shows, so they draw exactly as there.
 */
const PATHS = {
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  github: (
    <path
      d="M9 19c-4.5 1.5-4.5-2.5-6-3m12 6v-4a3.5 3.5 0 0 0-1-2.5c3.3-.4 6.7-1.6 6.7-7A5.4 5.4 0 0 0 19.2 5c.2-.5.7-2.3-.2-4 0 0-1.3-.4-4.1 1.5a14 14 0 0 0-7.4 0C4.7.6 3.4 1 3.4 1c-.9 1.7-.4 3.5-.2 4a5.4 5.4 0 0 0-1.5 3.7c0 5.3 3.4 6.5 6.7 7a3.5 3.5 0 0 0-1 2.5v4"
      transform="translate(1 0) scale(.95)"
    />
  ),
  sparkle: <path d="m12 2 2.7 7.3L22 12l-7.3 2.7L12 22l-2.7-7.3L2 12l7.3-2.7ZM20 2v4m-2-2h4" />,
  file: <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8m-8 4h6" />,
  chat: (
    <>
      <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 2V11.5A8.5 8.5 0 0 1 9.5 3h3a8.5 8.5 0 0 1 8.5 8.5Z" />
      <path d="M7 10h8m-8 4h5" />
    </>
  ),
  light: <path d="M9 18h6m-6 3h6M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 4H9c0-2 0-3-1-4Z" />,
  ree: (
    <>
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
      <path d="M8.3 5.1a7.8 7.8 0 0 1 10.6 10.6M15.7 18.9A7.8 7.8 0 0 1 5.1 8.3" />
      <circle cx="6" cy="6" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="18" cy="18" r="1.7" fill="currentColor" stroke="none" />
    </>
  ),
};

export function LoginIcon({ name, strokeWidth = 1.5 }: { name: keyof typeof PATHS; strokeWidth?: number }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
