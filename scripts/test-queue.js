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

test('remove protects active work and removes pending work', async () => {
  const q = createQueue();
  const [active, pending] = q.enqueue([makeFile('a.mp3'), makeFile('b.wav')]);
  await q.processAll(async () => {
    q.remove(active.id);
    assert(q.getItems().length === 2, 'active item must remain');
    q.remove(pending.id);
    assert(q.getItems().length === 1, 'pending item must be removed');
    return 'ok';
  });
});

test('remove handles unknown id gracefully', () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3')]);
  q.remove(999);
  assert(q.getItems().length === 1, 'unknown id should not crash');
});

// --- Clear tests ---

console.log('\nClear tests\n');

test('clearAll removes retained errors and results when idle', async () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3'), makeFile('b.wav')]);
  await q.processAll(async (item) => {
    if (item.fileName === 'b.wav') throw new Error('failed');
    return 'ok';
  });
  q.enqueue([makeFile('c.mp3')]);
  assert(q.getItems().length === 3, 'retain all statuses');
  q.clearAll();
  assert(q.getItems().length === 0, 'clearAll removes everything');
});

test('clearAll leaves no active item', () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3')]);
  q.clearAll();
  assert(q.getActiveItem() === null, 'active marker is empty');
});

// --- getSummary tests ---

console.log('\ngetSummary tests\n');

test('getSummary returns correct counts', async () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3'), makeFile('b.wav')]);
  await q.processAll(async () => 'ok');
  q.enqueue([makeFile('c.mp3')]);
  const s = q.getSummary();
  assert(s.done === 2 && s.total === 3 && s.pending === 1, 'counts follow real transitions');
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

  // Cancellation during the active call records an error and stops the batch.
  assert(callCount === 1, `expected 1 call before abort, got ${callCount}`);
  assert(results.length === 1, `expected 1 result, got ${results.length}`);

  // Remaining items should still be pending
  const items = q.getItems();
  assert(items[0].status === 'error', 'cancelled active item should be an error');
  assert(items[0].error === 'Cancelled', 'cancelled active item should retain its reason');
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
  await q.processAll(async () => 'done');

  const results = await q.processAll(async (i) => i.fileName);
  assert(results.length === 0, 'no pending items to process');
});

test('processAll only processes pending items', async () => {
  const q = createQueue();
  q.enqueue([makeFile('b.wav')]);
  await q.processAll(async () => 'done');
  q.enqueue([makeFile('a.mp3')]);

  const called = [];
  await q.processAll(async (i) => { called.push(i.fileName); return i.fileName; });
  assert(called.length === 1, `expected 1 call, got ${called.length}`);
  assert(called[0] === 'a.mp3', 'only pending item should be processed');
});

test('removed captured IDs never start and new files wait for the next run', async () => {
  const q = createQueue();
  const [first, removed] = q.enqueue([makeFile('a.mp3'), makeFile('b.wav')]);
  const called = [];
  const results = await q.processAll(async (item) => {
    called.push(item.fileName);
    q.remove(first.id); // The active item cannot be removed.
    q.remove(removed.id);
    q.enqueue([makeFile('next.mp3')]);
    return item.fileName;
  });
  assert(called.join() === 'a.mp3', 'removed and newly added files must not run');
  assert(results.length === 1 && q.getSnapshot().length === 2, 'retain active result and new pending work');
  const next = await q.processAll(async (item) => item.fileName);
  assert(next.length === 1 && next[0].item.fileName === 'next.mp3', 'only next-run results should be returned');
  assert(q.getSnapshot().filter((i) => i.status === 'done').length === 2, 'retain both batches');
});

test('clearPending removes captured work and preserves errors and completed results', async () => {
  const q = createQueue();
  q.enqueue([makeFile('failed.mp3')]);
  await q.processAll(async () => { throw new Error('failed'); });
  q.enqueue([makeFile('a.mp3'), makeFile('b.wav')]);
  const result = await q.processAll(async () => {
    q.clearPending();
    return 'done';
  });
  assert(result.length === 1, 'cleared work must not start');
  assert(q.getSnapshot().map((i) => i.status).join() === 'error,done', 'errors and active work must be retained');
  q.clearAll();
  assert(q.getSnapshot().length === 0, 'idle clearAll must remove all statuses');
});

