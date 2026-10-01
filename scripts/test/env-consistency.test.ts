import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ERROR_CATALOG } from '@ibt/shared';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// P9-T3: env names, error codes, spec line references and README commands must agree across
// the `.env.example` files, README.md, Plan.md and the code. Each failure names the file and
// the key; the only exception list is ROUTER_LEVEL_CODES, and it must stay exact.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APPS = ['api', 'keeper', 'web'] as const;
type App = (typeof APPS)[number];
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;
const SPEC_LINES = 678;
const CATALOG_CODES = new Set(Object.keys(ERROR_CATALOG));

/**
 * Codes a handler sends without `AppError`, so they are not in `ERROR_CATALOG` (plan §13).
 * P4-T3's 501 `not_implemented` was removed by P4-T4; a stale entry here fails the suite.
 */
const ROUTER_LEVEL_CODES: Readonly<Record<string, string>> = {
  token_already_launched:
    'P5-T1: the tokens router answers 409 when a launched model is prepared or confirmed again; @ibt/shared has no launch-conflict code',
};

function once<T>(compute: () => T): () => T {
  let cached: { value: T } | undefined;
  return () => (cached ??= { value: compute() }).value;
}

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const splitLines = (text: string): string[] => text.split(/\r?\n/);
const catalogStatus = (code: string): number | undefined =>
  CATALOG_CODES.has(code)
    ? ERROR_CATALOG[code as keyof typeof ERROR_CATALOG].httpStatus
    : undefined;

function childDirs(parent: string, marker: string): string[] {
  return readdirSync(join(ROOT, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, parent, entry.name, marker)))
    .map((entry) => `${parent}/${entry.name}`)
    .sort();
}

function sourceFiles(dir: string, recursive = true): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (recursive && entry.name !== 'node_modules' && entry.name !== 'dist') {
        files.push(...sourceFiles(path));
      }
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(path);
    }
  }
  return files.sort();
}

function parse(path: string): ts.SourceFile {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, kind);
}

function visit(node: ts.Node, fn: (node: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

const lineAt = (sf: ts.SourceFile, pos: number): number =>
  sf.getLineAndCharacterOfPosition(pos).line + 1;
const at = (sf: ts.SourceFile, node: ts.Node): string =>
  `${sf.fileName}:${lineAt(sf, node.getStart(sf))}`;

function propertyName(node: ts.Node): string | undefined {
  if (
    !ts.isPropertyAssignment(node) &&
    !ts.isPropertyDeclaration(node) &&
    !ts.isShorthandPropertyAssignment(node)
  ) {
    return undefined;
  }
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
}

interface Table {
  headerLine: number;
  rows: { line: number; cells: string[] }[];
}

function markdownTable(path: string, header: RegExp): Table {
  const lines = splitLines(read(path));
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) throw new Error(`${path}: no table with a header matching ${String(header)}`);
  const rows: Table['rows'] = [];
  for (let index = start + 2; ; index += 1) {
    const line = lines[index];
    if (line === undefined || !line.startsWith('|')) break;
    const cells = line.split(/(?<!\\)\|/).slice(1, -1);
    rows.push({ line: index + 1, cells: cells.map((cell) => cell.trim()) });
  }
  return { headerLine: start + 1, rows };
}

interface EnvExample {
  keys: string[];
  duplicates: string[];
  unparsed: string[];
}

/** Tiny `.env` parser: `KEY=value` at line start; blank lines and `#` comments are skipped. */
function parseEnvExample(path: string): EnvExample {
  const parsed: EnvExample = { keys: [], duplicates: [], unparsed: [] };
  splitLines(read(path)).forEach((line, index) => {
    if (line.trim() === '' || line.trimStart().startsWith('#')) return;
    const key = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    if (key === undefined) parsed.unparsed.push(`${path}:${index + 1}`);
    else if (parsed.keys.includes(key)) parsed.duplicates.push(`${path}: ${key}`);
    else parsed.keys.push(key);
  });
  return parsed;
}

/** Innermost zod factory of a chain, e.g. `'undefined'` for `z.undefined({...}).optional()`. */
function zodFactory(expr: ts.Expression): string | undefined {
  let current: ts.Expression = expr;
  let name: string | undefined;
  while (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) {
    if (ts.isPropertyAccessExpression(current)) name = current.name.text;
    current = current.expression;
  }
  return ts.isIdentifier(current) && current.text === 'z' ? name : undefined;
}

interface SchemaKeys {
  read: string[];
  refused: string[];
}

/**
 * Keys of the env `z.object({...})` in `apps/<app>/src/env.ts`, read from the AST: the apps
 * are not dependencies of scripts, and web's env.ts parses `import.meta.env` on import.
 * `refused` keys are declared `z.undefined()`: the app will not start when they are set.
 */
function schemaKeys(app: App): SchemaKeys {
  const path = `apps/${app}/src/env.ts`;
  const objects: ts.ObjectLiteralExpression[] = [];
  visit(parse(path), (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'object' &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'z'
    ) {
      const [arg] = node.arguments;
      const isEnv =
        arg !== undefined &&
        ts.isObjectLiteralExpression(arg) &&
        arg.properties.some((property) => ENV_KEY.test(propertyName(property) ?? ''));
      if (isEnv) objects.push(arg);
    }
  });
  const [object] = objects;
  if (object === undefined || objects.length !== 1) {
    throw new Error(`${path}: expected one z.object({...}) of env keys, found ${objects.length}`);
  }
  const keys: SchemaKeys = { read: [], refused: [] };
  for (const property of object.properties) {
    const name = propertyName(property);
    if (name === undefined || !ENV_KEY.test(name)) {
      throw new Error(`${path}: cannot read env key from \`${property.getText()}\``);
    }
    const refused =
      ts.isPropertyAssignment(property) && zodFactory(property.initializer) === 'undefined';
    (refused ? keys.refused : keys.read).push(name);
  }
  return keys;
}

