import assert from 'tjs:assert';
import {
  isPushChannel,
  pushBodyError,
  sanitizePushText,
  toPushInput,
} from '../src/shared/push-text.js';
import { dimStyle } from '../src/shared/push-channels.js';
import { DEFAULT_TEXT_BACKGROUND, DEFAULT_TEXT_COLOR } from '../src/shared/extra-key-config.js';
import { testAsync as test, summary } from './helpers/harness.js';

console.log('\nisPushChannel');

await test('accepts valid names', () => {
  for (const c of ['a', 'obs-rec', 'ha.temp_1', 'a'.repeat(32)]) assert.ok(isPushChannel(c), c);
});

await test('rejects invalid names', () => {
  for (const c of ['', 'a'.repeat(33), '-x', '.x', 'A', 'a b', 'a/b', 'ä', 5, null]) {
    assert.ok(!isPushChannel(c), String(c));
  }
});

console.log('\nsanitizePushText');

await test('ascii round-trips', () => {
  assert.deepEqual(sanitizePushText('REC 12:34'), {
    text: 'REC 12:34',
    replaced: 0,
    truncated: false,
  });
});

await test('NFC, newlines, tabs', () => {
  assert.equal(sanitizePushText('é').text, 'é');
  assert.equal(sanitizePushText('a\r\nb\rc').text, 'a\nb\nc');
  assert.equal(sanitizePushText('a\tb').text, 'a b');
});

await test('typographic folds keep the ellipsis', () => {
  assert.equal(sanitizePushText('“hi” – ok…').text, '"hi" - ok…');
  assert.equal(sanitizePushText('€5').text, 'EUR5');
});

await test('emoji and CJK become ?', () => {
  assert.deepEqual(sanitizePushText('\u{1F600}'), { text: '?', replaced: 1, truncated: false });
  assert.equal(sanitizePushText('漢').text, '?');
});

await test('ZWJ sequences leave no joiner; variation selector dropped', () => {
  const r = sanitizePushText('\u{1F468}‍\u{1F469}‍\u{1F467}');
  assert.equal(r.text, '???');
  assert.equal(sanitizePushText('a️b').text, 'ab');
});

await test('controls dropped, newline kept', () => {
  assert.equal(sanitizePushText('a\u0001b\u007fc\u0085d\ne').text, 'abcd\ne');
});

await test('truncates to 256 code points', () => {
  const r = sanitizePushText('a'.repeat(300));
  assert.equal(r.text.length, 256);
  assert.ok(r.truncated);
  const emoji = sanitizePushText('\u{1F600}'.repeat(256));
  assert.equal(emoji.text, '?'.repeat(256));
  assert.ok(!emoji.truncated);
});

console.log('\npushBodyError / toPushInput');

await test('valid and invalid bodies', () => {
  assert.equal(pushBodyError({ text: 'x' }), null);
  assert.equal(pushBodyError({ text: '' }), null);
  assert.ok(pushBodyError({}));
  assert.ok(pushBodyError({ text: 5 }));
  for (const ttl of [-1, 1.5, 86401, '5'])
    assert.ok(pushBodyError({ text: 'x', ttl }), String(ttl));
  for (const ttl of [0, 86400]) assert.equal(pushBodyError({ text: 'x', ttl }), null);
  assert.ok(pushBodyError({ text: 'x', color: '#fff' }));
  assert.ok(pushBodyError({ text: 'x', color: 'red' }));
  assert.equal(pushBodyError({ text: 'x', color: '#AABBCC', background: '#000000' }), null);
  assert.ok(pushBodyError({ text: 'x', ttL: 5 })?.includes('ttL'));
  assert.ok(pushBodyError([]));
  assert.ok(pushBodyError(null));
});

await test('toPushInput defaults the ttl to 600', () => {
  assert.equal(toPushInput({ text: 'x' }).ttlS, 600);
  assert.equal(toPushInput({ text: 'x', ttl: 0 }).ttlS, 0);
});

console.log('\ndimStyle');

await test('blends colour halfway toward the background', () => {
  const dim = dimStyle({});
  const ch = (h: string, i: number): number => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  for (let i = 0; i < 3; i++) {
    const want = Math.round((ch(DEFAULT_TEXT_COLOR, i) + ch(DEFAULT_TEXT_BACKGROUND, i)) / 2);
    assert.equal(ch(dim.color!, i), want);
  }
  const s = dimStyle({ color: '#ffffff', background: '#000000', outline: '#ffffff', bold: true });
  assert.equal(s.color, '#808080');
  assert.equal(s.outline, '#808080');
  assert.equal(s.bold, true);
  assert.equal(s.background, '#000000');
});

summary();
