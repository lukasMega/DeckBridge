import assert from 'tjs:assert';
import {
  buildFixtureSkeleton,
  bytesOfHex,
  hexOf,
  serializeFixture,
  validateFixtureShape,
  type PacketFixture,
} from '../src/dev/packet-fixture.js';
import { PROTOCOLS } from '../src/devices/protocol-metadata.js';
import { findModelById } from '../src/devices/registry.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';
import {
  checkFixtureIdentity,
  firstDiff,
  loadFixtures,
  replayFixture,
  type LoadedFixture,
} from './helpers/packet-replay.js';

// Replays every ts/test/fixtures/packets/<model>/<case>.json through the real driver
// code on a faked hidapi symbol table (no hardware). All seed fixtures are synthetic;
// `mise run device-capture` adds captured ones next to them.

const fixtures = await loadFixtures();

function clone(f: LoadedFixture): LoadedFixture {
  return { ...f, fixture: JSON.parse(JSON.stringify(f.fixture)) as LoadedFixture['fixture'] };
}

async function replayMessage(f: LoadedFixture): Promise<string> {
  try {
    await replayFixture(f);
  } catch (e) {
    return (e as Error).message;
  }
  return '';
}

function find(model: string, name: string): LoadedFixture {
  const hit = fixtures.find((f) => f.file.endsWith(`/${model}/${name}.json`));
  assert.ok(hit, `fixture ${model}/${name} missing`);
  return hit!;
}

console.log('\npacket-replay: fixture files');

await test('fixtures exist and are well formed, bound to a registry model and PID', () => {
  assert.ok(fixtures.length >= 20, `only ${fixtures.length} fixtures`);
  const errors = fixtures.flatMap(checkFixtureIdentity);
  assert.deepEqual(errors, []);
});

// A capture must name its own file, so a synthetic fixture cannot pose as one.
await test('every fixture is synthetic or a capture of its own file', () => {
  assert.deepEqual(
    fixtures
      .filter((f) => f.fixture.source !== 'synthetic' && f.fixture.source !== `capture:${f.file}`)
      .map((f) => f.file),
    [],
  );
});

await test('four families are covered, each with init-or-image and a no-event input case', () => {
  const byFamily = new Map<string, LoadedFixture[]>();
  for (const f of fixtures) {
    const family = PROTOCOLS[findModelById(f.fixture.model)!.protocol].family;
    byFamily.set(family, [...(byFamily.get(family) ?? []), f]);
  }
  assert.deepEqual(
    [...byFamily.keys()].toSorted((a, b) => a.localeCompare(b)),
    ['ajazz-akp05', 'elgato', 'mirabox-v1', 'mirabox-v3'],
  );
  for (const [family, list] of byFamily) {
    const hasOutput = list.some((f) =>
      f.fixture.steps.some((s) => s.op === 'write' || s.op === 'feature'),
    );
    const hasSilentInput = list.some((f) => {
      const reads = f.fixture.steps.flatMap((s) => (s.op === 'read' ? [s.expect.length] : []));
      return reads.length > 0 && reads.every((n) => n === 0);
    });
    assert.ok(hasOutput, `${family}: no output fixture`);
    assert.ok(hasSilentInput, `${family}: no fixture asserting that input emits nothing`);
  }
});

console.log('\npacket-replay: replay');

for (const f of fixtures) {
  await test(f.file.replace('test/fixtures/packets/', ''), () => replayFixture(f));
}

console.log('\npacket-replay: failure reporting');

await test('a corrupted byte reports file, step and first differing offset', async () => {
  const f = clone(find('mirabox-293', 'image-partial-chunk'));
  // Step 2 is the first image chunk; flip byte 40 of the report (hex chars 80..81).
  const step = f.fixture.steps[2]!;
  assert.equal(step.op, 'write');
  if (step.op !== 'write') return;
  const flipped = step.hex.slice(80, 82) === 'ff' ? '00' : 'ff';
  step.hex = step.hex.slice(0, 80) + flipped + step.hex.slice(82);
  const message = await replayMessage(f);
  assert.ok(message.includes(f.file), message);
  assert.ok(message.includes('step 2'), message);
  assert.ok(message.includes('byte offset 40'), message);
});

await test('a short expected packet reports the offset where the data ends', async () => {
  const f = clone(find('mk2', 'brightness-min-max'));
  const step = f.fixture.steps[3]!;
  if (step.op !== 'feature') throw new Error('unexpected fixture shape');
  step.hex = step.hex.slice(0, 20);
  const message = await replayMessage(f);
  assert.ok(message.includes('byte offset 10'), message);
  assert.ok(message.includes('end of data'), message);
});

await test('an unexpected extra write fails with the step index', async () => {
  const f = clone(find('ajazz-akp05e', 'init'));
  f.fixture.steps.pop();
  const message = await replayMessage(f);
  assert.ok(message.includes('unexpected extra write'), message);
});

await test('a wrong expected event list fails and names the step', async () => {
  const f = clone(find('mirabox-293', 'input-press-release'));
  const step = f.fixture.steps[0]!;
  if (step.op !== 'read') throw new Error('unexpected fixture shape');
  step.expect = [];
  const message = await replayMessage(f);
  assert.ok(message.includes('step 0') && message.includes('events differ'), message);
});

await test('firstDiff: identical, differing and length-only cases', () => {
  assert.equal(firstDiff(new Uint8Array([1, 2]), new Uint8Array([1, 2])), -1);
  assert.equal(firstDiff(new Uint8Array([1, 2]), new Uint8Array([1, 3])), 1);
  assert.equal(firstDiff(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), 2);
});

console.log('\npacket-replay: capture skeleton');

await test('a capture skeleton round-trips, validates and replays as an empty fixture', async () => {
  const model = findModelById('ajazz-akp05e')!;
  const skeleton = buildFixtureSkeleton(
    model,
    0x3004,
    { usagePage: 0xffa0, usage: 1 },
    'capture:test/fixtures/packets/ajazz-akp05e/captured-0x3004.json',
  );
  const text = serializeFixture(skeleton);
  const parsed = JSON.parse(text) as PacketFixture;
  assert.deepEqual(parsed, skeleton);
  assert.deepEqual(validateFixtureShape(parsed, text.length), []);
  assert.deepEqual(
    checkFixtureIdentity({
      file: 'test/fixtures/packets/ajazz-akp05e/x.json',
      fixture: parsed,
      size: text.length,
    }),
    [],
  );
  await replayFixture({ file: 'skeleton', fixture: parsed, size: text.length });
  assert.equal(hexOf(bytesOfHex('00ff10')), '00ff10');
});

await test('shape validation rejects uppercase hex, odd length and a bad source', () => {
  const bad = {
    ...buildFixtureSkeleton(findModelById('mk2')!, 0x0080, null, 'hand-written'),
    steps: [
      { op: 'write', dir: 'out', hex: 'AB' },
      { op: 'write', dir: 'out', hex: 'abc' },
    ],
  } as PacketFixture;
  const errors = validateFixtureShape(bad, 10);
  assert.equal(errors.length, 3, errors.join('\n'));
});

summaryExit();