interface ReadmeEnv {
  usedBy: Map<string, Set<string>>;
  duplicates: string[];
}

const readmeEnv = once((): ReadmeEnv => {
  const env: ReadmeEnv = { usedBy: new Map(), duplicates: [] };
  const table = markdownTable('README.md', /^\|\s*Variable\s*\|\s*Used by\s*\|/);
  for (const { line, cells } of table.rows) {
    const name = /^`([A-Z][A-Z0-9_]*)`$/.exec(cells[0] ?? '')?.[1];
    if (name === undefined) throw new Error(`README.md:${line}: cannot read the variable name`);
    if (env.usedBy.has(name)) env.duplicates.push(`README.md:${line}: ${name}`);
    const users = (cells[1] ?? '').replace(/\([^)]*\)/g, '').split(',');
    env.usedBy.set(name, new Set(users.map((user) => user.trim()).filter((user) => user !== '')));
  }
  return env;
});

const examples = once(
  () => new Map(APPS.map((app) => [app, parseEnvExample(`apps/${app}/.env.example`)])),
);
const schemas = once(() => new Map(APPS.map((app) => [app, schemaKeys(app)])));
const example = (app: App): EnvExample => examples().get(app) ?? parseEnvExample('');
const schema = (app: App): SchemaKeys => schemas().get(app) ?? schemaKeys(app);

