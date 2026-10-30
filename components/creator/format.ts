/**
 * Formatting shared by the P3 server pages. Kept out of the upload
 * components: a function exported from a `'use client'` module is a client
 * reference on the server and cannot be called while rendering there.
 */
export function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

/** Whole cents as a dollar amount, `$5.00`. */
export function formatUsd(minor: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(minor / 100);
}
