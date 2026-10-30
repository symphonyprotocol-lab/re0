import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '@/lib/application/administration/csv';

/**
 * These files are opened in Excel and Sheets, and much of what lands in them --
 * names, emails, asset titles, audit reasons -- is written by someone outside
 * the company. Both hazards below are theirs to trigger and ours to defuse.
 */
describe('csvCell', () => {
  it('quotes the delimiters that would otherwise shift every later column', () => {
    expect(csvCell('Acme, Inc')).toBe('"Acme, Inc"');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell('carriage\rreturn')).toBe('"carriage\rreturn"');
  });

  it('doubles an embedded quote rather than ending the field', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('defuses the prefixes a spreadsheet executes as a formula', () => {
    // Without this, opening the export runs the cell.
    for (const payload of [
      '=1+1',
      '+1',
      '-1+1',
      '@SUM(A1)',
      '=HYPERLINK("http://evil.example","click")',
    ]) {
      expect(csvCell(payload).replace(/^"|"$/g, '').startsWith("'")).toBe(true);
    }
  });

  it('leaves ordinary text alone', () => {
    expect(csvCell('Lin Chen')).toBe('Lin Chen');
    expect(csvCell('lin@example.com')).toBe('lin@example.com');
    expect(csvCell(42)).toBe('42');
  });

  it('renders an absent value as empty rather than "null"', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('writes a date in a form another tool can parse', () => {
    expect(csvCell(new Date('2026-08-26T12:00:00.000Z'))).toBe('2026-08-26T12:00:00.000Z');
  });
});

describe('toCsv', () => {
  it('emits a header row, CRLF line endings and a BOM', () => {
    const csv = toCsv(['name', 'email'], [['Lin Chen', 'lin@example.com']]);
    expect(csv.startsWith('﻿')).toBe(true); // or Excel reads a Chinese name as mojibake
    expect(csv).toContain('name,email\r\n');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('keeps a row with a comma on one line', () => {
    const csv = toCsv(['title'], [['Acme, Inc']]);
    const body = csv.slice(1).split('\r\n').filter(Boolean);
    expect(body).toEqual(['title', '"Acme, Inc"']);
  });

  it('handles an empty result without losing the header', () => {
    expect(toCsv(['a', 'b'], [])).toBe('﻿a,b\r\n');
  });
});
