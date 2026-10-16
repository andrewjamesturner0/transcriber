#!/usr/bin/env node
const assert = require('assert');
const { EventEmitter } = require('events');
const { getEventListeners } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { _runProcess, runJsonHelper, terminateProcess, createLineReader, DIAGNOSTIC_BYTES } = require('../lib/_subprocess');
const deps = { spawn, makeEnvWithLibPath: () => process.env, log: () => {} };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function mockProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
  return proc;
}
function mockSpawn(work) {
  return () => {
    const proc = mockProcess();
    process.nextTick(() => work(proc));
    return proc;
  };
}

test('full stdout and split UTF-8 survive bounded stderr', async () => {
  const output = ' '.repeat(80000) + String.fromCodePoint(0x1f642) + '\n';
  const bytes = Buffer.from(output);
  const got = await _runProcess('mock', [], { ...deps, spawn: mockSpawn(proc => {
    for (let i = 0; i < bytes.length; i++) proc.stdout.emit('data', bytes.subarray(i, i + 1));
    proc.stderr.emit('data', Buffer.from('x'.repeat(200000)));
    proc.emit('close', 0);
  }) });
  assert.strictEqual(got, output);
  let seen = '';
  await assert.rejects(_runProcess('mock', [], { ...deps,
    onStderr: chunk => { seen += chunk; },
    spawn: mockSpawn(proc => {
      const diagnostic = Buffer.from(String.fromCodePoint(0x1f642) + '\n');
      for (const byte of diagnostic) proc.stderr.emit('data', Buffer.from([byte]));
      proc.stderr.emit('data', Buffer.from('EARLY' + 'x'.repeat(200000) + 'TAIL'));
      proc.emit('close', 1);
    }),
  }), err => Buffer.byteLength(err.stderrTail) <= DIAGNOSTIC_BYTES && !err.message.includes('EARLY') && err.message.endsWith('TAIL'));
  assert(seen.startsWith(String.fromCodePoint(0x1f642) + '\n'));
});

test('helper errors and final split JSON lines survive later diagnostics', async () => {
  const messages = [];
  await assert.rejects(runJsonHelper('mock', [], { ...deps, onMessage: m => messages.push(m), spawn: mockSpawn(proc => {
    proc.stderr.emit('data', Buffer.from('{"error":"specific '));
    proc.stderr.emit('data', Buffer.from('helper failure","code":"test"}\n'));
    for (let i = 0; i < 100; i++) proc.stderr.emit('data', Buffer.from('later '.repeat(500) + '\n'));
    proc.stderr.emit('data', Buffer.from('{"message":"last progress"}'));
    proc.emit('close', 1);
  }) }), { message: 'specific helper failure' });
  assert.strictEqual(messages.at(-1).message, 'last progress');
});

test('oversized unfinished diagnostics stay bounded and retain split evidence', () => {
  let largest = 0;
  let found = false;
  const reader = createLineReader(line => { largest = Math.max(largest, line.length); if (line.includes('OutOfDeviceMemory')) found = true; });
  reader.write('x'.repeat(DIAGNOSTIC_BYTES - 5) + 'OutOf');
  reader.write('DeviceMemory' + 'x'.repeat(DIAGNOSTIC_BYTES * 10));
  reader.end();
  assert(found);
  assert(largest <= DIAGNOSTIC_BYTES);
});

test('abort waits for child close, removes its listener and settles once', async () => {
  const controller = new AbortController();
  let closed = false;
  let kills = 0;
  const proc = mockProcess();
  proc.kill = () => { kills++; setTimeout(() => { closed = true; proc.emit('close', null); }, 25); };
  const promise = _runProcess('mock', [], { ...deps, spawn: () => proc, signal: controller.signal, terminationOptions: { graceMs: 200, forceMs: 100 } });
  controller.abort();
  await assert.rejects(promise, err => err.message === 'Cancelled' && closed);
  assert.strictEqual(kills, 1);
  assert.strictEqual(getEventListeners(controller.signal, 'abort').length, 0);
  proc.emit('error', new Error('late event'));
});

