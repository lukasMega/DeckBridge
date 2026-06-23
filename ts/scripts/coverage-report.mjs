import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import libCoverage from 'istanbul-lib-coverage';
import { createContext } from 'istanbul-lib-report';
import reports from 'istanbul-reports';
import { parse } from '@babel/parser';

// @babel/parser plugins for reading the project's TypeScript source (mirrors build.mjs).
// Declared before fixMethodFunctions() is *called* below — a function declaration hoists, but
// this `const` does not, so referencing it from an earlier call site would throw a TDZ error.
const TS_PARSER_PLUGINS = [
  'typescript',
  'asyncGenerators',
  'bigInt',
  'classProperties',
  'classPrivateProperties',
  'classPrivateMethods',
  'dynamicImport',
  'exportDefaultFrom',
  'exportNamespaceFrom',
  'importMeta',
  'logicalAssignment',
  'nullishCoalescingOperator',
  'numericSeparator',
  'objectRestSpread',
  'optionalCatchBinding',
  'optionalChaining',
  'topLevelAwait',
];

const rawDir = 'coverage/.tmp';

const map = libCoverage.createCoverageMap({});
let n = 0;
for (const f of existsSync(rawDir) ? readdirSync(rawDir) : []) {
  if (!f.endsWith('.json')) continue;
  try {
    map.merge(JSON.parse(readFileSync(join(rawDir, f), 'utf8')));
    n++;
  } catch (e) {
    console.error(`skipping unreadable coverage map ${f}: ${e.message}`);
  }
}
if (n === 0) {
  console.error(`No coverage maps found in ${rawDir}/ — did the instrumented tests run?`);
  process.exit(1);
}

fixMethodFunctions(map);

const context = createContext({ coverageMap: map, dir: 'coverage' });
for (const r of ['text', 'html', 'lcov', 'json-summary']) {
  reports.create(r, { skipFull: false }).execute(context);
}
console.log(`\nMerged coverage from ${n} test process(es) → coverage/ (html/, lcov.info, coverage-summary.json)`);

// Optional threshold gate — OFF by default so `mise run coverage` always reports without
// failing on a not-yet-known baseline. Enable with COVERAGE_ENFORCE=1.
if (process.env.COVERAGE_ENFORCE === '1') {
  const total = JSON.parse(readFileSync('coverage/coverage-summary.json', 'utf8')).total;
  const thresholds = { lines: 70, statements: 70, functions: 70, branches: 60 };
  const failures = Object.entries(thresholds).filter(([k, min]) => total[k].pct < min);
  for (const [k, min] of failures) console.error(`coverage ${k} ${total[k].pct}% < ${min}%`);
  if (failures.length) process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// istanbul-lib-instrument only derives a name/decl for FunctionDeclaration and
// FunctionExpression nodes that carry an `id` (visitor.js `insertFunctionCounter`).
// Class/object methods (whose name lives on `node.key`) fall through to an anonymous
// name and a 1-character `decl`, so the HTML report's "function not covered" marker
// shrinks to a single character on the method's signature line. We repair the merged
// map by re-parsing each source and matching every anonymous fnMap entry's `loc`
// (= the method body block) to a parsed method node's body location, then restoring
// the real method name and the full name span as `decl`.

function keyName(key) {
  if (!key) return undefined;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'StringLiteral') return key.value;
  if (key.type === 'NumericLiteral') return String(key.value);
  if (key.type === 'PrivateName' && key.id) return `#${key.id.name}`;
  return undefined; // computed/other → leave name, but decl still gets fixed
}

function isMethodNode(node) {
  return (
    (node.type === 'ClassMethod' ||
      node.type === 'ObjectMethod' ||
      node.type === 'ClassPrivateMethod') &&
    node.body?.loc &&
    node.key
  );
}

function pushNodeChildren(node, stack) {
  for (const k in node) {
    if (k === 'loc' || k === 'start' || k === 'end' || k.endsWith('Comments')) continue;
    const v = node[k];
    if (v && typeof v === 'object') stack.push(v);
  }
}

// Walk the AST collecting method-like nodes that have a block body and a key.
// oxlint-disable-next-line complexity
function collectMethods(ast) {
  const methods = [];
  const stack = [ast.program ?? ast];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const c of node) stack.push(c);
      continue;
    }
    if (typeof node.type !== 'string') continue;
    if (isMethodNode(node)) methods.push(node);
    pushNodeChildren(node, stack);
  }
  return methods;
}

function parseSourceFile(file) {
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return parse(src, { sourceType: 'module', plugins: TS_PARSER_PLUGINS, errorRecovery: true });
  } catch {
    return null;
  }
}

function buildBodyMap(ast) {
  const byBody = new Map();
  for (const m of collectMethods(ast)) {
    byBody.set(`${m.body.loc.start.line}:${m.body.loc.start.column}`, m);
  }
  return byBody;
}

function repairAnonymousFns(fns, byBody) {
  for (const f of fns) {
    if (!f.name.startsWith('(anonymous_')) continue;
    const m = byBody.get(`${f.loc.start.line}:${f.loc.start.column}`);
    if (!m) continue;
    const name = keyName(m.key);
    if (name) f.name = name;
    const kl = m.key.loc;
    if (kl) {
      f.decl = {
        start: { line: kl.start.line, column: kl.start.column },
        end: { line: kl.end.line, column: kl.end.column },
      };
    }
  }
}

function fixMethodFunctions(coverageMap) {
  for (const file of coverageMap.files()) {
    const { data } = coverageMap.fileCoverageFor(file);
    const fns = Object.values(data.fnMap);
    if (!fns.some((f) => f.name.startsWith('(anonymous_'))) continue;
    const ast = parseSourceFile(file);
    if (!ast) continue;
    repairAnonymousFns(fns, buildBodyMap(ast));
  }
}
