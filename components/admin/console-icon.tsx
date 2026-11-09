/**
 * The prototype's own stroke icons (rebuild-prototype/app.js `icon`): 18px,
 * 1.5 stroke, its own drawings. The console uses these so its glyphs match the
 * prototype exactly; the product keeps components/ui/icons.
 */
const PATHS = {
  sort: '<path d="M8 3v18m-4-4 4 4 4-4M16 21V3m-4 4 4-4 4 4"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  list: '<path d="M9 5h12M9 12h12M9 19h12M3 5h.01M3 12h.01M3 19h.01"/>',
  fullscreen: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  minimize: '<path d="M3 8h5V3m8 0v5h5M8 21v-5H3m13 5v-5h5"/>',
  chart: '<path d="M4 3v18h17M9 16v-5m5 5V6m5 10V9"/>',
  pin: '<path d="m9 3 12 12-3 3-4-2-4 4-2-2 4-4-2-4Zm-6 18 6-6"/>',
  archive: '<path d="M4 8h16v13H4ZM3 3h18v5H3Zm6 9h6"/>',
  'panel-close': '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18m7-13-3 4 3 4"/>',
  'panel-open': '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18m4-13 3 4-3 4"/>',
  play: '<path d="m8 4 12 8-12 8Z"/>',
  pause: '<path d="M8 4v16M16 4v16"/>',
  film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18m10-18v18M3 8h4m-4 8h4m10-8h4m-4 8h4"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2.4 5.6L8 16l2.4-5.6Z"/>',
  dot: '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/><path d="M8.3 5.1a7.8 7.8 0 0 1 10.6 10.6M15.7 18.9A7.8 7.8 0 0 1 5.1 8.3"/><circle cx="6" cy="6" r="1.7" fill="currentColor" stroke="none"/><circle cx="18" cy="18" r="1.7" fill="currentColor" stroke="none"/>',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 2V11.5A8.5 8.5 0 0 1 9.5 3h3a8.5 8.5 0 0 1 8.5 8.5Z"/><path d="M7 10h8m-8 4h5"/>',
  wallet: '<path d="M20 7V4H5a3 3 0 0 0 0 6h16v10H5a3 3 0 0 1-3-3V7"/><path d="M21 10h-6v6h6M17 13h.01"/>',
  settings: '<path d="m9 3 1-2h4l1 2 3 2 2-.2 2 3.4-1.3 1.8v3.7l1.3 1.9-2 3.4-2-.2-3 1.7-1 2h-4l-1-2-3-1.7-2 .2-2-3.4L3.3 14v-3.7L2 8.4 4 5l2 .2Z" transform="translate(1 1) scale(.9)"/><circle cx="12" cy="12" r="3"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  sparkle: '<path d="m12 2 2.7 7.3L22 12l-7.3 2.7L12 22l-2.7-7.3L2 12l7.3-2.7ZM20 2v4m-2-2h4"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8m-8 4h6"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  audio: '<path d="M3 10v4m4-8v12m5-16v20m5-16v12m4-8v4"/>',
  github: '<path d="M9 19c-4.5 1.5-4.5-2.5-6-3m12 6v-4a3.5 3.5 0 0 0-1-2.5c3.3-.4 6.7-1.6 6.7-7A5.4 5.4 0 0 0 19.2 5c.2-.5.7-2.3-.2-4 0 0-1.3-.4-4.1 1.5a14 14 0 0 0-7.4 0C4.7.6 3.4 1 3.4 1c-.9 1.7-.4 3.5-.2 4a5.4 5.4 0 0 0-1.5 3.7c0 5.3 3.4 6.5 6.7 7a3.5 3.5 0 0 0-1 2.5v4" transform="translate(1 0) scale(.95)"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  link: '<path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 8 1 1a4 4 0 0 0 6-6l-5-5" transform="translate(2 2) scale(.9)"/>',
  text: '<path d="M4 5h16M12 5v15M8 20h8M4 8V5m16 3V5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  shield: '<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Z"/><path d="m8 12 3 3 5-6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  up: '<path d="M4 14h4v8H4Zm4 6h10a2 2 0 0 0 2-1.5l2-8A2 2 0 0 0 20 8h-5V4a2 2 0 0 0-4-1l-3 9" transform="translate(0 -1) scale(.95)"/>',
  downvote: '<g transform="translate(24 24) rotate(180)"><path d="M4 14h4v8H4Zm4 6h10a2 2 0 0 0 2-1.5l2-8A2 2 0 0 0 20 8h-5V4a2 2 0 0 0-4-1l-3 9"/></g>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M2 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6m1 4a5 5 0 0 1 4 5"/>',
  send: '<path d="m12 4 7 7m-7-7-7 7m7-7v16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H4v13h4"/>',
  external: '<path d="M14 3h7v7m0-7L11 13M10 3H4v17h17v-6"/>',
  refresh: '<path d="M20 10a8 8 0 0 0-14-5L3 8m0-6v6h6m-5 6a8 8 0 0 0 14 5l3-3m0 6v-6h-6"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M3 16v5h18v-5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 10v7m0-11v1"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  logout: '<path d="M10 3H4v18h6m6-15 6 6-6 6m-7-6h13"/>',
  book: '<path d="M12 6v15M2 3h5a5 5 0 0 1 5 3 5 5 0 0 1 5-3h5v16h-5a5 5 0 0 0-5 2 5 5 0 0 0-5-2H2Z"/>',
  layers: '<path d="m12 2 10 6-10 6L2 8Zm-10 12 10 6 10-6M2 19l10 6 10-6" transform="scale(.9) translate(1 0)"/>',
  code: '<path d="m8 5-6 7 6 7m8-14 6 7-6 7m-3-17-2 20"/>',
  light: '<path d="M9 18h6m-6 3h6M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 4H9c0-2 0-3-1-4Z"/>',
  map: '<path d="m3 5 6-3 6 3 6-3v17l-6 3-6-3-6 3Zm6-3v17m6-14v17"/>',
} as const;

export type ConsoleIconName = keyof typeof PATHS;

export function CI({ name, className }: { name: ConsoleIconName; className?: string }) {
  return (
    <svg
      className={className}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  );
}
