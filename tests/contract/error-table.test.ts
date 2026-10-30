/**
 * The error table in requirement.md 11 against `contracts/errors.ts`, the
 * authority for every REST, A2A and SDK error. The table once listed codes
 * that never existed and a 403 for a read the code answers with 404; it now
 * lists every code under the status `httpStatusFor` gives it, and this keeps
 * the two from drifting apart again.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, httpStatusFor } from '@/contracts/errors';

function documentedStatuses(): Map<string, number> {
  const requirement = readFileSync(join(process.cwd(), 'requirement.md'), 'utf8');
  const section = requirement.slice(requirement.indexOf('## 11. 错误、限流与兼容性'), requirement.indexOf('## 12. '));
  const documented = new Map<string, number>();
  for (const row of section.matchAll(/^\| (\d{3}) \| ([^|]+) \|/gm)) {
    for (const code of row[2]!.matchAll(/`([a-z_]+)`/g)) documented.set(code[1]!, Number(row[1]));
  }
  return documented;
}

describe('requirement.md 11 error table', () => {
  it('lists every error code, and no other, under the HTTP status the code returns', () => {
    const documented = documentedStatuses();
    expect([...documented.keys()].sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) expect(documented.get(code), code).toBe(httpStatusFor(code));
  });

  it('answers a non-subscriber reading a paid body with 404 asset_not_found, never revealing the asset', () => {
    const requirement = readFileSync(join(process.cwd(), 'requirement.md'), 'utf8');
    const row = requirement.split('\n').find((line) => line.startsWith('| 404 |'));
    expect(row).toContain('`asset_not_found`');
    expect(row).toContain('非订阅者读取 `paid` 正文');
    expect(requirement.split('\n').find((line) => line.startsWith('| 403 |'))).not.toContain('paid');
  });
});
