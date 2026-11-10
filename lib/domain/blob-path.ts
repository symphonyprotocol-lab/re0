/**
 * The SDK pastes a pathname straight after the store host, so URL parsing
 * would resolve `..`, `.`, an encoded `%2e%2e` / `%2f`, a `\\`, or cut at `?` /
 * `#` — and read a different object than the caller checked. A literal `%` that is not an
 * escape (a file named `100%.pdf`) decodes to nothing and stays allowed.
 */
export function isSafeBlobPathname(pathname: string): boolean {
  return !(
    !pathname ||
    /^[a-z][a-z0-9+.-]*:/i.test(pathname) ||
    /[\\?#\u0000-\u001f]/.test(pathname) ||
    /%[0-9a-f]{2}/i.test(pathname) ||
    pathname.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  );
}


export function assertBlobPathname(pathname: string): string {
  if (!isSafeBlobPathname(pathname)) throw new Error(`unsafe blob pathname: ${JSON.stringify(pathname.slice(0, 200))}`);
  return pathname;
}
