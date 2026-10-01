import assert from 'tjs:assert';
import {
  compactTextStyle,
  effectiveTextStyle,
  isExtraKeyConfig,
  normalizeExtraKeyConfig,
  textStyleError,
  type ExtraKeyConfig,
} from '../src/shared/extra-key-config.js';
import type { ExtraKeyTextStyle } from '../src/web/contract.js';
import { test, summary } from './helpers/harness.js';

console.log('\ntext style guard');

const FULL: ExtraKeyTextStyle = {
  textSize: 'fit',
  wrap: 'words',
  font: 'narrow',
  color: '#FFD60A',
  background: '#000000',
  align: 'left',
  valign: 'bottom',
  padding: 16,
  lineGap: 8,
  bold: true,
  outline: '#101014',
  ellipsis: false,
};

test('every valid field is accepted', () => {
  assert.equal(textStyleError(FULL), null);
  assert.equal(textStyleError({}), null);
  for (const textSize of ['fit', -2, -1, 0, 1, 2] as const) {
    assert.equal(textStyleError({ textSize }), null, String(textSize));
  }
  assert.ok(isExtraKeyConfig({ widget: 'text', param: 'x', style: FULL }));
});

test('each bad field is rejected with a message naming it', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ textSize: 3 }, 'style.textSize must be one of: fit, -2, -1, 0, 1, 2'],
    [{ wrap: 'lines' }, 'style.wrap must be one of: words, chars'],
    [{ font: 'bold' }, 'style.font must be one of: regular, narrow'],
    [{ color: 'red' }, 'style.color must be a #rrggbb colour'],
    [{ background: '#fff' }, 'style.background must be a #rrggbb colour'],
    [{ outline: '#12345g' }, 'style.outline must be a #rrggbb colour'],
    [{ align: 'justify' }, 'style.align must be one of: left, center, right'],
    [{ valign: 'center' }, 'style.valign must be one of: top, middle, bottom'],
    [{ padding: 17 }, 'style.padding must be an integer 0..16'],
    [{ padding: 1.5 }, 'style.padding must be an integer 0..16'],
    [{ lineGap: -1 }, 'style.lineGap must be an integer 0..8'],
    [{ bold: 1 }, 'style.bold must be true or false'],
    [{ ellipsis: 'no' }, 'style.ellipsis must be true or false'],
    [{ size: 2 }, 'style.size is not a text style field'],
  ];
  for (const [style, message] of cases) {
    assert.equal(textStyleError(style), message);
    assert.ok(!isExtraKeyConfig({ widget: 'clock', style }), message);
  }
  assert.equal(textStyleError([]), 'style must be an object');
  assert.equal(textStyleError(null), 'style must be an object');
});

test('defaults are dropped, colours lower-cased', () => {
  assert.deepEqual(
    compactTextStyle({
      textSize: 0,
      font: 'regular',
      color: '#E8E8EC',
      background: '#101014',
      align: 'center',
      valign: 'middle',
      padding: 0,
      lineGap: 0,
      bold: false,
      ellipsis: true,
      wrap: undefined,
    }),
    {},
  );
  assert.deepEqual(compactTextStyle({ color: '#FFD60A', ellipsis: false }), {
    color: '#ffd60a',
    ellipsis: false,
  });
});

test('wrap applies to free-text widgets only', () => {
  assert.deepEqual(effectiveTextStyle({ widget: 'text', style: { wrap: 'words', bold: true } }), {
    wrap: 'words',
    bold: true,
  });
  assert.deepEqual(effectiveTextStyle({ widget: 'clock', style: { wrap: 'words', bold: true } }), {
    bold: true,
  });
  assert.deepEqual(effectiveTextStyle(undefined), {});
});

console.log('\nlegacy top-level textSize/wrap');

test('the guard still accepts them, with the old bounds', () => {
  for (const textSize of ['fit', -2, -1, 0, 1, 2]) {
    assert.ok(isExtraKeyConfig({ widget: 'clock', textSize }), String(textSize));
  }
  for (const textSize of [3, -3, 1.5, 'big', '1', null]) {
    assert.ok(!isExtraKeyConfig({ widget: 'clock', textSize }), String(textSize));
  }
  assert.ok(isExtraKeyConfig({ widget: 'text', param: 'x', wrap: 'chars' }));
  for (const wrap of [true, 'lines', 1]) {
    assert.ok(!isExtraKeyConfig({ widget: 'text', wrap }), String(wrap));
  }
});

test('normalize folds them into style; an explicit style field wins', () => {
  const legacy = { widget: 'text', param: 'x', textSize: 'fit', wrap: 'words' } as ExtraKeyConfig;
  assert.deepEqual(normalizeExtraKeyConfig(legacy), {
    widget: 'text',
    param: 'x',
    style: { textSize: 'fit', wrap: 'words' },
  });
  const both = { widget: 'text', textSize: 2, style: { textSize: -1 } } as ExtraKeyConfig;
  assert.deepEqual(normalizeExtraKeyConfig(both), { widget: 'text', style: { textSize: -1 } });
  const zero = { widget: 'clock', textSize: 0 } as ExtraKeyConfig;
  assert.deepEqual(normalizeExtraKeyConfig(zero), { widget: 'clock' });
  const current: ExtraKeyConfig = { widget: 'clock', style: { bold: true } };
  assert.equal(normalizeExtraKeyConfig(current), current, 'untouched');
});

console.log('\nexternal widget config');

test('external: channel optional, but must be valid when set', () => {
  assert.ok(isExtraKeyConfig({ widget: 'external', param: 'obs-rec' }));
  assert.ok(isExtraKeyConfig({ widget: 'external' }));
  assert.ok(!isExtraKeyConfig({ widget: 'external', param: 'Bad Name' }));
});

test('expire enum and fallbackText length are checked; legacy configs stay valid', () => {
  const base = { widget: 'external', param: 'a' };
  assert.ok(isExtraKeyConfig({ ...base, expire: 'blank', fallbackText: 'off' }));
  assert.ok(!isExtraKeyConfig({ ...base, expire: 'fade' }));
  assert.ok(!isExtraKeyConfig({ ...base, fallbackText: 'x'.repeat(129) }));
  assert.ok(isExtraKeyConfig({ widget: 'clock' }));
});

summary();
