/**
 * The console's CSV exports (8.2 "后台 CSV", prototype admin-records.js):
 * UTF-8 with a BOM so spreadsheet apps read the Chinese, CRLF line ends,
 * every field quoted, and a cell that starts with `=`, `+`, `-` or `@`
 * (after any leading blanks) prefixed with `'` so it is never run as a formula.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return `﻿${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
