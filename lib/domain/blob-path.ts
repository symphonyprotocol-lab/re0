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

/**
 * A knowledge upload's pathname as `/api/upload-token` issues it:
 * `knowledge/<owner>/<id>/<name>` — exactly two segments under the owner's
 * prefix, safe as above, and no `%` at all (the uploader replaces it in file
 * names), so the path cannot reach another user's file.
 */
export function isKnowledgeUploadPath(pathname: string, ownerId: string): boolean {
  const prefix = `knowledge/${ownerId}/`;
  if (!pathname.startsWith(prefix) || pathname.includes('%') || !isSafeBlobPathname(pathname)) return false;
  return pathname.slice(prefix.length).split('/').length === 2;
}
