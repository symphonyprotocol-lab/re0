/**
 * A server module (a page, layout or route under `app/`, or anything under
 * `lib/`) that imports a value from a `'use client'` module gets a client
 * reference on the server, not the value: #215's share page built its
 * sign-in link from `REE_ASK_ANCHOR` imported from the box's client module
 * and production sent `returnTo=/s/<slug>#function(){throw Error(...)}`.
 * Vitest does not apply the directive, so no render test sees it; this
 * reads the imports instead. Components (PascalCase) and type-only imports
 * are what a server module may take from a client one.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const isClient = (path: string) => /^\s*(?:(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)\s*)*['"]use client['"]/.test(readFileSync(path, 'utf8').slice(0, 400));

function resolve(spec: string, from: string): string | null {
  const base = spec.startsWith('@/') ? join(ROOT, spec.slice(2)) : spec.startsWith('.') ? normalize(join(dirname(from), spec)) : null;
  if (!base) return null;
  return ['.tsx', '.ts', '/index.tsx', '/index.ts'].map((ext) => base + ext).find((path) => existsSync(path)) ?? null;
}

/** A named import a server module may take from a client module: a component. */
const isComponent = (name: string) => /^[A-Z][a-z0-9]/.test(name) && !/^[A-Z0-9_]+$/.test(name);

describe('the client boundary', () => {
  it('no server module imports a value other than a component from a client module', () => {
    const files = ['app', 'components', 'lib', 'i18n'].flatMap((dir) => walk(join(ROOT, dir)));
    const client = new Set(files.filter(isClient));
    const servers = files.filter((path) => !client.has(path) && /^(app|lib)\//.test(relative(ROOT, path)));
    const found: string[] = [];
    for (const path of servers) {
      for (const match of readFileSync(path, 'utf8').matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g)) {
        if (match[1]) continue;
        const target = resolve(match[3]!, path);
        if (!target || !client.has(target)) continue;
        for (const raw of match[2]!.split(',').map((part) => part.trim()).filter(Boolean)) {
          if (raw.startsWith('type ')) continue;
          const name = raw.split(/\s+as\s+/)[0]!.trim();
          if (!isComponent(name)) found.push(`${relative(ROOT, path)} imports ${name} from ${relative(ROOT, target)}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
