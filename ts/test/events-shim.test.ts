import assert from 'tjs:assert';
import { EventEmitter } from 'node:events';
import { test, summary } from './helpers/harness.js';

// The shim replaced eventemitter3; these pin the behavior the call sites rely on.

const noop = (): void => {};

test('listeners run in registration order with the emitted arguments', () => {
  const ee = new EventEmitter();
  const seen: unknown[][] = [];
  ee.on('x', (...a: unknown[]) => seen.push(['first', ...a]));
  ee.on('x', (...a: unknown[]) => seen.push(['second', ...a]));
  ee.emit('x', 1, undefined, 'z');
  assert.deepEqual(seen, [
    ['first', 1, undefined, 'z'],
    ['second', 1, undefined, 'z'],
  ]);
});

test('emit reports whether anything listened; unknown and error events never throw', () => {
  const ee = new EventEmitter();
  assert.equal(ee.emit('nobody'), false);
  assert.equal(ee.emit('error', new Error('unhandled')), false);
  ee.on('x', () => {});
  assert.equal(ee.emit('x'), true);
  ee.removeAllListeners('x');
  assert.equal(ee.emit('x'), false);
});

test('listeners run with the emitter as this', () => {
  const ee = new EventEmitter();
  let sawEmitter = false;
  ee.on('x', function (this: unknown) {
    sawEmitter = this === ee;
  });
  ee.emit('x');
  assert.ok(sawEmitter);
});

test('on, once, off and removeAllListeners return the emitter', () => {
  const ee = new EventEmitter();
  assert.equal(ee.on('x', noop), ee);
  assert.equal(ee.once('x', noop), ee);
  assert.equal(ee.off('x', noop), ee);
  assert.equal(ee.removeAllListeners(), ee);
});

test('once fires one time and is gone before its own call', () => {
  const ee = new EventEmitter();
  let calls = 0;
  ee.once('x', () => {
    calls++;
    assert.equal(ee.listenerCount('x'), 0);
    ee.emit('x');
  });
  ee.emit('x');
  ee.emit('x');
  assert.equal(calls, 1);
});

test('off removes a once listener by its original function', () => {
  const ee = new EventEmitter();
  let calls = 0;
  const f = (): void => {
    calls++;
  };
  ee.once('x', f);
  ee.off('x', f);
  ee.emit('x');
  assert.equal(calls, 0);
});

test('off with a function drops every registration of it, without one drops the event', () => {
  const ee = new EventEmitter();
  const calls: string[] = [];
  const a = (): number => calls.push('a');
  const b = (): number => calls.push('b');
  ee.on('x', a);
  ee.on('x', b);
  ee.on('x', a);
  ee.off('x', a);
  assert.equal(ee.listenerCount('x'), 1);
  ee.emit('x');
  assert.deepEqual(calls, ['b']);
  ee.on('x', a);
  ee.off('x');
  assert.equal(ee.listenerCount('x'), 0);
  assert.equal(ee.emit('x'), false);
  ee.off('never-registered', a);
});

test('removeAllListeners clears one event or all of them', () => {
  const ee = new EventEmitter();
  ee.on('x', () => {});
  ee.on('y', () => {});
  ee.removeAllListeners('x');
  assert.equal(ee.listenerCount('x'), 0);
  assert.equal(ee.listenerCount('y'), 1);
  ee.on('x', () => {});
  ee.removeAllListeners();
  assert.equal(ee.listenerCount('x') + ee.listenerCount('y'), 0);
});

test('listenerCount counts once and repeated registrations', () => {
  const ee = new EventEmitter();
  assert.equal(ee.listenerCount('x'), 0);
  ee.on('x', noop);
  ee.on('x', noop);
  ee.once('x', noop);
  assert.equal(ee.listenerCount('x'), 3);
});

test('an emit in flight ignores listeners added and removed while it runs', () => {
  const ee = new EventEmitter();
  const calls: string[] = [];
  const late = (): number => calls.push('late');
  const second = (): number => calls.push('second');
  ee.on('x', () => {
    calls.push('first');
    ee.on('x', late);
    ee.off('x', second);
  });
  ee.on('x', second);
  ee.emit('x');
  assert.deepEqual(calls, ['first', 'second']);
  calls.length = 0;
  ee.emit('x');
  assert.deepEqual(calls, ['first', 'late']);
});

test('removeAllListeners during an emit still lets that emit finish', () => {
  const ee = new EventEmitter();
  const calls: string[] = [];
  ee.on('x', () => {
    calls.push('a');
    ee.removeAllListeners();
  });
  ee.on('x', () => calls.push('b'));
  ee.emit('x');
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(ee.emit('x'), false);
});

test('a throwing listener propagates and stops the rest of that emit', () => {
  const ee = new EventEmitter();
  const calls: string[] = [];
  ee.on('x', () => {
    throw new Error('boom');
  });
  ee.on('x', () => calls.push('after'));
  assert.throws(() => ee.emit('x'), /boom/);
  assert.deepEqual(calls, []);
});

test('a throwing once listener is already removed', () => {
  const ee = new EventEmitter();
  ee.once('x', () => {
    throw new Error('boom');
  });
  assert.throws(() => ee.emit('x'), /boom/);
  assert.equal(ee.emit('x'), false);
});

test('symbol and prototype-named events are plain keys', () => {
  const ee = new EventEmitter();
  const sym = Symbol('s');
  const calls: string[] = [];
  ee.on(sym, () => calls.push('sym'));
  ee.on('__proto__', () => calls.push('proto'));
  ee.on('toString', () => calls.push('toString'));
  ee.on('constructor', () => calls.push('constructor'));
  assert.equal(ee.emit(sym), true);
  assert.equal(ee.emit('__proto__'), true);
  assert.equal(ee.emit('toString'), true);
  assert.equal(ee.emit('constructor'), true);
  assert.equal(ee.emit('hasOwnProperty'), false);
  assert.deepEqual(calls, ['sym', 'proto', 'toString', 'constructor']);
});

test('subclasses and Object.assign mixins keep working', () => {
  class Sub extends EventEmitter {
    ping(): boolean {
      return this.emit('ping', 7);
    }
  }
  const sub = new Sub();
  let got = 0;
  sub.on('ping', (n: number) => {
    got = n;
  });
  assert.equal(sub.ping(), true);
  assert.equal(got, 7);
  const mixed = Object.assign(new EventEmitter(), { extra: 1 });
  let hit = false;
  mixed.on('x', () => {
    hit = true;
  });
  mixed.emit('x');
  assert.ok(hit);
});

summary();
