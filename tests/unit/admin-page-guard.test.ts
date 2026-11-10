import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every console page checks the administrator session itself. The console
 * layout checks it too, but a layout is not re-run on client navigation, so
 * a page segment fetched on its own would render with only the middleware's
 * cookie-presence check in front of it. This walks `app/admin/(console)` and
 * fails for any page whose exported functions do not start with
 * `await requireAdministrator()` -- a new page cannot ship without it.
 *
 * A `generateMetadata` that awaits nothing but `serverMessages()` reads no
 * data and is left alone.
 */
const ROOT = join(process.cwd(), 'app/admin/(console)');

function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pages(path);
    return entry.name === 'page.tsx' ? [path] : [];
  });
}

const isGuardCall = (node: ts.Node | undefined): boolean =>
  !!node &&
  ts.isAwaitExpression(node) &&
  ts.isCallExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === 'requireAdministrator';

/** `await requireAdministrator();` or `const x = await requireAdministrator();` */
function startsWithGuard(body: ts.Block | undefined): boolean {
  const first = body?.statements[0];
  if (!first) return false;
  if (ts.isExpressionStatement(first)) return isGuardCall(first.expression);
  if (ts.isVariableStatement(first)) return first.declarationList.declarations.length === 1 && isGuardCall(first.declarationList.declarations[0]!.initializer);
  return false;
}

/** The callees of every `await` in the body, by name. */
function awaitedCalls(body: ts.Node): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isAwaitExpression(node)) {
      let target: ts.Expression = node.expression;
      while (ts.isPropertyAccessExpression(target) || ts.isParenthesizedExpression(target)) target = target.expression;
      names.push(ts.isCallExpression(target) ? target.expression.getText() : target.getText());
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return names;
}

/** The exported functions of a page that run on the server without a session check. */
function unguarded(source: string, name = 'page.tsx'): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const missing: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isFunctionDeclaration(statement)) continue;
    const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported || !statement.body) continue;
    const isDefault = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    const fnName = isDefault ? 'default' : (statement.name?.text ?? '?');
    if (fnName === 'generateMetadata' && awaitedCalls(statement.body).every((callee) => callee === 'serverMessages')) continue;
    if (!startsWithGuard(statement.body)) missing.push(fnName);
  }
  /* `export default function` is the only page shape the console uses; anything else must be checked by hand. */
  if (!file.statements.some((statement) => ts.isFunctionDeclaration(statement) && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))) {
    missing.push('default (not a function declaration)');
  }
  return missing;
}

describe('console pages check the administrator session', () => {
  const files = pages(ROOT);

  it('finds the console pages', () => {
    expect(files.length).toBeGreaterThanOrEqual(28);
  });

  it.each(files.map((file) => [relative(ROOT, file), file]))('%s starts with requireAdministrator()', (_, file) => {
    expect(unguarded(readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('flags a page without the check', () => {
    expect(unguarded(`export default async function Page() { const rows = await listUsers(); return rows; }`)).toEqual(['default']);
    expect(unguarded(`export async function generateMetadata({ params }) { return { title: (await adminUser((await params).id)).name }; }\nexport default async function Page() { await requireAdministrator(); }`)).toEqual([
      'generateMetadata',
    ]);
    expect(unguarded(`export async function generateMetadata() { return { title: (await serverMessages()).t.x }; }\nexport default async function Page() { const a = await requireAdministrator(); }`)).toEqual([]);
    expect(unguarded(`const Page = async () => null;\nexport default Page;`)).toEqual(['default (not a function declaration)']);
  });
});

/**
 * The console's API: every handler outside `auth/` opens with
 * `const x = await apiAdministrator(request)` and returns its refusal.
 */
const API_ROOT = join(process.cwd(), 'app/api/admin');

function routes(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'auth' && dir === API_ROOT ? [] : routes(path);
    return entry.name === 'route.ts' ? [path] : [];
  });
}

function unguardedHandlers(source: string, dynamic = false): string[] {
  const file = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const missing: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.body || !statement.name) continue;
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const [first, second, third, fourth] = statement.body.statements;
    const declaration = first && ts.isVariableStatement(first) ? first.declarationList.declarations[0] : undefined;
    const init = declaration?.initializer;
    const guarded =
      !!init &&
      ts.isAwaitExpression(init) &&
      ts.isCallExpression(init.expression) &&
      init.expression.expression.getText() === 'apiAdministrator' &&
      !!second &&
      ts.isIfStatement(second) &&
      second.expression.getText() === `${declaration!.name.getText()} instanceof Response`;
    if (!guarded) missing.push(statement.name.text);
    /* A route with `[segments]` then checks them: `const params = await adminParams(context.params); if (params instanceof Response) return params;` */
    if (guarded && dynamic) {
      const params = third && ts.isVariableStatement(third) ? third.declarationList.declarations[0] : undefined;
      const call = params?.initializer;
      const checked =
        !!call &&
        ts.isAwaitExpression(call) &&
        ts.isCallExpression(call.expression) &&
        call.expression.expression.getText() === 'adminParams' &&
        !!fourth &&
        ts.isIfStatement(fourth) &&
        fourth.expression.getText() === `${params!.name.getText()} instanceof Response`;
      if (!checked) missing.push(`${statement.name.text} (params)`);
    }
  }
  return missing;
}

describe('console API handlers check the administrator session', () => {
  const files = routes(API_ROOT);

  it.each(files.map((file) => [relative(API_ROOT, file), file]))('%s opens with apiAdministrator()', (_, file) => {
    expect(unguardedHandlers(readFileSync(file, 'utf8'), file.includes('['))).toEqual([]);
  });

  it('flags a handler without the check', () => {
    expect(unguardedHandlers(`export async function GET(request) { return json(await listUsers()); }`)).toEqual(['GET']);
    expect(unguardedHandlers(`export async function GET(request) { const a = await apiAdministrator(request); return json(await listUsers()); }`)).toEqual(['GET']);
    const guarded = `const a = await apiAdministrator(request); if (a instanceof Response) return a;`;
    expect(unguardedHandlers(`export async function GET(request, context) { ${guarded} return json(await adminUser((await context.params).id)); }`, true)).toEqual(['GET (params)']);
    expect(unguardedHandlers(`export async function GET(request, context) { ${guarded} const p = await adminParams(context.params); if (p instanceof Response) return p; return json(await adminUser(p.id)); }`, true)).toEqual([]);
  });
});
