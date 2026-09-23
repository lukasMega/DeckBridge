import assert from 'tjs:assert';
import { ActivityBuffers } from '../src/web/server/activity-buffers.js';
import { Broadcaster } from '../src/web/server/broadcaster.js';
import { test, summary } from './helpers/harness.js';

// Simple-only builds (the test suite's default — see build.mjs's isSimpleOnly, which
// stays true for `--test` unless DECKBRIDGE_ADVANCED=1) have no log/comm panel to
// receive commBatch/logBatch, so ActivityBuffers must keep the ring buffers filling
// for diagnostics but skip queuing/broadcasting entirely.

class RecordingBroadcaster extends Broadcaster {
  events: string[] = [];
  override broadcast(event: string, _data: unknown): void {
    this.events.push(event);
  }
}

console.log('\nActivityBuffers simple-only gating');

test('comm() fills the ring buffer but skips the commBatch broadcast', () => {
  const bus = new RecordingBroadcaster();
  const buffers = new ActivityBuffers(bus);
  buffers.comm({
    direction: 'tx',
    protocol: 'elgato',
    component: 'test',
    human: '4B',
    hex: '00000000',
    totalBytes: 4,
  });
  assert.equal(buffers.comms.length, 1, 'ring buffer still fills');
  assert.equal(
    bus.events.includes('commBatch'),
    false,
    'no broadcast queued in simple-only builds',
  );
  buffers.stop();
});

test('log() fills the ring buffer but skips the logBatch broadcast', () => {
  const bus = new RecordingBroadcaster();
  const buffers = new ActivityBuffers(bus);
  buffers.log('info', 'test', 'hello');
  assert.equal(buffers.logs.length, 1, 'ring buffer still fills');
  assert.equal(bus.events.includes('logBatch'), false, 'no broadcast queued in simple-only builds');
  buffers.stop();
});

summary();
