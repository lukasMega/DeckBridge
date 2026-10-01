import assert from 'tjs:assert';
import {
  LogFileSink,
  LOG_PENDING_MAX_BYTES,
  type FileHandleLike,
  LOG_FILES_KEPT,
  LOG_ROTATE_BYTES,
  formatLine,
  logDir,
  logFilePath,
  tailLogFile,
} from '../src/infra/log-file.js';
import { testAsync as test, summary } from './helpers/harness.js';

const ROOT = `${tjs.tmpDir}/log-file-test-${tjs.pid}`;

async function readText(path: string): Promise<string> {
  return new TextDecoder().decode(await tjs.readFile(path));
}

async function exists(path: string): Promise<boolean> {
  try {
    await tjs.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function assertRejects(fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert.ok(threw, 'expected a rejection');
}

/** One line long enough that N of them cross LOG_ROTATE_BYTES quickly. */
const BIG = 'x'.repeat(64 * 1024);

// paths + formatting

console.log('\npaths and formatting');

await test('logFilePath/logDir sit under <cacheRoot>/logs', () => {
  assert.equal(logDir(ROOT), `${ROOT}/logs`);
  assert.equal(logFilePath(ROOT), `${ROOT}/logs/deckbridge.log`);
});

await test('formatLine matches the console shape', () => {
  const ts = new Date(2026, 0, 2, 3, 4, 5, 67).getTime();
  assert.equal(formatLine('info', 'deckBr', 'hello', ts), '03:04:05.067 INFO  [deckBr] hello');
  assert.equal(formatLine('error', 'hid', 'boom', ts), '03:04:05.067 ERROR [hid] boom');
});

// write + flush

console.log('\nwrite and flush');

await test('an info line is buffered until flush, then on disk', async () => {
  const dir = `${ROOT}/buffered`;
  const sink = new LogFileSink(dir);
  sink.write('info', 'deckBr', 'first', Date.now());
  assert.ok(!(await exists(logFilePath(dir))), 'nothing written before the flush');
  await sink.flush();
  assert.ok((await readText(logFilePath(dir))).includes('[deckBr] first'));
  await sink.close();
});

await test('warn/error force an immediate flush', async () => {
  const dir = `${ROOT}/immediate`;
  const sink = new LogFileSink(dir);
  sink.write('info', 'deckBr', 'buffered', Date.now());
  sink.write('error', 'hid', 'the last line before the stall', Date.now());
  // No explicit flush(): the error path must have scheduled the drain itself.
  await new Promise((r) => setTimeout(r, 50));
  const text = await readText(logFilePath(dir));
  assert.ok(text.includes('the last line before the stall'), 'error line reached disk');
  assert.ok(text.includes('buffered'), 'earlier buffered lines are drained with it');
  await sink.close();
});

await test('the first line after opening carries an ISO date header', async () => {
  const dir = `${ROOT}/header`;
  const sink = new LogFileSink(dir);
  sink.write('info', 'deckBr', 'hello', Date.now());
  await sink.flush();
  const [firstLine] = (await readText(logFilePath(dir))).split('\n');
  assert.ok(/^──── \d{4}-\d{2}-\d{2}T/.test(firstLine ?? ''), `unexpected header: ${firstLine}`);
  await sink.close();
});

await test('ordering is preserved across several flushes', async () => {
  const dir = `${ROOT}/ordering`;
  const sink = new LogFileSink(dir);
  for (let i = 0; i < 5; i++) {
    sink.write('info', 'deckBr', `line-${i}`, Date.now());
    void sink.flush();
  }
  await sink.flush();
  const text = await readText(logFilePath(dir));
  const indices = [0, 1, 2, 3, 4].map((i) => text.indexOf(`line-${i}`));
  assert.ok(
    indices.every((v, i) => v >= 0 && (i === 0 || v > indices[i - 1]!)),
    `lines out of order: ${indices.join(',')}`,
  );
  await sink.close();
});

// rotation

console.log('\nrotation');

await test('rotates at the size threshold and keeps LOG_FILES_KEPT files', async () => {
  const dir = `${ROOT}/rotate`;
  const sink = new LogFileSink(dir);
  const perRotation = Math.ceil(LOG_ROTATE_BYTES / BIG.length) + 1;
  // Enough rotations to push past the retention limit.
  for (let r = 0; r < LOG_FILES_KEPT + 2; r++) {
    for (let i = 0; i < perRotation; i++) {
      sink.write('info', 'bulk', BIG, Date.now());
      await sink.flush();
    }
  }
  await sink.close();

  assert.ok(await exists(`${dir}/logs/deckbridge.log`), 'active file exists');
  for (let n = 1; n < LOG_FILES_KEPT; n++) {
    assert.ok(await exists(`${dir}/logs/deckbridge.${n}.log`), `rotated file ${n} kept`);
  }
  assert.ok(
    !(await exists(`${dir}/logs/deckbridge.${LOG_FILES_KEPT}.log`)),
    'retention drops the oldest file',
  );
});

await test('the active file is below the rotation threshold after a rotation', async () => {
  const dir = `${ROOT}/rotate-size`;
  const sink = new LogFileSink(dir);
  const perRotation = Math.ceil(LOG_ROTATE_BYTES / BIG.length) + 1;
  for (let i = 0; i < perRotation; i++) {
    sink.write('info', 'bulk', BIG, Date.now());
    await sink.flush();
  }
  await sink.close();
  const st = await tjs.stat(logFilePath(dir));
  assert.ok(st.size < LOG_ROTATE_BYTES, `active file is ${st.size}B after rotation`);
});

// failure handling

console.log('\nfailure handling');

await test('an unwritable path disables the sink instead of throwing', async () => {
  // A regular file where the logs DIRECTORY should be: makeDir fails, so does open.
  const dir = `${ROOT}/broken`;
  await tjs.makeDir(dir, { recursive: true });
  await tjs.writeFile(logDir(dir), 'not a directory');
  const sink = new LogFileSink(dir);
  sink.write('info', 'deckBr', 'never lands', Date.now());
  await sink.flush();
  assert.ok(sink.isDisabled, 'sink disabled itself after the write failure');
  // Subsequent writes are silently dropped, and still must not throw.
  sink.write('error', 'deckBr', 'also dropped', Date.now());
  await sink.flush();
  // write()/flush() never throw, but the final close tells the coordinator.
  await assertRejects(() => sink.close());
});

// failure handling

console.log('\nwrite failures');

function fakeHandle(over: Partial<FileHandleLike> = {}): { h: FileHandleLike; log: string[] } {
  const log: string[] = [];
  const h: FileHandleLike = {
    write: (d) => {
      log.push(new TextDecoder().decode(d));
      return Promise.resolve();
    },
    close: () => {
      log.push('<close>');
      return Promise.resolve();
    },
    ...over,
  };
  return { h, log };
}

await test('short writes are continued until every byte lands', async () => {
  const chunks: string[] = [];
  const { h } = fakeHandle({
    write: (d) => {
      const n = Math.min(5, d.length);
      chunks.push(new TextDecoder().decode(d.subarray(0, n)));
      return Promise.resolve(n);
    },
  });
  const sink = new LogFileSink(`${ROOT}/short`, () => Promise.resolve(h));
  sink.write('error', 'c', 'hello world', 0);
  await sink.flush();
  assert.ok(chunks.length > 1);
  assert.ok(chunks.join('').endsWith('[c] hello world\n'));
  assert.equal(sink.isDisabled, false);
  await sink.close();
});

await test('a zero-progress write disables the sink and close() reports it', async () => {
  const { h, log } = fakeHandle({ write: () => Promise.resolve(0) });
  const sink = new LogFileSink(`${ROOT}/zero`, () => Promise.resolve(h));
  sink.write('error', 'c', 'x', 0);
  await sink.flush();
  assert.equal(sink.isDisabled, true);
  assert.deepEqual(log, ['<close>']);
  await assertRejects(() => sink.close());
});

await test('a failing write closes the handle exactly once', async () => {
  const { h, log } = fakeHandle({ write: () => Promise.reject(new Error('ENOSPC')) });
  const sink = new LogFileSink(`${ROOT}/enospc`, () => Promise.resolve(h));
  sink.write('error', 'c', 'x', 0);
  await sink.flush();
  await assertRejects(() => sink.close());
  assert.equal(log.filter((l) => l === '<close>').length, 1);
});

await test('a handle that will not close makes close() reject', async () => {
  const { h } = fakeHandle({ close: () => Promise.reject(new Error('EIO')) });
  const sink = new LogFileSink(`${ROOT}/closefail`, () => Promise.resolve(h));
  sink.write('info', 'c', 'x', 0);
  await assertRejects(() => sink.close());
});

await test('pending lines are capped; one marker reports the drops', async () => {
  const { h, log } = fakeHandle();
  const sink = new LogFileSink(`${ROOT}/cap`, () => Promise.resolve(h));
  const n = Math.ceil(LOG_PENDING_MAX_BYTES / BIG.length) + 5;
  for (let i = 0; i < n; i++) sink.write('info', 'c', `${i}${BIG}`, 0);
  await sink.flush();
  const text = log.join('');
  assert.equal(text.split('lines dropped').length, 2);
  assert.ok(!text.includes(`] 0${BIG}`), 'oldest dropped');
  assert.ok(text.includes(`] ${n - 1}${BIG}`), 'newest kept');
  await sink.close();
});

await test('flush requests behind a running drain coalesce into one', async () => {
  let release: () => void = () => {};
  let writes = 0;
  let entered: () => void = () => {};
  const firstWrite = new Promise<void>((r) => (entered = r));
  const { h } = fakeHandle({
    write: () => {
      writes++;
      if (writes > 1) return Promise.resolve();
      entered();
      return new Promise<void>((r) => (release = r));
    },
  });
  const sink = new LogFileSink(`${ROOT}/coalesce`, () => Promise.resolve(h));
  sink.write('error', 'c', 'a', 0); // starts drain 1, blocked in write
  await firstWrite;
  sink.write('error', 'c', 'b', 0);
  sink.write('error', 'c', 'c', 0);
  sink.write('error', 'c', 'd', 0);
  release();
  await sink.flush();
  assert.equal(writes, 2, 'b, c, d went out in a single follow-up write');
  await sink.close();
});

// tail

console.log('\ntailLogFile');

await test('returns only the last N lines', async () => {
  const dir = `${ROOT}/tail`;
  const sink = new LogFileSink(dir);
  for (let i = 0; i < 50; i++) sink.write('info', 'deckBr', `entry-${i}`, Date.now());
  await sink.flush();
  await sink.close();
  const tail = await tailLogFile(10, dir);
  const lines = tail.split('\n').filter((l) => l.length > 0);
  assert.ok(lines.length <= 10, `expected ≤10 lines, got ${lines.length}`);
  assert.ok(tail.includes('entry-49'), 'keeps the newest line');
  assert.ok(!tail.includes('entry-0 '), 'drops the oldest lines');
});

await test('missing log file tails to an empty string', async () => {
  assert.equal(await tailLogFile(10, `${ROOT}/no-such-dir`), '');
});

await test('reads only the trailing byte window, dropping the cut first line', async () => {
  const dir = `${ROOT}/tail-big`;
  const sink = new LogFileSink(dir);
  for (let i = 0; i < 400; i++) sink.write('info', 'deckBr', `big-${i}`, Date.now());
  await sink.flush();
  await sink.close();
  const tail = await tailLogFile(Number.MAX_SAFE_INTEGER, dir, 1024);
  assert.ok(tail.length <= 1024, `window bounded, got ${tail.length}`);
  assert.ok(tail.includes('big-399'), 'keeps the newest line');
  assert.ok(!tail.includes('big-0 ') && !tail.includes('big-1 '), 'oldest lines never read');
});

// Cleanup + summary

try {
  await tjs.remove(ROOT, { recursive: true });
} catch {}

summary();