test('run guard covers callbacks, active work and the final transition', async () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3')]);
  const attempts = [];
  const checkGuard = () => {
    assert(q.isRunning(), 'run flag must cover the whole batch');
    attempts.push(q.processAll(async () => 'overlap').then(
      () => { throw new Error('overlapping run was allowed'); },
      (err) => assert(err.message.includes('already running'), 'overlap should reject clearly'),
    ));
    let rejected = false;
    try { q.clearAll(); } catch (err) { rejected = /running/.test(err.message); }
    assert(rejected, 'clearAll must reject throughout a run');
  };
  await q.processAll(async () => { checkGuard(); return 'ok'; }, { onChange: checkGuard });
  await Promise.all(attempts);
  assert(attempts.length === 3, 'check start, active call and completion');
  assert(!q.isRunning(), 'run flag must reset after completion');
});

test('snapshot reads cannot change queue entries or nested result values', async () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3')]);
  const result = { text: 'hello', transcript: { blocks: [{ text: 'hello' }] } };
  await q.processAll(async () => result);
  const view = q.getSnapshot();
  assert(Object.isFrozen(view) && Object.isFrozen(view[0]), 'array and entries must be frozen');
  assert(Object.isFrozen(view[0].result.transcript.blocks[0]), 'nested result must be frozen');
  try { view.push({}); } catch {}
  try { view[0].status = 'pending'; } catch {}
  try { view[0].result.transcript.blocks[0].text = 'changed'; } catch {}
  assert(q.getSnapshot().length === 1 && q.getSnapshot()[0].status === 'done', 'entry mutation must not change state');
  assert(q.getSnapshot()[0].result.transcript.blocks[0].text === 'hello', 'nested mutation must not change result');
  assert(!Object.isFrozen(result), 'taking a snapshot must not freeze the caller result');
  q.clearAll();
  assert(view.length === 1, 'older snapshots must stay stable after queue changes');
});

test('all public reads and callback inputs are detached and frozen', async () => {
  const q = createQueue();
  const added = q.enqueue([makeFile('a.mp3')]);
  assert(Object.isFrozen(added[0]), 'enqueue cannot expose mutable state');
  const result = await q.processAll(async (item) => {
    assert(Object.isFrozen(item) && Object.isFrozen(q.getActiveItem()), 'worker reads are frozen');
    try { item.status = 'pending'; } catch {}
    return { text: 'ok' };
  }, { onChange: (item) => assert(Object.isFrozen(item), 'notifications are frozen') });
  assert(Object.isFrozen(q.getItems()[0]) && Object.isFrozen(result[0].item), 'legacy reads and results are frozen');
  assert(q.getItems()[0].status === 'done', 'attempted mutation cannot alter transitions');
});

test('options can still be read when each item starts', async () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3'), makeFile('b.wav')]);
  let option = 'first';
  const options = [];
  await q.processAll(async () => {
    options.push(option);
    option = 'second';
    return 'ok';
  });
  assert(options.join() === 'first,second', 'options must not be captured when a batch starts');
});

test('a failed lifecycle callback still releases the run guard', async () => {
  const q = createQueue();
  q.enqueue([makeFile('a.mp3')]);
  try {
    await q.processAll(async () => 'ok', { onChange: () => { throw new Error('callback failed'); } });
  } catch (err) {
    assert(err.message === 'callback failed', 'callback failure should reach caller');
  }
  assert(!q.isRunning() && q.getActiveItem() === null, 'guard and active marker must always reset');
  assert(q.getSnapshot()[0].status === 'error', 'callback failure must not strand an item as processing');
});

// ---------------------------------------------------------------------------

runAll();