test('synchronous mock close during abort and spawn errors settle cleanly', async () => {
  const controller = new AbortController();
  const proc = mockProcess(); proc.kill = () => proc.emit('close', null);
  const promise = _runProcess('mock', [], { ...deps, spawn: () => proc, signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, { message: 'Cancelled' });
  await assert.rejects(_runProcess('missing', [], { ...deps, signal: controller.signal }), { message: 'Cancelled' });
  const other = new AbortController();
  await assert.rejects(_runProcess('missing', [], { ...deps, signal: other.signal, spawn: mockSpawn(p => p.emit('error', new Error('ENOENT'))) }), { message: 'ENOENT' });
  assert.strictEqual(getEventListeners(other.signal, 'abort').length, 0);
});

test('Windows termination targets one PID tree and waits for taskkill', async () => {
  const proc = mockProcess(); proc.pid = 12345;
  let invocation;
  let killerClosed = false;
  const result = await terminateProcess(proc, { platform: 'win32', forceMs: 200, spawn: (cmd, args) => {
    invocation = { cmd, args };
    const killer = mockProcess();
    process.nextTick(() => {
      proc.emit('close', null);
      setTimeout(() => { killerClosed = true; killer.emit('close', 0); }, 25);
    });
    return killer;
  } });
  assert.deepStrictEqual(invocation, { cmd: 'taskkill', args: ['/PID', '12345', '/T', '/F'] });
  assert(killerClosed && result.forced && !result.timedOut);
});

test('unresponsive mocks force once, time out honestly and share termination', async () => {
  const proc = mockProcess();
  const signals = [];
  proc.kill = signal => signals.push(signal);
  const first = terminateProcess(proc, { graceMs: 10, forceMs: 20 });
  assert.strictEqual(terminateProcess(proc), first);
  const result = await first;
  assert.deepStrictEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.deepStrictEqual(result, { forced: true, timedOut: true });
  assert.strictEqual(proc.listenerCount('close'), 0);
});

test('successful processes remove abort listeners and cancellation preserves helper errors', async () => {
  const controller = new AbortController();
  await _runProcess('mock', [], { ...deps, signal: controller.signal, spawn: mockSpawn(proc => proc.emit('close', 0)) });
  assert.strictEqual(getEventListeners(controller.signal, 'abort').length, 0);
  const aborted = new AbortController();
  const promise = runJsonHelper('mock', [], { ...deps, signal: aborted.signal, spawn: mockSpawn(proc => {
    proc.kill = () => proc.emit('close', null);
    proc.stderr.emit('data', Buffer.from('{"error":"old helper failure"}\n'));
    aborted.abort();
  }) });
  await assert.rejects(promise, { message: 'Cancelled' });
});

test('real child cancellation settles before the termination deadline', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const promise = _runProcess(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], {
    ...deps, signal: controller.signal, terminationOptions: { graceMs: 200, forceMs: process.platform === 'win32' ? 2000 : 500 },
    log: message => { if (message.startsWith('[STDOUT:')) controller.abort(); },
  });
  await assert.rejects(promise, { message: 'Cancelled' });
  assert(Date.now() - started < (process.platform === 'win32' ? 5000 : 2000));
});

test('real descendant ignoring graceful termination is killed after parent closes', async () => {
  const controller = new AbortController();
  let descendant;
  let parent;
  const started = Date.now();
  const promise = _runProcess(process.execPath, [path.join(__dirname, 'fixtures', 'subprocess-tree.js')], {
    ...deps, signal: controller.signal, terminationOptions: { graceMs: 150, forceMs: process.platform === 'win32' ? 2000 : 300 },
    spawn: (...args) => { parent = spawn(...args); return parent; },
    log: message => {
      const match = /child:(\d+)/.exec(message);
      if (match) { descendant = Number(match[1]); controller.abort(); }
    },
  });
  try {
    await assert.rejects(promise, err => err.message === 'Cancelled' && err.termination.forced);
    assert(Date.now() - started < (process.platform === 'win32' ? 5000 : 2500));
    assert(descendant, 'fixture must report its child');
    let alive = true;
    try {
      process.kill(descendant, 0);
      if (process.platform === 'linux') alive = fs.readFileSync(`/proc/${descendant}/stat`, 'utf8').split(' ')[2] !== 'Z';
    } catch (err) { if (err.code === 'ESRCH' || err.code === 'ENOENT') alive = false; else throw err; }
    assert(!alive, 'descendant must no longer run');
  } finally {
    if (process.platform !== 'win32' && parent) { try { process.kill(-parent.pid, 'SIGKILL'); } catch (_) {} }
  }
});

test('helper JSON noise never forwards null or scalar values to object consumers', async () => {
  const messages = [];
  await runJsonHelper('mock', [], { ...deps,
    spawn: mockSpawn(proc => {
      proc.stderr.emit('data', Buffer.from('null\ntrue\n42\n[]\n"noise"\n{"message":"ready"}\n'));
      proc.emit('close', 0);
    }),
    onMessage: value => { messages.push(value.message); },
  });
  assert.deepStrictEqual(messages, ['ready']);
});

(async () => {
  for (const { name, fn } of tests) {
    await fn();
    console.log(`PASS: ${name}`);
  }
  console.log(`${tests.length} subprocess tests passed`);
})().catch(err => { console.error(err); process.exitCode = 1; });
