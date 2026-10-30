/**
 * CSV for the console's export controls.
 *
 * Two things this has to get right beyond joining commas:
 *
 * - quoting, so an asset title containing a comma, a quote or a newline does
 *   not shift every column after it;
 * - formula injection. These files are opened in Excel and Sheets, which
 *   execute a cell beginning `=`, `+`, `-` or `@` as a formula, and much of
 *   what lands here -- names, emails, asset titles, audit reasons -- is
 *   written by someone outside the company. A leading apostrophe makes the
 *   cell text, which is what it always was. OWASP calls this out by name.
 */
const RISKY_PREFIX = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  const guarded = RISKY_PREFIX.test(text) ? `'${text}` : text;
  return /["\n\r,]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  /*
   * CRLF and a UTF-8 BOM: RFC 4180 asks for the first, and Excel needs the
   * second or it reads a Chinese name as mojibake.
   */
  return `﻿${lines.join('\r\n')}\r\n`;
}
