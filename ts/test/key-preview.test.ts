import assert from 'tjs:assert';
import {
  imageSrc,
  applyImage,
  getImageEntry,
  clearImageStore,
} from '../src/web/client/key-preview.js';
import { test, summary } from './helpers/harness.js';

// imageSrc

console.log('\nimageSrc');

test('jpeg frame → jpeg data URL', () => {
  assert.ok(imageSrc({ data: 'AAAA', format: 'jpeg' }) === 'data:image/jpeg;base64,AAAA');
});

test('bmp frame → bmp data URL', () => {
  assert.ok(imageSrc({ data: 'QkF0', format: 'bmp' }) === 'data:image/bmp;base64,QkF0');
});

// image store

console.log('\nimage store');

test('applyImage stores the entry', () => {
  clearImageStore();
  applyImage(2, { data: 'xyz', format: 'jpeg' });
  const e = getImageEntry(2);
  assert.ok(e !== undefined && e.data === 'xyz' && e.format === 'jpeg');
});

test('applyImage overwrites an existing entry', () => {
  clearImageStore();
  applyImage(2, { data: 'xyz', format: 'jpeg' });
  applyImage(2, { data: 'abc', format: 'bmp' });
  const e = getImageEntry(2);
  assert.ok(e !== undefined && e.data === 'abc' && e.format === 'bmp');
});

// Summary

summary();