describe('env names', () => {
  it('each .env.example holds only KEY=value lines, each key once', () => {
    const problems = APPS.flatMap((app) => [
      ...example(app).unparsed.map((where) => `${where}: not a KEY=value line`),
      ...example(app).duplicates.map((where) => `${where} appears twice`),
    ]);
    const { duplicates } = readmeEnv();
    expect(problems).toEqual([]);
    expect(duplicates, 'README env table lists a variable twice').toEqual([]);
    console.log(
      `[env] .env.example keys: ${APPS.map((app) => `${app} ${example(app).keys.length}`).join(', ')}; ` +
        `schema keys: ${APPS.map((app) => `${app} ${schema(app).read.length}`).join(', ')}; ` +
        `README rows: ${readmeEnv().usedBy.size}`,
    );
  });

  it('every .env.example key is in the README env table', () => {
    const missing = APPS.flatMap((app) =>
      example(app)
        .keys.filter((key) => !readmeEnv().usedBy.has(key))
        .map((key) => `apps/${app}/.env.example: ${key} has no row in README.md`),
    );
    expect(missing).toEqual([]);
  });

  it('every key an app schema reads is in that app’s .env.example', () => {
    const missing = APPS.flatMap((app) =>
      schema(app)
        .read.filter((key) => !example(app).keys.includes(key))
        .map((key) => `apps/${app}/src/env.ts reads ${key}; add it to apps/${app}/.env.example`),
    );
    expect(missing).toEqual([]);
  });

  it('every .env.example key is read by that app’s schema', () => {
    const unread = APPS.flatMap((app) =>
      example(app)
        .keys.filter((key) => !schema(app).read.includes(key) && !schema(app).refused.includes(key))
        .map((key) => `apps/${app}/.env.example: ${key} is not read by apps/${app}/src/env.ts`),
    );
    expect(unread).toEqual([]);
  });

  it('keys an app refuses (z.undefined) are absent from its .env.example', () => {
    const present = APPS.flatMap((app) =>
      schema(app)
        .refused.filter((key) => example(app).keys.includes(key))
        .map((key) => `apps/${app}/.env.example: ${key} must not be set for ${app}`),
    );
    expect(present).toEqual([]);
  });

  it('README documents every schema key, with "Used by" matching the schemas', () => {
    const problems: string[] = [];
    for (const app of APPS) {
      for (const key of schema(app).read) {
        if (!readmeEnv().usedBy.has(key)) problems.push(`README.md: no row for ${key} (${app})`);
      }
    }
    for (const [key, users] of readmeEnv().usedBy) {
      for (const app of APPS) {
        const reads = schema(app).read.includes(key);
        if (reads && !users.has(app)) {
          problems.push(
            `README.md ${key}: apps/${app}/src/env.ts reads it, "Used by" omits ${app}`,
          );
        } else if (!reads && users.has(app)) {
          problems.push(
            `README.md ${key}: "Used by" lists ${app}, apps/${app}/src/env.ts does not read it`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('every variable in the spec env table (Plan.md) is in the README env table', () => {
    const table = markdownTable('Plan.md', /^\|\s*Variable\s*\|\s*Used by\s*\|/);
    const names = table.rows.flatMap(({ cells }) =>
      [...(cells[0] ?? '').matchAll(/`([A-Z][A-Z0-9_]*\*?)`/g)].map((match) => match[1] ?? ''),
    );
    const documented = [...readmeEnv().usedBy.keys()];
    const missing = names.filter((name) =>
      name.endsWith('*')
        ? !documented.some((key) => key.startsWith(name.slice(0, -1)))
        : !documented.includes(name),
    );
    expect(names.length).toBeGreaterThan(0);
    expect(missing.map((name) => `Plan.md env table: ${name} has no row in README.md`)).toEqual([]);
    console.log(`[env] spec env table names: ${names.length}`);
  });
});

interface CodeUse {
  code: string;
  at: string;
}

/** String literals an expression can evaluate to: `'a'`, `('a')`, `cond ? 'a' : 'b'`. */
function literalValues(expr: ts.Expression): string[] | undefined {
  if (ts.isStringLiteralLike(expr)) return [expr.text];
  if (ts.isParenthesizedExpression(expr)) return literalValues(expr.expression);
  if (ts.isConditionalExpression(expr)) {
    const whenTrue = literalValues(expr.whenTrue);
    const whenFalse = literalValues(expr.whenFalse);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : undefined;
  }
  return undefined;
}

interface CodeScan {
  files: number;
  appError: CodeUse[];
  dynamic: string[];
  direct: CodeUse[];
}

const errorScan = once((): CodeScan => {
  const files = [
    ...sourceFiles('apps/api/src'),
    ...sourceFiles('apps/keeper/src'),
    ...childDirs('packages', 'src').flatMap((dir) => sourceFiles(`${dir}/src`)),
  ];
  const scan: CodeScan = { files: files.length, appError: [], dynamic: [], direct: [] };
  for (const path of files) {
    const sf = parse(path);
    visit(sf, (node) => {
      if (
        (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'AppError'
      ) {
        const arg = node.arguments?.[0];
        const codes = arg === undefined ? undefined : literalValues(arg);
        if (codes === undefined) scan.dynamic.push(at(sf, node));
        else scan.appError.push(...codes.map((code) => ({ code, at: at(sf, node) })));
        return;
      }
      if (
        (ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) &&
        propertyName(node) === 'code' &&
        node.initializer !== undefined &&
        ts.isStringLiteralLike(node.initializer)
      ) {
        const parent = node.parent;
        const errorClass = ts.isClassLike(parent) && parent.heritageClauses !== undefined;
        const errorBody =
          ts.isObjectLiteralExpression(parent) && propertyName(parent.parent) === 'error';
        if (errorClass || errorBody)
          scan.direct.push({ code: node.initializer.text, at: at(sf, node) });
      }
    });
  }
  return scan;
});

function report(label: string, codes: Iterable<string>): void {
  const list = [...codes].sort();
  if (list.length > 0) console.log(`[errors] ${label}: ${list.join(', ')}`);
}

describe('error codes', () => {
  it('every AppError code is in ERROR_CATALOG', () => {
    const { files, appError, dynamic } = errorScan();
    const unknown = appError
      .filter(({ code }) => !CATALOG_CODES.has(code))
      .map(({ code, at: where }) => `${where}: ${code} is not in ERROR_CATALOG`);
    console.log(
      `[errors] AppError uses: ${appError.length} in ${files} files ` +
        `(${new Set(appError.map(({ code }) => code)).size} distinct codes)`,
    );
    report('AppError calls with a non-literal code (typed ErrorCode)', dynamic);
    expect(appError.length).toBeGreaterThan(0);
    expect(unknown).toEqual([]);
  });

  it('codes sent without AppError are catalog codes or documented router-level codes', () => {
    const { direct } = errorScan();
    const sent = new Set(direct.map(({ code }) => code));
    const problems = [
      ...direct
        .filter(({ code }) => !CATALOG_CODES.has(code) && !(code in ROUTER_LEVEL_CODES))
        .map(
          ({ code, at: where }) =>
            `${where}: ${code} is neither in ERROR_CATALOG nor ROUTER_LEVEL_CODES`,
        ),
      ...Object.keys(ROUTER_LEVEL_CODES)
        .filter((code) => !sent.has(code) || CATALOG_CODES.has(code))
        .map(
          (code) => `ROUTER_LEVEL_CODES.${code} is stale (no longer sent, or now in ERROR_CATALOG)`,
        ),
    ];
    report('codes sent without AppError', sent);
    expect(problems).toEqual([]);
  });

  it('the spec error table (Plan.md L417–426) agrees with ERROR_CATALOG', () => {
    const table = markdownTable('Plan.md', /^\|\s*Status\s*\|\s*`error\.code`\s*\|/);
    const rows = table.rows.map(({ line, cells }) => ({
      line,
      status: Number(cells[0]),
      code: /^`([a-z_]+)`$/.exec(cells[1] ?? '')?.[1] ?? `<unreadable: ${cells[1]}>`,
    }));
    // errors.ts and the web docs page cite the table by these lines.
    expect([table.headerLine, rows.at(-1)?.line]).toEqual([417, 426]);
    const mismatches = rows
      .filter(({ code, status }) => CATALOG_CODES.has(code) && catalogStatus(code) !== status)
      .map(
        ({ line, code, status }) =>
          `Plan.md:${line}: ${code} is ${status}, ERROR_CATALOG says ${catalogStatus(code)}`,
      );
    const specCodes = new Set(rows.map(({ code }) => code));
    report(
      'only in the spec error table',
      [...specCodes].filter((code) => !CATALOG_CODES.has(code)),
    );
    report(
      'only in ERROR_CATALOG (not in the spec error table)',
      [...CATALOG_CODES].filter((code) => !specCodes.has(code)),
    );
    console.log(`[errors] spec error table rows: ${rows.length}`);
    expect(mismatches).toEqual([]);
  });

  it('the spec platform examples (→ <status> {"error": {"code"}}) agree with ERROR_CATALOG', () => {
    const examplesFound = splitLines(read('Plan.md')).flatMap((line, index) => {
      const match = /→ (\d{3}) \{"error": \{"code": "([a-z_]+)"/.exec(line);
      return match ? [{ line: index + 1, status: Number(match[1]), code: match[2] ?? '' }] : [];
    });
    const mismatches = examplesFound
      .filter(({ code, status }) => CATALOG_CODES.has(code) && catalogStatus(code) !== status)
      .map(
        ({ line, code, status }) =>
          `Plan.md:${line}: ${code} is ${status}, ERROR_CATALOG says ${catalogStatus(code)}`,
      );
    report(
      'only in the spec platform examples',
      examplesFound.map(({ code }) => code).filter((code) => !CATALOG_CODES.has(code)),
    );
    console.log(`[errors] spec platform examples: ${examplesFound.length}`);
    expect(examplesFound.length).toBeGreaterThan(0);
    expect(mismatches).toEqual([]);
  });

  it('the web docs error table (GATEWAY_ERRORS) agrees with ERROR_CATALOG', () => {
    const path = 'apps/web/src/pages/DocsPage.tsx';
    const rows: { status: number; code: string; at: string }[] = [];
    const sf = parse(path);
    visit(sf, (node) => {
      if (!ts.isVariableDeclaration(node) || node.name.getText(sf) !== 'GATEWAY_ERRORS') return;
      let init = node.initializer;
      while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)))
        init = init.expression;
      if (!init || !ts.isArrayLiteralExpression(init)) return;
      for (const element of init.elements) {
        const [status, code] = ts.isArrayLiteralExpression(element) ? element.elements : [];
        if (status && code && ts.isNumericLiteral(status) && ts.isStringLiteralLike(code)) {
          rows.push({ status: Number(status.text), code: code.text, at: at(sf, element) });
        } else {
          rows.push({ status: Number.NaN, code: '<unreadable>', at: at(sf, element) });
        }
      }
    });
    const problems = rows
      .filter(({ code, status }) => catalogStatus(code) !== status)
      .map(
        ({ at: where, code, status }) =>
          `${where}: ${code} ${status}, ERROR_CATALOG says ${catalogStatus(code) ?? 'nothing'}`,
      );
    expect(rows.length).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});

const SPEC_REF = /\bL(\d+)(?:[–-]L?(\d+))?\b/g;

/** Every comment in a file, found through the parser so strings and regexes never count. */
function commentsOf(sf: ts.SourceFile): ts.CommentRange[] {
  const text = sf.getFullText();
  const found = new Map<number, ts.CommentRange>();
  const walk = (node: ts.Node): void => {
    if (node.kind !== ts.SyntaxKind.JsxText && node.kind !== ts.SyntaxKind.JsxTextAllWhiteSpaces) {
      const start = node.getFullStart();
      const ranges = [
        ...(ts.getTrailingCommentRanges(text, start) ?? []),
        ...(ts.getLeadingCommentRanges(text, start) ?? []),
      ];
      for (const range of ranges) found.set(range.pos, range);
    }
    for (const child of node.getChildren(sf)) walk(child);
  };
  walk(sf);
  return [...found.values()];
}

const specLineCount = once(() => {
  const text = read('Plan.md');
  return splitLines(text.endsWith('\n') ? text.slice(0, -1) : text).length;
});

describe('spec line references', () => {
  it(`Plan.md still has ${SPEC_LINES} lines (every L<n> in the code assumes it)`, () => {
    expect(specLineCount()).toBe(SPEC_LINES);
  });

  it('every L<n> / L<n>–<m> in code comments points inside Plan.md', () => {
    const files = [
      ...childDirs('apps', 'src').flatMap((dir) => sourceFiles(`${dir}/src`)),
      ...childDirs('packages', 'src').flatMap((dir) => sourceFiles(`${dir}/src`)),
      ...sourceFiles('scripts', false),
      ...sourceFiles('scripts/lib'),
      ...sourceFiles('scripts/load'),
    ];
    const lines = specLineCount();
    const problems: string[] = [];
    let references = 0;
    let comments = 0;
    for (const path of files) {
      const sf = parse(path);
      const text = sf.getFullText();
      for (const range of commentsOf(sf)) {
        comments += 1;
        for (const match of text.slice(range.pos, range.end).matchAll(SPEC_REF)) {
          references += 1;
          const start = Number(match[1]);
          const end = match[2] === undefined ? start : Number(match[2]);
          if (start < 1 || end < start || end > lines) {
            problems.push(`${path}:${lineAt(sf, range.pos + match.index)}: ${match[0]}`);
          }
        }
      }
    }
    console.log(
      `[spec refs] ${references} references in ${comments} comments across ${files.length} files`,
    );
    expect(references).toBeGreaterThan(0);
    expect(problems, `references must lie within Plan.md's ${lines} lines`).toEqual([]);
  });
});

interface Package {
  dir: string;
  name: string;
  scripts: Record<string, string>;
}

function readPackage(dir: string): Package {
  const json = JSON.parse(read(`${dir}/package.json`)) as {
    name?: string;
    scripts?: Record<string, string>;
  };
  return { dir, name: json.name ?? dir, scripts: json.scripts ?? {} };
}

const workspacePackages = once(() =>
  [...childDirs('apps', 'package.json'), ...childDirs('packages', 'package.json'), 'scripts'].map(
    readPackage,
  ),
);

function filterPackage(filter: string): Package | undefined {
  const dir = filter.replace(/^\.\//, '').replace(/\/$/, '');
  return workspacePackages().find((pkg) => pkg.name === filter || pkg.dir === dir);
}

/** pnpm's own commands; anything else is a script name (or, at the root, a bin to exec). */
const PNPM_BUILTINS = new Set([
  'add',
  'audit',
  'config',
  'create',
  'dedupe',
  'deploy',
  'dlx',
  'exec',
  'fetch',
  'i',
  'import',
  'init',
  'install',
  'link',
  'list',
  'ls',
  'outdated',
  'pack',
  'patch',
  'prune',
  'publish',
  'rebuild',
  'remove',
  'rm',
  'root',
  'store',
  'unlink',
  'up',
  'update',
  'why',
]);

interface PnpmCall {
  snippet: string;
  filter: string | undefined;
  script: string | undefined;
}

/** `pnpm …` invocations in README code (fenced blocks and inline spans, `#` comments dropped). */
const readmePnpmCalls = once((): PnpmCall[] => {
  const text = read('README.md');
  const fence = /^```[^\n]*\n([\s\S]*?)^```/gm;
  const fenced = [...text.matchAll(fence)].flatMap((match) => splitLines(match[1] ?? ''));
  const inline = [...text.replace(fence, '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? '');
  const calls: PnpmCall[] = [];
  for (const snippet of [...fenced, ...inline].map((code) => code.replace(/(^|\s)#.*$/, '$1'))) {
    for (const match of snippet.matchAll(
      /(?:^|[\s;&|("'`])(?:corepack\s+)?pnpm\s+([^;&|)"'`]*)/g,
    )) {
      const tokens = (match[1] ?? '').trim().split(/\s+/);
      let filter: string | undefined;
      let index = 0;
      for (let token = tokens[0]; token?.startsWith('-'); token = tokens[index]) {
        if (token === '--filter' || token === '-F') {
          filter = tokens[index + 1];
          index += 2;
        } else {
          if (token.startsWith('--filter=')) filter = token.slice('--filter='.length);
          index += 1;
        }
      }
      const command = tokens[index];
      const script =
        command === 'run'
          ? tokens[index + 1]
          : command === undefined || PNPM_BUILTINS.has(command)
            ? undefined
            : command;
      calls.push({ snippet: snippet.trim(), filter, script });
    }
  }
  return calls;
});

describe('README commands', () => {
  it('every root `pnpm <script>` in README is a root package.json script (or a root bin)', () => {
    const root = readPackage('.');
    const calls = readmePnpmCalls().filter((call) => call.filter === undefined);
    const problems = calls
      .filter(
        ({ script }) =>
          script !== undefined &&
          !Object.hasOwn(root.scripts, script) &&
          !existsSync(join(ROOT, 'node_modules', '.bin', script)),
      )
      .map(({ snippet, script }) => `README.md \`${snippet}\`: "${script}" is not a root script`);
    console.log(
      `[readme] root pnpm calls: ${calls.length} (scripts: ${[...new Set(calls.map(({ script }) => script ?? '(builtin)'))].join(', ')})`,
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  it('every `pnpm --filter <pkg> <script>` in README exists in that package', () => {
    const calls = readmePnpmCalls().filter((call) => call.filter !== undefined);
    const problems: string[] = [];
    for (const { snippet, filter = '', script } of calls) {
      const pkg = filterPackage(filter);
      if (pkg === undefined) {
        problems.push(`README.md \`${snippet}\`: no workspace package matches --filter ${filter}`);
      } else if (script !== undefined && !Object.hasOwn(pkg.scripts, script)) {
        problems.push(
          `README.md \`${snippet}\`: ${pkg.dir}/package.json has no "${script}" script`,
        );
      }
    }
    console.log(
      `[readme] filtered pnpm calls: ${calls.length} (${calls.map(({ filter, script }) => `${filter} ${script ?? '(builtin)'}`).join(', ')})`,
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});
