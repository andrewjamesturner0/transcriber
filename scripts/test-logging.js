#!/usr/bin/env node
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLogger } = require('../lib/logging');

const tests = [];
function test(name, work) { tests.push({ name, work }); }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-log-test-'));
let nextId = 0;
function options(extra = {}) {
  return { logFile: path.join(root, String(++nextId), 'app.log'), now: () => new Date('2026-01-01T00:00:00.000Z'), ...extra };
}
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

test('ordered asynchronous writes retain the existing timestamp format', async () => {
  const opts = options();
  const logger = createLogger(opts);
  for (const message of ['first', 'second', 'third']) assert.equal(logger.write(message), true);
  assert.equal(fs.existsSync(opts.logFile), false, 'write must not perform synchronous IO');
  const flushing = logger.flush();
  assert.strictEqual(logger.flush(), flushing);
  await flushing;
  assert.equal(fs.readFileSync(opts.logFile, 'utf8'), ['first', 'second', 'third'].map((text) => `[2026-01-01T00:00:00.000Z] ${text}\n`).join(''));
  const closing = logger.close();
  assert.strictEqual(logger.close(), closing);
  assert.equal(logger.write('too late'), false);
  await closing;
});

test('rotation occurs several times in one session and retains only two bounded files', async () => {
  const opts = options({ maxFileBytes: 80 });
  const logger = createLogger(opts);
  for (let i = 0; i < 8; i++) {
    logger.write(`record ${i}`);
    await logger.flush();
    for (const file of fs.readdirSync(path.dirname(opts.logFile))) {
      assert(fs.statSync(path.join(path.dirname(opts.logFile), file)).size <= 80);
    }
  }
  await logger.close();
  assert.equal(fs.readdirSync(path.dirname(opts.logFile)).length, 2);
  assert.match(fs.readFileSync(opts.logFile + '.old', 'utf8'), /record 4\n.*record 5\n/s);
  assert.match(fs.readFileSync(opts.logFile, 'utf8'), /record 6\n.*record 7\n/s);
});

test('giant records and multibyte diagnostics remain bounded and visibly truncated', async () => {
  const opts = options({ maxFileBytes: 96, maxQueuedBytes: 192 });
  const logger = createLogger(opts);
  logger.write('x'.repeat(1000000));
  await logger.flush();
  logger.write(String.fromCodePoint(0x1f642).repeat(1000));
  await logger.close();
  for (const file of [opts.logFile, opts.logFile + '.old']) {
    const bytes = fs.readFileSync(file);
    assert(bytes.length <= 96);
    assert.match(bytes.toString(), /\[truncated\]\n$/);
    assert(!bytes.toString().includes(String.fromCodePoint(0xfffd)), 'UTF-8 character was split');
  }
});

test('slow disk bounds in-flight plus queued bytes and emits a counted pressure marker', async () => {
  const opts = options({ maxFileBytes: 4096, maxQueuedBytes: 128 });
  const gate = deferred();
  const started = deferred();
  let first = true;
  let active = 0;
  const injected = {
    ...fs.promises,
    appendFile: async (...args) => {
      assert.equal(++active, 1, 'writes overlapped');
      if (first) { first = false; started.resolve(); await gate.promise; }
      await fs.promises.appendFile(...args);
      active--;
    },
  };
  const logger = createLogger({ ...opts, fsPromises: injected });
  assert.equal(logger.write('a'.repeat(80)), true);
  await started.promise;
  for (let i = 0; i < 1000; i++) assert.equal(logger.write('b'.repeat(80)), false);
  const flushing = logger.flush();
  gate.resolve();
  await flushing;
  const contents = fs.readFileSync(opts.logFile, 'utf8');
  assert.match(contents, /Logger dropped 1000 diagnostic records under queue pressure/);
  assert.equal(contents.split('\n').filter(Boolean).length, 2);
  await logger.close();
});

test('initial oversized files are brought within the file bounds', async () => {
  const opts = options({ maxFileBytes: 80 });
  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
  fs.writeFileSync(opts.logFile, 'a'.repeat(400));
  fs.writeFileSync(opts.logFile + '.old', 'b'.repeat(400));
  const logger = createLogger(opts);
  logger.write('new record');
  await logger.close();
  assert(fs.statSync(opts.logFile).size <= 80);
  assert(fs.statSync(opts.logFile + '.old').size <= 80);
});

for (const method of ['mkdir', 'stat', 'appendFile', 'unlink', 'rename', 'truncate']) {
  test(`${method} failure remains best effort and flush settles`, async () => {
    const opts = options({ maxFileBytes: 80 });
    fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
    fs.writeFileSync(opts.logFile, 'a'.repeat(method === 'truncate' ? 90 : 80));
    const errors = [];
    let fail = true;
    const injected = {
      ...fs.promises,
      [method]: async (...args) => {
        if (fail) { fail = false; throw new Error(`injected ${method} error`); }
        return fs.promises[method](...args);
      },
    };
    const logger = createLogger({ ...opts, fs: { promises: injected }, onError: (error) => { errors.push(error); } });
    logger.write('first');
    await logger.flush();
    assert.equal(errors.length, 1);
    logger.write('second');
    await logger.close();
    assert.match(fs.readFileSync(opts.logFile, 'utf8'), /second/);
    assert(fs.statSync(opts.logFile).size <= 80);
  });
}

test('a throwing error callback cannot turn diagnostics into an unhandled rejection', async () => {
  const logger = createLogger(options({ fsPromises: { mkdir: async () => { throw new Error('disk'); } }, onError: () => { throw new Error('callback'); } }));
  logger.write('diagnostic');
  await logger.close();
});

test('writes arriving as a drain settles cannot be stranded behind its promise', async () => {
  for (let hops = 0; hops < 10; hops++) {
    const stored = [];
    const arrived = deferred();
    let lateFlush;
    let logger;
    const injected = {
      mkdir: async () => {},
      stat: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
      appendFile: async (file, bytes) => {
        stored.push(bytes.toString());
        if (stored.length !== 1) return;
        let scheduled = Promise.resolve();
        for (let i = 0; i < hops; i++) scheduled = scheduled.then(() => {});
        scheduled.then(() => {
          logger.write('late');
          lateFlush = logger.flush();
          arrived.resolve();
        });
      },
    };
    logger = createLogger(options({ fsPromises: injected }));
    logger.write('first');
    await logger.flush();
    await arrived.promise;
    await lateFlush;
    assert.equal(stored.length, 2, `late write stranded at microtask offset ${hops}`);
    await logger.close();
  }
});

(async () => {
  try {
    for (const { name, work } of tests) {
      await work();
      console.log(`PASS ${name}`);
    }
    console.log(`${tests.length} logging tests passed`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
