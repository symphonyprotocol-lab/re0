/**
 * A server module that imports a value from a `'use client'` module gets a
 * client reference on the server, not the value: #215's share page built
 * its sign-in link from `REE_ASK_ANCHOR` imported from the box's client
 * module and production sent `returnTo=/s/<slug>#function(){throw Error(...)}`.
 * Vitest does not apply the directive, so no render test sees it; this
 * reads the imports instead. The server graph is every module reachable
 * from `app/` and `lib/` without passing through a client module; from a
 * client module it may take components (PascalCase) and types only --
 * imported, or re-exported (`export { X } from`).
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

const source = new Map<string, string>();
const read = (path: string) => source.get(path) ?? source.set(path, readFileSync(path, 'utf8')).get(path)!;
const isClient = (path: string) => /^\s*(?:(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)\s*)*['"]use client['"]/.test(read(path).slice(0, 400));

function resolve(spec: string, from: string): string | null {
  const base = spec.startsWith('@/') ? join(ROOT, spec.slice(2)) : spec.startsWith('.') ? normalize(join(dirname(from), spec)) : null;
  if (!base) return null;
  return ['.tsx', '.ts', '/index.tsx', '/index.ts'].map((ext) => base + ext).find((path) => existsSync(path)) ?? null;
}

/** Every `import ... from` / `export ... from` of a module: what it names (null for a default or namespace import) and from where. */
function edges(path: string): { names: string[] | null; typeOnly: boolean; target: string }[] {
  const found: { names: string[] | null; typeOnly: boolean; target: string }[] = [];
  for (const match of read(path).matchAll(/(?:import|export)\s+(type\s+)?([^;'"]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const target = resolve(match[3]!, path);
    if (!target) continue;
    const braces = /\{([^}]*)\}/.exec(match[2]!);
    const names = braces ? braces[1]!.split(',').map((part) => part.trim()).filter(Boolean) : null;
    found.push({ names, typeOnly: Boolean(match[1]), target });
  }
  return found;
}

/** What a server module may take from a client module: a component. */
const isComponent = (name: string) => /^[A-Z][a-z0-9]/.test(name) && !/^[A-Z0-9_]+$/.test(name);

describe('the client boundary', () => {
  it('no server module imports or re-exports a value other than a component from a client module', () => {
    const entries = ['app', 'lib'].flatMap((dir) => walk(join(ROOT, dir))).filter((path) => !isClient(path));
    const seen = new Set<string>();
    const queue = [...entries];
    const found: string[] = [];
    while (queue.length) {
      const path = queue.pop()!;
      if (seen.has(path)) continue;
      seen.add(path);
      for (const edge of edges(path)) {
        if (!isClient(edge.target)) {
          queue.push(edge.target);
          continue;
        }
        if (edge.typeOnly || !edge.names) continue;
        for (const raw of edge.names) {
          if (raw.startsWith('type ')) continue;
          const name = raw.split(/\s+as\s+/)[0]!.trim();
          if (!isComponent(name)) found.push(`${relative(ROOT, path)} takes ${name} from ${relative(ROOT, edge.target)}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
