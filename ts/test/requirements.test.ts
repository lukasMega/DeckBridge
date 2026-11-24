import assert from 'tjs:assert';
import { checkRequirements } from '../src/web/server/requirements.js';
import { testAsync as asyncTest, summary } from './helpers/harness.js';

// Regression for #252: fileExists spawned `cmd /c if exist "..."`, which always
// failed on Windows. Drive it through checkRequirements via $DECKBRIDGE_NATIVE_LIB.

const ROOT = `${tjs.tmpDir}/requirements-test-${tjs.pid}`;
await tjs.makeDir(ROOT, { recursive: true });
const file = `${ROOT}/libdeckbridge_native.test`;
await tjs.writeFile(file, 'x');

async function nativeOk(path: string): Promise<boolean> {
  const prev = tjs.env.DECKBRIDGE_NATIVE_LIB;
  tjs.env.DECKBRIDGE_NATIVE_LIB = path;
  try {
    const results = await checkRequirements();
    return results.find((r) => r.name === 'deckbridge_native')!.ok;
  } finally {
    if (prev === undefined) delete tjs.env.DECKBRIDGE_NATIVE_LIB;
    else tjs.env.DECKBRIDGE_NATIVE_LIB = prev;
  }
}

console.log('\ncheckRequirements: binary existence');

await asyncTest('existing regular file → ok', async () => {
  assert.equal(await nativeOk(file), true);
});

await asyncTest('missing path → not ok', async () => {
  assert.equal(await nativeOk(`${ROOT}/nope`), false);
});

await asyncTest('directory → not ok', async () => {
  assert.equal(await nativeOk(ROOT), false);
});

await tjs.remove(ROOT, { recursive: true });

summary();
