import assert from 'tjs:assert';
import {
  assertMangled,
  cssClasses,
  mangleClasses,
  selectedClasses,
} from '../scripts/class-mangle.mjs';
import { test, summary } from './helpers/harness.js';

console.log('\nclass-name mangling (build script)');

const CSS = '.alpha{color:red}.beta,.gamma{color:blue}.tone-a{top:0}.tone-b{top:1}.solo{left:0}';
const classesOf = (parts: string[]): string[] =>
  [...cssClasses(parts.join('')).keys()].toSorted((a, b) => a.localeCompare(b));

test('classes in class props, className, classList and selectors are renamed together', () => {
  const js =
    'x({class:"alpha beta"});el.className="gamma";el.classList.add("solo");' +
    'document.querySelector("b > .alpha");';
  const out = mangleClasses([CSS], js);
  assert.equal(out.stats.mangled, 6);
  const [, p, q] = /class:"(\w+) (\w+)"/.exec(out.js) ?? [];
  const [, r] = /className="(\w+)"/.exec(out.js) ?? [];
  const [, s] = /add\("(\w+)"\)/.exec(out.js) ?? [];
  const [, t] = /querySelector\("b > \.(\w+)"\)/.exec(out.js) ?? [];
  assert.ok(p && q && r && s);
  assert.equal(t, p, 'the selector follows the class it names');
  const css = out.css[0] ?? '';
  assert.ok(css.startsWith(`.${p}{color:red}.${q},.${r}{color:blue}`));
  assert.ok(css.endsWith(`.${s}{left:0}`));
  assert.ok(!/alpha|beta|gamma|solo/.test(out.js + css));
});

test('a stray occurrence (prose, an id, an attribute) keeps the class everywhere', () => {
  const js = 'x({class:"alpha beta"});y("Elgato alpha is on");z({id:"beta"});';
  const out = mangleClasses([CSS], js);
  assert.ok(classesOf(out.css).includes('alpha') && classesOf(out.css).includes('beta'));
  assert.ok(out.js.includes('class:"alpha beta"'));
  assert.equal(out.kept.get('alpha')?.startsWith('stray'), true);
  assert.equal(out.kept.get('beta')?.startsWith('stray'), true);
  assert.equal(out.stats.mangled, 4); // gamma, solo, tone-a, tone-b: no JS occurrence at all
});

test('a dynamic prefix keeps every class it can build', () => {
  const js = 'x({class:`tone-${n}`});y({class:"solo "+("tone-"+m)});z({class:"alpha"});';
  const out = mangleClasses([CSS], js);
  assert.ok(classesOf(out.css).includes('tone-a') && classesOf(out.css).includes('tone-b'));
  assert.ok(out.js.includes('`tone-${n}`'));
  assert.equal(out.kept.get('tone-a'), 'prefix tone-');
  assert.ok(!classesOf(out.css).includes('alpha'), 'unrelated classes are still renamed');
});

test('a fragment glued to an expression keeps the classes it could be part of', () => {
  const css = '.tone1{a:b}.tone2{a:b}.other{a:b}';
  const out = mangleClasses([css], 'x({class:"tone"+level});y({class:"other"});');
  assert.deepEqual(
    classesOf(out.css).filter((c) => c.startsWith('tone')),
    ['tone1', 'tone2'],
  );
  assert.ok(!classesOf(out.css).includes('other'));
  // a space before the expression ends the token, so nothing is glued
  const spaced = mangleClasses([css], 'x({class:"other "+level});y({class:"tone1 tone2"});');
  assert.equal(spaced.stats.mangled, 3);
});

test('HTML strings: class="…" values are renamed, other attributes are not', () => {
  const js = 'x(\'<svg class="alpha beta" fill="alpha"></svg>\');';
  const out = mangleClasses([CSS], js);
  // "alpha" also appears as a fill value, a stray, so only beta moves
  assert.ok(out.js.includes('class="alpha ') && !out.js.includes('beta'));
  assert.ok(classesOf(out.css).includes('alpha') && !classesOf(out.css).includes('beta'));
});

test('CSS: decimals and strings are left alone, rules keep their order and shape', () => {
  const css =
    '.alpha{transition:opacity .5s;content:".alpha"}@media (max-width:480px){.alpha{a:b}}';
  const out = mangleClasses([css], 'x({class:"alpha"});');
  const [name] = classesOf(out.css);
  assert.ok(name && name !== 'alpha');
  assert.equal(
    out.css[0],
    `.${name}{transition:opacity .5s;content:".alpha"}@media (max-width:480px){.${name}{a:b}}`,
  );
});

test('new names are short, unique and never an existing class or token', () => {
  const css = ['.a{x:y}', '.b{x:y}', '.c{x:y}', '.longer-name{x:y}'].join('');
  const out = mangleClasses([css], 'x({class:"a b c longer-name"});y("d");');
  const names = classesOf(out.css);
  assert.equal(new Set(names).size, 4);
  assert.ok(names.every((n) => n.length <= 2));
  assert.ok(!names.includes('d'), 'a token of some literal is never handed out');
});

test('classes that tests select by stay readable when asked to', () => {
  const known = new Set(cssClasses(CSS).keys());
  const picked = selectedClasses(
    ["page.locator('.solo')", 'x = "1.5 .nope"', '`.alpha:hover`'],
    known,
  );
  assert.deepEqual(
    [...picked].toSorted((a, b) => a.localeCompare(b)),
    ['alpha', 'solo'],
  );
  const out = mangleClasses([CSS], 'x({class:"alpha solo beta"});', picked);
  assert.ok(out.js.startsWith('x({class:"alpha solo '));
  assert.ok(classesOf(out.css).includes('alpha') && classesOf(out.css).includes('solo'));
  assert.equal(out.stats.selected, 2);
  assert.ok(!classesOf(out.css).includes('beta'));
});

test('inputs the mangler cannot rewrite safely are refused', () => {
  assert.throws(() => mangleClasses(['.a\\:b{x:y}'], 'x({class:"a"});'));
  assert.throws(() => mangleClasses(['.a{background:url(x.png)}'], 'x({class:"a"});'));
  assert.throws(() => mangleClasses(['.a{x:y}'], 'x({class:'));
});

test('assertMangled throws on a duplicate name, a collision, a leftover and a lost class', () => {
  const ok = {
    map: new Map([['alpha', 'p']]),
    kept: new Map([['solo', 'stray in "solo"']]),
    classes: 2,
    js: 'x({class:"p"});',
    css: ['.p{a:b}.solo{a:b}'],
  };
  assertMangled(ok);
  assert.throws(() =>
    assertMangled({
      ...ok,
      map: new Map([
        ['alpha', 'p'],
        ['beta', 'p'],
      ]),
    }),
  );
  assert.throws(() => assertMangled({ ...ok, map: new Map([['alpha', 'solo']]) }));
  assert.throws(() => assertMangled({ ...ok, js: 'x({class:"alpha"});' }));
  assert.throws(() => assertMangled({ ...ok, css: ['.alpha{a:b}.solo{a:b}'] }));
  assert.throws(() => assertMangled({ ...ok, css: ['.p{a:b}'] }));
});

summary();
