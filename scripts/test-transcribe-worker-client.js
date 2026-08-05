#!/usr/bin/env node

const path = require('path');
const { EventEmitter } = require('events');
const { createTranscribeWorkerClient } = require('../lib/transcribe-worker-client');

const fakeWorker = path.join(__dirname, 'fixtures', 'fake-transcribe-worker.js');
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  FAIL: ${name} -- ${error.message}`);
    failed += 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function makeClient(overrides = {}) {
  return createTranscribeWorkerClient({
    launch: { command: process.execPath, args: [fakeWorker], env: process.env },
    timeoutMs: 1000,
    ...overrides,
  });
}

function makeProtocolSpawn(handleFrame) {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.exitCode = null;
    const exit = (code = 0) => {
      if (proc.exitCode != null) return;
      proc.exitCode = code;
      process.nextTick(() => proc.emit('exit', code, null));
    };
    const send = (frame) => proc.stdout.emit('data', Buffer.from(`${JSON.stringify(frame)}\n`));
    proc.stdin = {
      write(line, callback) {
        const frame = JSON.parse(line);
        handleFrame(frame, send, exit);
        if (callback) process.nextTick(() => callback(null));
        return true;
      },
      end: () => exit(0),
    };
    proc.kill = () => exit(143);
    return proc;
  };
}

(async () => {
  await test('serial jobs reuse a loaded model and keep stderr separate', async () => {
    const logs = [];
    const client = makeClient({ log: (line) => logs.push(line) });
    const first = await client.transcribe({ modelPath: '/model.gguf', backend: 'cpu', wavPath: '/a.wav', jobId: 'a' });
    const second = await client.transcribe({ modelPath: '/model.gguf', backend: 'cpu', wavPath: '/b.wav', jobId: 'b' });
    assert(first.loadCount === 1 && second.loadCount === 1, 'model should load once');
    assert(logs.some((line) => line.includes('loaded cpu')), 'stderr should reach log callback');
    await client.shutdown();
  });

  await test('cancellation aborts the active request', async () => {
    const client = makeClient();
    const controller = new AbortController();
    const pending = client.transcribe({ modelPath: '/model.gguf', backend: 'cpu', wavPath: '/a.wav', jobId: 'slow', options: { behaviour: 'slow' }, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    let error;
    try { await pending; } catch (caught) { error = caught; }
    assert(error && error.message === 'Cancelled', 'active request should reject as Cancelled');
    await client.shutdown();
  });

  await test('cancellation kills an unresponsive inference after a bounded grace period', async () => {
    const client = makeClient({ cancellationTimeoutMs: 40 });
    const controller = new AbortController();
    const pending = client.transcribe({ modelPath: '/model.gguf', backend: 'cpu', wavPath: '/a.wav', jobId: 'stuck', options: { behaviour: 'timeout' }, signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    let error;
    try { await pending; } catch (caught) { error = caught; }
    assert(error && error.code === 'WORKER_EXIT', `unresponsive cancellation should stop the worker, got ${error && error.code}`);
    await client.shutdown();
  });

  await test('timeout rejects and stops the worker', async () => {
    const client = makeClient({ controlTimeoutMs: 100, loadTimeoutMs: 100, transcriptionTimeoutMs: 100 });
    let error;
    try { await client.transcribe({ modelPath: '/model.gguf', backend: 'cpu', wavPath: '/a.wav', jobId: 'timeout', options: { behaviour: 'timeout' } }); } catch (caught) { error = caught; }
    assert(error && error.code === 'WORKER_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert(!client.getState().running, 'timed out worker should exit');
    await client.shutdown();
  });

  await test('transcription can outlive the control timeout', async () => {
    const client = makeClient({
      controlTimeoutMs: 20,
      loadTimeoutMs: 200,
      spawn: makeProtocolSpawn((frame, send, exit) => {
        if (frame.op === 'load') {
          setTimeout(() => send({ id: frame.id, ok: true, result: { backend: frame.backend } }), 60);
        } else if (frame.op === 'transcribe') {
          setTimeout(() => send({ id: frame.id, ok: true, result: { text: 'long enough', backend: 'cpu' } }), 60);
        } else if (frame.op === 'shutdown') {
          send({ id: frame.id, ok: true, result: { shutdown: true } });
          exit(0);
        }
      }),
    });
    const result = await client.transcribe({ modelPath: '/model.gguf', backend: 'cpu', wavPath: '/a.wav', jobId: 'long' });
    assert(result.text === 'long enough', 'long transcription should complete');
    await client.shutdown();
  });

  await test('forced exit rejects the job and the next client request recovers', async () => {
    const client = makeClient();
    let error;
    try { await client.transcribe({ modelPath: '/model.gguf', backend: 'cpu', wavPath: '/a.wav', jobId: 'crash', options: { behaviour: 'crash' } }); } catch (caught) { error = caught; }
    assert(error && error.code === 'WORKER_EXIT');
    const next = await client.transcribe({ modelPath: '/model.gguf', backend: 'cpu', wavPath: '/b.wav', jobId: 'next' });
    assert(next.text === 'ok');
    await client.shutdown();
  });

  await test('non-OOM Vulkan failure disables Vulkan and reuses CPU for the next job', async () => {
    const client = makeClient();
    const first = await client.transcribe({ modelPath: '/model.gguf', backend: 'vulkan', wavPath: '/a.wav', jobId: 'gpu', options: { behaviour: 'vulkan-fail' } });
    const second = await client.transcribe({ modelPath: '/model.gguf', backend: 'vulkan', wavPath: '/b.wav', jobId: 'next' });
    assert(first.backend === 'cpu' && second.backend === 'cpu', 'both jobs should complete on CPU');
    assert(second.loadCount === 2, 'the reusable CPU model should only load once');
    assert(JSON.stringify(second.transcribeBackends) === JSON.stringify(['vulkan', 'cpu', 'cpu']), `unexpected backend attempts: ${second.transcribeBackends.join(',')}`);
    assert(client.getState().vulkanUnavailable === true, 'Vulkan should be unavailable for this client session');
    assert(client.getState().vulkanUnavailableReason === 'BACKEND_FAILURE', 'state should expose the failure reason');
    await client.shutdown();
  });

  await test('native OutOfMemory during inference retries once without disabling Vulkan', async () => {
    const client = makeClient();
    const first = await client.transcribe({ modelPath: '/model.gguf', backend: 'vulkan', wavPath: '/large.wav', jobId: 'large', options: { behaviour: 'vulkan-oom' } });
    const second = await client.transcribe({ modelPath: '/model.gguf', backend: 'vulkan', wavPath: '/small.wav', jobId: 'small' });
    assert(first.backend === 'cpu', 'the OOM job should retry on CPU');
    assert(second.backend === 'vulkan', 'a later smaller job should try Vulkan again');
    assert(JSON.stringify(second.transcribeBackends) === JSON.stringify(['vulkan', 'cpu', 'vulkan']), `unexpected backend attempts: ${second.transcribeBackends.join(',')}`);
    assert(client.getState().vulkanUnavailable === false, 'OOM must not disable Vulkan');
    await client.shutdown();
  });

  await test('native OutOfMemory during load retries once without disabling Vulkan', async () => {
    const loads = [];
    let failFirstVulkanLoad = true;
    const client = makeClient({
      spawn: makeProtocolSpawn((frame, send, exit) => {
        if (frame.op === 'load') {
          loads.push(frame.backend);
          if (frame.backend === 'vulkan' && failFirstVulkanLoad) {
            failFirstVulkanLoad = false;
            send({ id: frame.id, ok: false, error: { code: 'OutOfMemory', message: 'Vulkan allocation failed' } });
          } else {
            send({ id: frame.id, ok: true, result: { backend: frame.backend } });
          }
        } else if (frame.op === 'transcribe') {
          send({ id: frame.id, ok: true, result: { text: 'result', backend: loads[loads.length - 1] } });
        } else if (frame.op === 'shutdown') {
          send({ id: frame.id, ok: true, result: { shutdown: true } });
          exit(0);
        }
      }),
    });
    const first = await client.transcribe({ modelPath: '/model.gguf', backend: 'vulkan', wavPath: '/large.wav', jobId: 'load-oom' });
    const second = await client.transcribe({ modelPath: '/model.gguf', backend: 'vulkan', wavPath: '/small.wav', jobId: 'load-ok' });
    assert(first.backend === 'cpu', 'the load OOM should retry on CPU');
    assert(second.backend === 'vulkan', 'the next job should try Vulkan again');
    assert(JSON.stringify(loads) === JSON.stringify(['vulkan', 'cpu', 'vulkan']), `unexpected loads: ${loads.join(',')}`);
    assert(client.getState().vulkanUnavailable === false, 'load OOM must not disable Vulkan');
    await client.shutdown();
  });

  await test('production BackendError during load retries exactly once on CPU', async () => {
    const loads = [];
    const client = makeClient({
      spawn: makeProtocolSpawn((frame, send, exit) => {
        if (frame.op === 'load') {
          loads.push(frame.backend);
          if (frame.backend === 'vulkan') {
            send({ id: frame.id, ok: false, error: { code: 'BackendError', message: 'Vulkan init failed' } });
          } else {
            send({ id: frame.id, ok: true, result: { backend: 'cpu' } });
          }
        } else if (frame.op === 'transcribe') {
          send({ id: frame.id, ok: true, result: { text: 'cpu result', backend: 'cpu' } });
        } else if (frame.op === 'shutdown') {
          send({ id: frame.id, ok: true, result: { shutdown: true } });
          exit(0);
        }
      }),
    });
    const result = await client.transcribe({ modelPath: '/model.gguf', backend: 'vulkan', wavPath: '/a.wav', jobId: 'load-fallback' });
    assert(result.backend === 'cpu', 'load failure should fall back to CPU');
    assert(JSON.stringify(loads) === JSON.stringify(['vulkan', 'cpu']), `unexpected loads: ${loads.join(',')}`);
    await client.shutdown();
  });

  await test('shutdown is idempotent and leaves no child', async () => {
    const client = makeClient();
    await client.transcribe({ modelPath: '/model.gguf', backend: 'cpu', wavPath: '/a.wav', jobId: 'a' });
    await client.shutdown();
    await client.shutdown();
    assert(!client.getState().running && client.getState().closed);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
