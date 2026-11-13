// Class-name mangling of the shipped WebUI (ui.js + ui-base/ui-simple CSS). Shared by
// build.mjs and scripts/size-report.mjs, so the size report measures the shipped form.
//
// Safe by construction: a class is renamed only when EVERY occurrence of its name as a
// token of any string/template literal in ui.js sits in a recognized class context
// (`class`/`className`/`cls` props, `.className =`, `classList.*`, `querySelector*`-style
// selectors, `class="…"` in HTML strings). One stray occurrence (prose, an id, an
// attribute value) or a dynamic prefix (`xkey-status-${…}`) keeps that class as it is,
// in the CSS and the JS alike.
import { parse } from '@babel/parser';

const CLASS_KEYS = new Set(['class', 'className', 'cls']);
const CLASSLIST_METHODS = new Set(['add', 'remove', 'toggle', 'contains']);
const SELECTOR_METHODS = new Set(['querySelector', 'querySelectorAll', 'closest', 'matches']);
const STRINGS = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;
const CSS_CLASS = /\.(-?[_a-z][\w-]*)/gi;
const TOKEN = /[\w-]+/g;
const NAME_HEAD = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const NAME_TAIL = `${NAME_HEAD}0123456789`;

/** Class names in minified CSS, with their occurrence count. */
export function cssClasses(css) {
  const bare = css.replace(STRINGS, '""');
  // Escapes and unquoted url() would need a real CSS tokenizer; fail loudly instead.
  if (/\\|url\((?!["'])/.test(bare))
    throw new Error('class-mangle: CSS has an escape or bare url()');
  const counts = new Map();
  for (const m of bare.matchAll(CSS_CLASS)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  return counts;
}

const keyName = (p) => (p.computed ? null : (p.key.name ?? p.key.value));

// True when the edge of `e` is whitespace, so it cannot glue onto a neighboring token
// (an empty string adds nothing at all).
function edgeIsSpace(e, atEnd) {
  const space = atEnd ? /\s$/ : /^\s/;
  if (e.type === 'StringLiteral') return e.value === '' || space.test(e.value);
  if (e.type === 'TemplateLiteral')
    return space.test((atEnd ? e.quasis.at(-1) : e.quasis[0]).value.raw);
  if (e.type === 'ConditionalExpression')
    return edgeIsSpace(e.consequent, atEnd) && edgeIsSpace(e.alternate, atEnd);
  return false;
}
const endsWithSpace = (e) => edgeIsSpace(e, true);
const startsWithSpace = (e) => edgeIsSpace(e, false);

// Parents through which a literal still ends up in the same string.
const TRANSPARENT = new Set([
  'ConditionalExpression',
  'LogicalExpression',
  'SequenceExpression',
  'BinaryExpression',
  'TemplateLiteral',
]);

function keepsValue(parent, key, index) {
  if (parent.type === 'ConditionalExpression') return key !== 'test';
  if (parent.type === 'SequenceExpression') return index === parent.expressions.length - 1;
  if (parent.type === 'BinaryExpression') return parent.operator === '+';
  return true;
}

/** Records whether the literal's start/end is glued to a neighbor of `parent`. */
function noteGlue(parent, key, index, glue) {
  if (parent.type === 'BinaryExpression') {
    if (key === 'left') glue.atEnd ||= !startsWithSpace(parent.right);
    else glue.atStart ||= !endsWithSpace(parent.left);
  } else if (parent.type === 'TemplateLiteral' && key === 'expressions') {
    const before = parent.quasis[index].value.raw;
    const after = parent.quasis[index + 1].value.raw;
    glue.atStart ||= (index > 0 || before !== '') && !/\s$/.test(before);
    glue.atEnd ||= (index + 1 < parent.expressions.length || after !== '') && !/^\s/.test(after);
  }
}

function callMode(call, key, index) {
  const callee = call.callee;
  if (key !== 'arguments' || callee.type !== 'MemberExpression') return null;
  const method = callee.property.name;
  if (SELECTOR_METHODS.has(method) && index === 0) return 'selector';
  const list = callee.object;
  const viaClassList = list.type === 'MemberExpression' && list.property.name === 'classList';
  return viaClassList && CLASSLIST_METHODS.has(method) ? 'tokens' : null;
}

/** What a literal directly under `parent` is: 'tokens', 'selector' or null (unrecognized). */
function terminalMode(parent, key, index) {
  switch (parent.type) {
    case 'ObjectProperty':
      return key === 'value' && CLASS_KEYS.has(keyName(parent)) ? 'tokens' : null;
    case 'AssignmentExpression': {
      const left = parent.left;
      const isClassName = left.type === 'MemberExpression' && left.property.name === 'className';
      return key === 'right' && parent.operator === '=' && isClassName ? 'tokens' : null;
    }
    case 'CallExpression':
      return callMode(parent, key, index);
    default:
      return null;
  }
}

/**
 * Climbs from a literal (last frame) to the construct that decides what it means.
 * Returns { mode, atStart, atEnd } with mode 'tokens' | 'selector' | null; atStart/atEnd
 * say the literal's edge is glued to a neighbor (`a + "b"`, `x${…}`), so its first/last
 * token may be only part of a class name.
 */
function classify(stack) {
  const glue = { atStart: false, atEnd: false };
  for (let i = stack.length - 1; i > 0; i--) {
    const { key, index } = stack[i];
    const parent = stack[i - 1].node;
    if (!TRANSPARENT.has(parent.type)) return { mode: terminalMode(parent, key, index), ...glue };
    if (!keepsValue(parent, key, index)) break;
    noteGlue(parent, key, index, glue);
  }
  return { mode: null, ...glue };
}

/** Source range and text of a string / template literal node. */
function literalText(js, node) {
  const isString = node.type === 'StringLiteral';
  const start = isString ? node.start + 1 : node.start;
  const end = isString ? node.end - 1 : node.end;
  const raw = js.slice(start, end);
  return { start, end, raw, cooked: isString ? node.value : (node.value.cooked ?? raw) };
}

function describeLiteral(js, stack) {
  const { node, key, index } = stack.at(-1);
  const parent = stack.at(-2).node;
  const text = literalText(js, node);
  const isKey = parent.type === 'ObjectProperty' && key === 'key';
  const info = isKey ? { mode: null } : classify(stack);
  let { atStart, atEnd } = info;
  if (node.type === 'TemplateElement') {
    // Inner edges touch a `${…}` unless that expression is known to start/end with space.
    const { quasis, expressions } = parent;
    if (index > 0) atStart = !endsWithSpace(expressions[index - 1]);
    if (index < quasis.length - 1) atEnd = !startsWithSpace(expressions[index]);
  }
  // An escape would put raw and cooked offsets out of step; treat it as unrecognized.
  const mode = text.raw === text.cooked ? info.mode : null;
  return { ...text, mode, atStart, atEnd };
}

/** Every string / template literal of the script, in source order. */
function scanLiterals(js) {
  const literals = [];
  const stack = [];
  const visit = (node, key, index) => {
    if (!node || typeof node.type !== 'string') return;
    stack.push({ node, key, index });
    if (node.type === 'StringLiteral' || node.type === 'TemplateElement')
      literals.push(describeLiteral(js, stack));
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (k === 'loc' || k === 'extra') continue;
      if (Array.isArray(v)) v.forEach((child, i) => visit(child, k, i));
      else visit(v, k, undefined);
    }
    stack.pop();
  };
  visit(parse(js, { sourceType: 'script' }).program, '', undefined);
  return literals.toSorted((x, y) => x.start - y.start);
}

/** `class="a b"` value spans inside an HTML string (raw text, so quotes may be `\"`). */
function htmlClassSpans(raw) {
  return [...raw.matchAll(/class=\\?["']([^"'\\]*)/g)].map((m) => ({
    from: m.index + m[0].length - m[1].length,
    text: m[1],
  }));
}

/** Class-name token spans of a recognized literal (offsets into raw). */
function recognizedSpans(lit) {
  const spans = [];
  if (lit.mode === 'tokens') {
    for (const m of lit.raw.matchAll(TOKEN)) spans.push({ at: m.index, name: m[0] });
  } else if (lit.mode === 'selector') {
    for (const m of lit.raw.matchAll(/\.([\w-]+)/g)) spans.push({ at: m.index + 1, name: m[1] });
  }
  if (lit.mode === null)
    for (const { from, text } of htmlClassSpans(lit.raw))
      for (const m of text.matchAll(TOKEN)) spans.push({ at: from + m.index, name: m[0] });
  return spans;
}

/** Generated names: one character, then two, never one that is already in use. */
function* freshNames(taken) {
  const all = [...NAME_HEAD];
  for (const a of NAME_HEAD) for (const b of NAME_TAIL) all.push(a + b);
  for (const n of all) if (!taken.has(n)) yield n;
}

/** Keeps the classes that start (prefix) or end (suffix) with `name`. */
function keepAround(counts, keep, name, how) {
  const matches = how === 'prefix' ? (c) => c.startsWith(name) : (c) => c.endsWith(name);
  for (const c of counts.keys()) if (matches(c)) keep(c, `${how} ${name}`);
}

/** Keeps every class that a dash-ended or glued fragment of `lit` could be part of. */
function keepFragments(lit, m, counts, keep) {
  const name = m[0];
  const touchesStart = lit.atStart && m.index === 0;
  const touchesEnd = lit.atEnd && m.index + name.length === lit.cooked.length;
  // Outside a class context only dash-separated fragments count: prose such as
  // `second${n === 1 ? '' : 's'}` would otherwise drag in every class ending in "s".
  const classy = lit.mode !== null;
  if (name.endsWith('-') || (touchesEnd && classy)) keepAround(counts, keep, name, 'prefix');
  if (touchesStart && (classy || name.startsWith('-'))) keepAround(counts, keep, name, 'suffix');
  return touchesStart || touchesEnd;
}

/** Keeps the classes `lit` uses outside a recognized class context; collects its tokens. */
function noteLiteral(lit, counts, keep, taken) {
  // Recognized tokens still to be matched, per name; any token beyond them is a stray.
  const unmatched = new Map();
  for (const { name } of recognizedSpans(lit)) unmatched.set(name, (unmatched.get(name) ?? 0) + 1);
  for (const m of lit.cooked.matchAll(TOKEN)) {
    const name = m[0];
    taken.add(name);
    const glued = keepFragments(lit, m, counts, keep);
    if (!counts.has(name)) continue;
    if (glued) keep(name, 'glued to a neighbor');
    else if (unmatched.get(name)) unmatched.set(name, unmatched.get(name) - 1);
    else keep(name, `stray in ${JSON.stringify(lit.cooked.slice(0, 40))}`);
  }
}

function planMap(css, literals, selected) {
  const counts = cssClasses(css);
  const kept = new Map();
  const keep = (name, why) => kept.has(name) || kept.set(name, why);
  for (const name of selected) if (counts.has(name)) keep(name, 'selected by a test');
  const taken = new Set(counts.keys());
  for (const lit of literals) noteLiteral(lit, counts, keep, taken);
  const use = new Map(counts);
  for (const lit of literals)
    for (const { name } of recognizedSpans(lit)) use.set(name, (use.get(name) ?? 0) + 1);
  const order = [...counts.keys()]
    .filter((c) => !kept.has(c))
    .toSorted((x, y) => use.get(y) - use.get(x) || (x < y ? -1 : 1));
  const names = freshNames(taken);
  return { map: new Map(order.map((c) => [c, names.next().value])), kept, classes: counts.size };
}

function rewriteJs(js, literals, map) {
  let out = '';
  let pos = 0;
  for (const lit of literals) {
    if (lit.start < pos) continue;
    const edits = recognizedSpans(lit)
      .filter(({ name }) => map.has(name))
      .toSorted((a, b) => a.at - b.at);
    if (edits.length === 0) continue;
    let text = '';
    let at = 0;
    for (const e of edits) {
      text += lit.raw.slice(at, e.at) + map.get(e.name);
      at = e.at + e.name.length;
    }
    out += js.slice(pos, lit.start) + text + lit.raw.slice(at);
    pos = lit.end;
  }
  return out + js.slice(pos);
}

function rewriteCss(css, map) {
  return css.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\.(-?[_a-z][\w-]*)/gi, (m, name) =>
    name !== undefined && map.has(name) ? `.${map.get(name)}` : m,
  );
}

/**
 * The output must be consistent with the plan: unique new names that touch no kept class,
 * no mangled-away name left in a literal or in the CSS, and as many classes as before.
 * @param {{ map: Map<string, string>, kept: Map<string, string>, classes: number, js: string, css: string[] }} out
 */
export function assertMangled({ map, kept, classes, js, css }) {
  if (new Set(map.values()).size !== map.size) throw new Error('class-mangle: duplicate new name');
  const clash = [...map.values()].filter((n) => kept.has(n));
  if (clash.length > 0)
    throw new Error(`class-mangle: new name collides with a kept class: ${clash}`);
  const left = scanLiterals(js).flatMap((lit) =>
    [...lit.cooked.matchAll(TOKEN)].map((m) => m[0]).filter((t) => map.has(t)),
  );
  if (left.length > 0)
    throw new Error(`class-mangle: mangled-away name left in a literal: ${[...new Set(left)]}`);
  const after = cssClasses(css.join(''));
  const stale = [...after.keys()].filter((c) => map.has(c));
  if (stale.length > 0) throw new Error(`class-mangle: mangled-away name left in CSS: ${stale}`);
  if (after.size !== classes) throw new Error('class-mangle: class count changed in CSS');
}

const STRING_LITERAL = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g;

/** Classes of `known` that test sources select by (`'.name'` inside a string literal). */
export function selectedClasses(sources, known) {
  const found = new Set();
  for (const source of sources)
    for (const literal of source.match(STRING_LITERAL) ?? [])
      for (const m of literal.matchAll(/\.([_a-z][\w-]*)/gi)) if (known.has(m[1])) found.add(m[1]);
  return found;
}

/**
 * @param {string[]} cssParts minified ui-base / ui-simple CSS (as served together)
 * @param {string} js built (minified) ui.js
 * @param {Iterable<string>} [selected] classes to leave alone (opt-in mock form: what e2e selects by)
 * @returns {{ js: string, css: string[], stats: object, kept: Map<string, string> }}
 */
export function mangleClasses(cssParts, js, selected = []) {
  const literals = scanLiterals(js);
  const { map, kept, classes } = planMap(cssParts.join(''), literals, selected);
  const out = {
    map,
    kept,
    classes,
    js: rewriteJs(js, literals, map),
    css: cssParts.map((css) => rewriteCss(css, map)),
  };
  assertMangled(out);

  const why = (prefix) => [...kept.values()].filter((v) => v.startsWith(prefix)).length;
  const stats = {
    classes,
    mangled: map.size,
    kept: kept.size,
    stray: why('stray'),
    selected: why('selected'),
    prefix: why('prefix') + why('suffix') + why('glued'),
  };
  return { js: out.js, css: out.css, stats, kept };
}
