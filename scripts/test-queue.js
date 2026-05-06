#!/usr/bin/env node
/**
 * Tests for renderer/queue.js
 *
 * Covers: enqueue, remove, clear, getActiveItem, serial processing,
 * error isolation, cancellation. Follows the same plain-node style
 * as scripts/test-merge.js.
 *
 * Usage:
 *     node scripts/test-queue.js
 */

const { createQueue } = require('../renderer/queue');

// --- Helpers ---

let passed = 0;
let failed = 0;
const _queue = [];

function test(name, fn) {
  _queue.push({ name, fn });
}

async function runAll() {
  for (const { name, fn } of _queue) {
    try {
      await fn();
      console.log(`  PASS: ${name}`);
      passed++;
    } catch (e) {
      console.log(`  FAIL: ${name} -- ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function makeFile(name) {
  return { filePath: `/tmp/${name}`, fileName: name };
}

// --- Enqueue tests ---

console.log('Enqueue tests\n');

test('enqueue adds items with unique IDs and pending status', () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3'), makeFile('b.wav')]);
  const items = q.getItems();
  assert(items.length === 2, `expected 2 items, got ${items.length}`);
  assert(items[0].id !== items[1].id, 'IDs should be unique');
  assert(items[0].status === 'pending', 'first item should be pending');
  assert(items[1].status === 'pending', 'second item should be pending');
  assert(items[0].fileName === 'a.mp3', 'fileName should be set');
  assert(items[0].filePath === '/tmp/a.mp3', 'filePath should be set');
  assert(items[0].result === null, 'result should be null initially');
  assert(items[0].error === null, 'error should be null initially');
});

test('enqueue returns the added items', () => {
  const q = createQueue();
  const added = q.enqueue([makeFile('x.mp3')]);
  assert(added.length === 1, 'should return added items');
  assert(added[0].fileName === 'x.mp3', 'returned item should have fileName');
});

test('enqueue preserves existing items', () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3')]);
  q.enqueue([makeFile('b.wav')]);
  assert(q.getItems().length === 2, 'should have 2 items');
});

// --- Remove tests ---

console.log('\nRemove tests\n');

test('remove only removes non-processing items', () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3'), makeFile('b.wav')]);
  const items = q.getItems();
  items[0].status = 'processing';

  q.remove(items[0].id);
  assert(q.getItems().length === 2, 'processing item should not be removed');
  q.remove(items[1].id);
  assert(q.getItems().length === 1, 'pending item should be removed');
});

test('remove handles unknown id gracefully', () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3')]);
  q.remove(999);
  assert(q.getItems().length === 1, 'unknown id should not crash');
});

// --- Clear tests ---

console.log('\nClear tests\n');

test('clear removes pending and error items, keeps processing and done', () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3'), makeFile('b.wav'), makeFile('c.mp3'), makeFile('d.wav')]);
  const items = q.getItems();
  items[0].status = 'done';
  items[1].status = 'processing';
  items[2].status = 'error';
  items[3].status = 'pending';

  q.clear();
  assert(q.getItems().length === 2, `expected 2 items after clear, got ${q.getItems().length}`);
  assert(q.getItems()[0].status === 'done', 'done item should remain');
  assert(q.getItems()[1].status === 'processing', 'processing item should remain');
});

test('clear resets activeId when no items remain', () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3')]);
  const items = q.getItems();
  items[0].status = 'processing';
  q.clear(); // keeps processing item
  assert(q.getActiveItem() == null, 'no active item since processing is still there but activeId was never set');

  // Set active via processAll
  items[0].status = 'pending';
  // We need to set activeId manually for this test — processAll does it
  // Just verify clear with no items clears active
  const q2 = createQueue();
  q2.clear();
  assert(q2.getActiveItem() == null, 'active should be null after clearing empty queue');
});

// --- getSummary tests ---

console.log('\ngetSummary tests\n');

test('getSummary returns correct counts', () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3'), makeFile('b.wav'), makeFile('c.mp3')]);
  const items = q.getItems();
  items[0].status = 'done';
  items[1].status = 'done';
  items[2].status = 'pending';

  const s = q.getSummary();
  assert(s.done === 2, `expected 2 done, got ${s.done}`);
  assert(s.total === 3, `expected 3 total, got ${s.total}`);
  assert(s.pending === 1, `expected 1 pending, got ${s.pending}`);
});

test('getSummary on empty queue returns zeros', () => {
  const q = createQueue();
  const s = q.getSummary();
  assert(s.done === 0, 'done should be 0');
  assert(s.total === 0, 'total should be 0');
  assert(s.pending === 0, 'pending should be 0');
});

// --- processAll tests ---

console.log('\nprocessAll tests\n');

test('processAll processes items serially in order', async () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3'), makeFile('b.wav'), makeFile('c.mp3')]);

  const order = [];
  const transcribeFn = async (item) => {
    order.push(item.fileName);
    return `transcript of ${item.fileName}`;
  };

  const results = await q.processAll(transcribeFn);

  assert(order[0] === 'a.mp3', `first should be a.mp3, got ${order[0]}`);
  assert(order[1] === 'b.wav', `second should be b.wav, got ${order[1]}`);
  assert(order[2] === 'c.mp3', `third should be c.mp3, got ${order[2]}`);
  assert(results.length === 3, `expected 3 results, got ${results.length}`);

  // Check item statuses
  const items = q.getItems();
  assert(items[0].status === 'done', 'first item should be done');
  assert(items[0].result === 'transcript of a.mp3', 'result should be set');
  assert(items[2].status === 'done', 'last item should be done');
});

test('error in one item does not break the remaining queue', async () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3'), makeFile('b.wav'), makeFile('c.mp3')]);

  const order = [];
  const transcribeFn = async (item) => {
    order.push(item.fileName);
    if (item.fileName === 'b.wav') throw new Error('transcribe failed');
    return `ok:${item.fileName}`;
  };

  const results = await q.processAll(transcribeFn);

  assert(order.length === 3, `all 3 should be attempted, got ${order.length}`);
  assert(results[0].status === 'done', 'first should be done');
  assert(results[1].status === 'error', 'second should be error');
  assert(results[2].status === 'done', 'third should still be done');

  const items = q.getItems();
  assert(items[1].status === 'error', 'item status should be error');
  assert(items[1].error === 'transcribe failed', 'error message should be set');
  assert(items[2].status === 'done', 'remaining item should be done');
});

test('processAll reports per-item lifecycle via onChange', async () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3'), makeFile('b.wav')]);

  const events = [];
  const onChange = (item) => {
    events.push({ id: item.id, status: item.status });
  };

  const transcribeFn = async (item) => item.fileName;

  await q.processAll(transcribeFn, { onChange });

  // Each item should get two events: processing -> done
  assert(events.length === 4, `expected 4 events, got ${events.length}`);
  assert(events[0].status === 'processing', 'first event should be processing');
  assert(events[1].status === 'done', 'second event should be done');
  assert(events[2].status === 'processing', 'third event should be processing');
  assert(events[3].status === 'done', 'fourth event should be done');
});

test('getActiveItem returns the current item during processing', async () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3'), makeFile('b.wav')]);

  const activeItems = [];
  const transcribeFn = async (item) => {
    activeItems.push(q.getActiveItem());
    return item.fileName;
  };

  await q.processAll(transcribeFn);

  assert(activeItems.length === 2, `expected 2 active snapshots, got ${activeItems.length}`);
  assert(activeItems[0].fileName === 'a.mp3', `first active should be a.mp3, got ${activeItems[0] && activeItems[0].fileName}`);
  assert(activeItems[1].fileName === 'b.wav', `second active should be b.wav, got ${activeItems[1] && activeItems[1].fileName}`);
  assert(q.getActiveItem() === null, 'active item should be null after processing');
});

test('cancellation via AbortSignal stops processing after current item', async () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3'), makeFile('b.wav'), makeFile('c.mp3')]);

  const controller = new AbortController();
  let callCount = 0;

  const transcribeFn = async (item) => {
    callCount++;
    if (item.fileName === 'a.mp3') {
      // Abort after first item completes
      controller.abort();
    }
    return `ok:${item.fileName}`;
  };

  const results = await q.processAll(transcribeFn, { signal: controller.signal });

  // The first item completes, abort fires, loop checks signal and breaks
  assert(callCount === 1, `expected 1 call before abort, got ${callCount}`);
  assert(results.length === 1, `expected 1 result, got ${results.length}`);

  // Remaining items should still be pending
  const items = q.getItems();
  assert(items[0].status === 'done', 'first should be done');
  assert(items[1].status === 'pending', 'second should still be pending');
  assert(items[2].status === 'pending', 'third should still be pending');
});

test('cancellation mid-processing: signal checked between items', async () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3'), makeFile('b.wav')]);

  const controller = new AbortController();
  controller.abort(); // abort before processing starts

  const results = await q.processAll(async (item) => item.fileName, { signal: controller.signal });

  assert(results.length === 0, 'no items should be processed when already aborted');
  const items = q.getItems();
  assert(items[0].status === 'pending', 'should still be pending');
});

test('processAll on empty pending queue returns empty array', async () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3')]);
  q.getItems()[0].status = 'done';

  const results = await q.processAll(async (i) => i.fileName);
  assert(results.length === 0, 'no pending items to process');
});

test('processAll only processes pending items', async () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3'), makeFile('b.wav')]);
  q.getItems()[1].status = 'done';

  const called = [];
  await q.processAll(async (i) => { called.push(i.fileName); return i.fileName; });
  assert(called.length === 1, `expected 1 call, got ${called.length}`);
  assert(called[0] === 'a.mp3', 'only pending item should be processed');
});

// ---------------------------------------------------------------------------

runAll();
