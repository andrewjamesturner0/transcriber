#!/usr/bin/env node
const assert = require('assert/strict');
const { createOperationManager } = require('../lib/operation-manager');

const tests = [];
function test(name, work) { tests.push({ name, work }); }
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('transcription reserves synchronously and releases after settlement', async () => {
  const manager = createOperationManager();
  const gate = deferred();
  let calls = 0;
  const first = manager.run('transcription', () => { calls++; return gate.promise; });
  const second = manager.run('transcription', () => { calls++; });
  await assert.rejects(second, /Already running/);
  assert.equal(calls, 1);
  gate.resolve('done');
  assert.equal(await first, 'done');
  assert.equal(await manager.run('transcription', () => 'next'), 'next');
  await manager.close();
});

test('early cancellation reaches work before its first await', async () => {
  const manager = createOperationManager();
  const operation = manager.run('transcription', (signal) => {
    assert.equal(signal.aborted, true);
    throw new Error('Cancelled');
  });
  assert.equal(manager.cancel(), true);
  assert.equal(manager.cancel('setup'), false);
  await assert.rejects(operation, /Cancelled/);
  assert.equal(manager.cancel(), false);
});

test('setup is exclusive and downloads can opt into exclusivity', async () => {
  const manager = createOperationManager();
  const gate = deferred();
  const setup = manager.run('setup', () => gate.promise);
  await assert.rejects(manager.run('setup', () => {}), /Already running/);
  const download = manager.run('download:model', () => gate.promise, { exclusive: true });
  await assert.rejects(manager.run('download:model', () => {}, { exclusive: false }), /Already running/);
  gate.resolve();
  await Promise.all([setup, download]);
});

test('settling an older concurrent owner cannot clear a newer owner', async () => {
  const manager = createOperationManager();
  const old = deferred();
  const newer = deferred();
  let newSignal;
  const first = manager.run('download', () => old.promise);
  const second = manager.run('download', (signal) => { newSignal = signal; return newer.promise; });
  old.resolve();
  await first;
  assert.equal(manager.cancel('download'), true);
  assert.equal(newSignal.aborted, true);
  await assert.rejects(manager.run('download', () => {}, { exclusive: true }), /Already running/);
  newer.resolve();
  await second;
  assert.equal(manager.cancel('download'), false);
});

test('close stops admission, aborts every kind and awaits cleanup before flush', async () => {
  const manager = createOperationManager();
  const events = [];
  const cleanup = deferred();
  const first = manager.run('transcription', async (signal) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    await cleanup.promise;
    events.push('cleanup');
    throw new Error('Cancelled');
  });
  let setupSignal;
  const setup = manager.run('setup', (signal) => { setupSignal = signal; });
  await Promise.resolve();
  const closing = manager.close({ flush: async () => { events.push('flush'); } });
  assert.equal(manager.isClosing(), true);
  assert.equal(setupSignal.aborted, true);
  assert.strictEqual(manager.close({ flush: () => { throw new Error('second flush'); } }), closing);
  await assert.rejects(manager.run('download', () => {}), /closing/);
  assert.deepEqual(events, []);
  cleanup.resolve();
  assert.deepEqual(await closing, { timedOut: false, pending: [] });
  await assert.rejects(first, /Cancelled/);
  await setup;
  assert.deepEqual(events, ['cleanup', 'flush']);
});

test('a work throw releases its owner and does not reject close', async () => {
  const manager = createOperationManager();
  await assert.rejects(manager.run('setup', () => { throw new Error('failed'); }), /failed/);
  assert.equal(await manager.run('setup', () => 4), 4);
  assert.deepEqual(await manager.close(), { timedOut: false, pending: [] });
});

test('bounded close reports only pending kinds and skips flush after deadline', async () => {
  const manager = createOperationManager({ shutdownTimeoutMs: 15 });
  const gate = deferred();
  let flushed = false;
  const operations = [manager.run('download', () => gate.promise), manager.run('download', () => gate.promise)];
  const before = Date.now();
  const closing = manager.close({ flush: () => { flushed = true; } });
  assert.deepEqual(await closing, { timedOut: true, pending: ['download'] });
  assert(Date.now() - before < 500, 'close exceeded its bounded deadline');
  assert.strictEqual(manager.close(), closing);
  gate.resolve();
  await Promise.all(operations);
  await Promise.resolve();
  assert.equal(flushed, false);
});

test('the same deadline bounds flush, and flush errors remain explicit', async () => {
  const manager = createOperationManager({ shutdownTimeoutMs: 15 });
  const gate = deferred();
  const closing = manager.close({ flush: () => gate.promise });
  assert.deepEqual(await closing, { timedOut: true, pending: [] });
  gate.reject(new Error('late disk error'));
  await new Promise((resolve) => setImmediate(resolve));
  const failing = createOperationManager();
  await assert.rejects(failing.close({ flush: async () => { throw new Error('disk error'); } }), /disk error/);
});

(async () => {
  for (const { name, work } of tests) {
    await work();
    console.log(`PASS ${name}`);
  }
  console.log(`${tests.length} operation manager tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
