#!/usr/bin/env node
/**
 * Tests for lib/whisper-runner.js
 *
 * Covers: arg construction, DTW fallback, GPU fallback, cancellation.
 * No FFmpeg or diarization - those are pipeline-runner concerns.
 *
 * Usage:
 *     node scripts/test-whisper-runner.js
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createWhisperRunner } = require('../lib/whisper-runner');

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

// --- Mock helpers ---

function makeSpawn(result) {
  return function (cmd, args, opts) {
    if (typeof result === 'function') return result(cmd, args, opts);

    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();

    if (result === 'error') {
      process.nextTick(() => proc.emit('error', new Error('ENOENT')));
      return proc;
    }

    const r = result || { stdout: '', stderr: '', code: 0 };
    process.nextTick(() => {
      if (r.stdout) proc.stdout.emit('data', Buffer.from(r.stdout));
      if (r.stderr) proc.stderr.emit('data', Buffer.from(r.stderr));
      proc.emit('close', r.code != null ? r.code : 0);
    });
    return proc;
  };
}

function captureSpawn() {
  const calls = [];
  const spawn = function (cmd, args, opts) {
    calls.push({ cmd, args: [...args], opts });
    return makeSpawn({ stdout: 'ok\n', stderr: '', code: 0 })(cmd, args, opts);
  };
  return { spawn, calls };
}

function makeCapabilities(overrides = {}) {
  return {
    getActiveBackend: () => 'cpu',
    isDtwSupported: () => true,
    disableDtw: () => {},
    disableGpu: () => {},
    ...overrides,
  };
}

function makePaths(overrides = {}) {
  // Point all binaries to this test file (which exists) so fs.existsSync passes.
  // The mock spawn discriminates by cmd.includes('vulkan').
  return {
    getWhisperBinary: (backend) => `/fake/bin/${backend}/whisper-cli`,
    makeEnvWithLibPath: (dir) => ({ PATH: '/usr/bin' }),
    ...overrides,
  };
}

// Patch fs.existsSync for all whisper paths to return true (fake paths don't exist on disk).
const origExistsSync = fs.existsSync;
fs.existsSync = (p) => {
  if (typeof p === 'string' && p.includes('whisper-cli')) return true;
  return origExistsSync(p);
};

function makeRunner(overrides = {}) {
  return createWhisperRunner({
    capabilities: makeCapabilities(overrides.capabilities),
    paths: makePaths(overrides.paths),
    spawn: overrides.spawn || makeSpawn({ stdout: 'result\n', stderr: '', code: 0 }),
    log: overrides.log || (() => {}),
  });
}

const MODEL_SPEC = { id: 'tiny.en', fileName: 'ggml-tiny.en.bin', dtwPreset: 'tiny.en' };
const TDRZ_SPEC = { id: 'small.en-tdrz', fileName: 'ggml-small.en-tdrz.bin', tdrz: true };

// --- Arg construction tests ---

console.log('Arg construction tests\n');

test('plain transcription uses --no-timestamps', async () => {
  const { spawn, calls } = captureSpawn();
  const runner = makeRunner({ spawn });

  await runner.transcribe({
    modelSpec: MODEL_SPEC,
    modelPath: '/fake/models/ggml-tiny.en.bin',
    wavPath: '/fake/test.wav',
    onProgress: () => {},
  });

  const wcall = calls[0];
  assert(wcall.args.includes('--no-timestamps'), 'should have --no-timestamps');
  assert(!wcall.args.includes('--tinydiarize'), 'should not have --tinydiarize');
  assert(!wcall.args.includes('--output-json-full'), 'should not have --output-json-full');
});

test('tdrz model uses --tinydiarize', async () => {
  const { spawn, calls } = captureSpawn();
  const runner = makeRunner({ spawn });

  await runner.transcribe({
    modelSpec: TDRZ_SPEC,
    modelPath: '/fake/models/ggml-small.en-tdrz.bin',
    wavPath: '/fake/test.wav',
    options: { diarization: true },
    onProgress: () => {},
  });

  const wcall = calls[0];
  assert(wcall.args.includes('--tinydiarize'), 'tdrz model should use --tinydiarize');
  assert(!wcall.args.includes('--output-json-full'), 'tdrz should not use --output-json-full');
});

test('diarization + DTW supported adds --output-json-full + --dtw', async () => {
  const { spawn, calls } = captureSpawn();
  const runner = makeRunner({ spawn });

  await runner.transcribe({
    modelSpec: MODEL_SPEC,
    modelPath: '/fake/models/ggml-tiny.en.bin',
    wavPath: '/fake/test.wav',
    options: { diarization: true },
    onProgress: () => {},
  });

  const wcall = calls[0];
  assert(wcall.args.includes('--output-json-full'), 'should have --output-json-full');
  assert(wcall.args.includes('-of'), 'should have -of');
  assert(wcall.args.includes('--dtw'), 'should have --dtw');
  assert(wcall.args.includes('tiny.en'), 'should have dtw preset tiny.en');
});

test('diarization + DTW unsupported skips --dtw', async () => {
  const { spawn, calls } = captureSpawn();
  const runner = makeRunner({
    spawn,
    capabilities: { isDtwSupported: () => false },
  });

  await runner.transcribe({
    modelSpec: MODEL_SPEC,
    modelPath: '/fake/models/ggml-tiny.en.bin',
    wavPath: '/fake/test.wav',
    options: { diarization: true },
    onProgress: () => {},
  });

  const wcall = calls[0];
  assert(wcall.args.includes('--output-json-full'), 'should still use JSON output');
  assert(!wcall.args.includes('--dtw'), 'should not have --dtw when unsupported');
});

test('anti-corruption adds sampling flags', async () => {
  const { spawn, calls } = captureSpawn();
  const runner = makeRunner({ spawn });

  await runner.transcribe({
    modelSpec: MODEL_SPEC,
    modelPath: '/fake/models/ggml-tiny.en.bin',
    wavPath: '/fake/test.wav',
    options: { antiCorruption: true },
    onProgress: () => {},
  });

  const wcall = calls[0];
  assert(wcall.args.includes('-mc'), 'should have -mc flag');
  assert(wcall.args.includes('0'), 'should set -mc 0');
  assert(wcall.args.includes('--temperature'), 'should have --temperature');
  assert(wcall.args.includes('0.4'), 'should set temperature 0.4');
  assert(wcall.args.includes('--entropy-thold'), 'should have --entropy-thold');
  assert(wcall.args.includes('1.8'), 'should set entropy threshold 1.8');
});

// --- DTW fallback tests ---

console.log('\nDTW fallback tests\n');

test('DTW error disables DTW and retries without --dtw', async () => {
  let firstCall = true;
  let secondCallArgs = null;
  let dtwDisabled = false;

  const spawn = function (cmd, args, opts) {
    if (firstCall) {
      firstCall = false;
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      process.nextTick(() => {
        proc.stderr.emit('data', Buffer.from('error: unknown DTW preset: bogus\n'));
        proc.emit('close', 1);
      });
      return proc;
    }
    secondCallArgs = [...args];
    return makeSpawn({ stdout: 'retry result\n', stderr: '', code: 0 })(cmd, args, opts);
  };

  const runner = makeRunner({
    spawn,
    capabilities: { disableDtw: () => { dtwDisabled = true; } },
  });

  const result = await runner.transcribe({
    modelSpec: MODEL_SPEC,
    modelPath: '/fake/models/ggml-tiny.en.bin',
    wavPath: '/fake/test.wav',
    options: { diarization: true },
    onProgress: () => {},
  });

  assert(dtwDisabled, 'DTW should be disabled after error');
  assert(!secondCallArgs.includes('--dtw'), 'retry should strip --dtw');
  assert(result.output === 'retry result', `expected 'retry result', got '${result.output}'`);
});

test('DTW error + retry also fails throws original error', async () => {
  const spawn = function (cmd, args, opts) {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    process.nextTick(() => {
      proc.stderr.emit('data', Buffer.from('error: unknown DTW preset: bogus\n'));
      proc.emit('close', 1);
    });
    return proc;
  };

  const runner = makeRunner({ spawn });

  try {
    await runner.transcribe({
      modelSpec: MODEL_SPEC,
      modelPath: '/fake/models/ggml-tiny.en.bin',
      wavPath: '/fake/test.wav',
      options: { diarization: true },
      onProgress: () => {},
    });
    assert(false, 'should have thrown');
  } catch (err) {
    assert(err.message.includes('DTW preset'), `expected DTW error, got '${err.message}'`);
  }
});

// --- GPU fallback tests ---

console.log('\nGPU fallback tests\n');

test('Vulkan failure falls back to CPU', async () => {
  let cpuUsed = false;
  const spawn = function (cmd, args, opts) {
    if (cmd.includes('vulkan')) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      process.nextTick(() => {
        proc.stderr.emit('data', Buffer.from('Vulkan error'));
        proc.emit('close', 1);
      });
      return proc;
    }
    cpuUsed = true;
    return makeSpawn({ stdout: 'cpu result\n', stderr: '', code: 0 })(cmd, args, opts);
  };

  const runner = makeRunner({
    spawn,
    capabilities: { getActiveBackend: () => 'vulkan' },
  });

  const result = await runner.transcribe({
    modelSpec: MODEL_SPEC,
    modelPath: '/fake/models/ggml-tiny.en.bin',
    wavPath: '/fake/test.wav',
    onProgress: () => {},
  });

  assert(cpuUsed, 'CPU binary should be called after Vulkan failure');
  assert(result.backend === 'cpu', `expected backend 'cpu', got '${result.backend}'`);
  assert(result.output === 'cpu result', `expected 'cpu result', got '${result.output}'`);
});

test('GPU OOM does NOT call disableGpu', async () => {
  let disabled = false;
  const spawn = function (cmd, args, opts) {
    if (cmd.includes('vulkan')) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      process.nextTick(() => {
        proc.stderr.emit('data', Buffer.from('OutOfDeviceMemory'));
        proc.emit('close', 1);
      });
      return proc;
    }
    return makeSpawn({ stdout: 'cpu result\n', stderr: '', code: 0 })(cmd, args, opts);
  };

  const runner = makeRunner({
    spawn,
    capabilities: { getActiveBackend: () => 'vulkan', disableGpu: () => { disabled = true; } },
  });

  await runner.transcribe({
    modelSpec: MODEL_SPEC,
    modelPath: '/fake/models/ggml-tiny.en.bin',
    wavPath: '/fake/test.wav',
    onProgress: () => {},
  });

  assert(!disabled, 'OOM should not disable GPU');
});

test('GPU non-OOM calls disableGpu', async () => {
  let disabled = false;
  const spawn = function (cmd, args, opts) {
    if (cmd.includes('vulkan')) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      process.nextTick(() => {
        proc.stderr.emit('data', Buffer.from('Some Vulkan error'));
        proc.emit('close', 1);
      });
      return proc;
    }
    return makeSpawn({ stdout: 'cpu result\n', stderr: '', code: 0 })(cmd, args, opts);
  };

  const runner = makeRunner({
    spawn,
    capabilities: { getActiveBackend: () => 'vulkan', disableGpu: () => { disabled = true; } },
  });

  await runner.transcribe({
    modelSpec: MODEL_SPEC,
    modelPath: '/fake/models/ggml-tiny.en.bin',
    wavPath: '/fake/test.wav',
    onProgress: () => {},
  });

  assert(disabled, 'non-OOM should disable GPU');
});

// --- Cancellation tests ---

console.log('\nCancellation tests\n');

test('Cancellation during first attempt throws immediately', async () => {
  const controller = new AbortController();
  controller.abort();

  const runner = makeRunner();

  try {
    await runner.transcribe({
      modelSpec: MODEL_SPEC,
      modelPath: '/fake/models/ggml-tiny.en.bin',
      wavPath: '/fake/test.wav',
      signal: controller.signal,
      onProgress: () => {},
    });
    assert(false, 'should have thrown');
  } catch (err) {
    assert(err.message === 'Cancelled', `expected 'Cancelled', got '${err.message}'`);
  }
});

test('Cancellation during retry does not trigger further fallback', async () => {
  let spawnCount = 0;
  const spawn = function (cmd, args, opts) {
    spawnCount++;
    // First call: vulkan error
    if (spawnCount === 1) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      process.nextTick(() => {
        proc.stderr.emit('data', Buffer.from('Some Vulkan error'));
        proc.emit('close', 1);
      });
      return proc;
    }
    // Second call: hang forever until killed by abort
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => { process.nextTick(() => proc.emit('close', null)); };
    return proc;
  };

  const controller = new AbortController();
  const runner = makeRunner({
    spawn,
    capabilities: { getActiveBackend: () => 'vulkan' },
  });

  const promise = runner.transcribe({
    modelSpec: MODEL_SPEC,
    modelPath: '/fake/models/ggml-tiny.en.bin',
    wavPath: '/fake/test.wav',
    signal: controller.signal,
    onProgress: () => {},
  });

  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();

  try {
    await promise;
    assert(false, 'should have thrown');
  } catch (err) {
    assert(err.message === 'Cancelled', `expected 'Cancelled', got '${err.message}'`);
  }
  assert(spawnCount === 2, `expected 2 spawns, got ${spawnCount}`);
});

// ---------------------------------------------------------------------------

runAll();
