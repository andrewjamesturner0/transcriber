#!/usr/bin/env node
/**
 * Tests for lib/transcription-runner.js
 *
 * Covers: FFmpeg arg construction, whisper arg construction,
 * GPU->CPU fallback, DTW->no-DTW fallback, cancellation.
 * Follows the same plain-node style as scripts/test-merge.js.
 *
 * Usage:
 *     node scripts/test-transcription-runner.js
 */

const { EventEmitter } = require('events');
const path = require('path');
const runner = require('../lib/transcription-runner');

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
  // result can be:
  //   { stdout, stderr, code } — success or failure
  //   'error' — spawn error (ENOENT etc.)
  //   function(cmd, args, opts) — custom logic
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

function makeContext(overrides = {}) {
  return {
    ffmpegBinary: '/fake/bin/ffmpeg',
    whisperBinary: '/fake/bin/cpu/whisper-cli',
    cpuWhisperBinary: '/fake/bin/cpu/whisper-cli',
    modelPath: '/fake/models/ggml-tiny.en.bin',
    modelConfig: null,
    dtwPresets: { 'tiny.en': 'tiny.en' },
    threads: 4,
    onProgress: () => {},
    onDiarizeProgress: () => {},
    log: () => {},
    isDtwSupported: () => true,
    disableDtw: () => {},
    disableGpu: () => {},
    pythonCmd: null,
    diarizeScriptPath: '/fake/lib/diarize.py',
    mergeTranscript: (json, segs) => '[merged transcript]',
    signal: undefined,
    spawn: makeSpawn({ stdout: '', stderr: '', code: 0 }),
    makeEnvWithLibPath: (dir) => ({ PATH: '/usr/bin' }),
    _tmpDir: '/tmp',
    whisperBackend: 'cpu',
    ...overrides,
  };
}

// --- FFmpeg arg construction tests ---

console.log('FFmpeg arg construction tests\n');

test('audio input produces ffmpeg args without video flag', async () => {
  const { spawn, calls } = captureSpawn();
  const ctx = makeContext({ spawn });

  try { await runner.runTranscription('/fake/test.mp3', 'tiny.en', {}, ctx); } catch (_) {}

  const ffmpegCall = calls.find(c => c.cmd === '/fake/bin/ffmpeg');
  assert(ffmpegCall, 'ffmpeg should be called');
  assert(ffmpegCall.args.includes('-i'), 'should have -i flag');
  assert(ffmpegCall.args.includes('/fake/test.mp3'), 'should have input file');
  assert(ffmpegCall.args.includes('-ar'), 'should have -ar flag');
  assert(ffmpegCall.args.includes('16000'), 'should set 16kHz');
  assert(ffmpegCall.args.includes('-ac'), 'should have -ac flag');
  assert(ffmpegCall.args.includes('1'), 'should set mono');
  assert(ffmpegCall.args.includes('-c:a'), 'should have codec flag');
  assert(ffmpegCall.args.includes('pcm_s16le'), 'should use pcm_s16le');
  assert(ffmpegCall.args.includes('-y'), 'should have overwrite flag');
});

test('video input reports extracting audio', async () => {
  const progressMsgs = [];
  const { spawn, calls } = captureSpawn();
  const ctx = makeContext({ spawn, onProgress: (m) => { progressMsgs.push(m); } });

  try { await runner.runTranscription('/fake/test.mp4', 'tiny.en', {}, ctx); } catch (_) {}

  assert(calls.some(c => c.cmd === '/fake/bin/ffmpeg'), 'ffmpeg should be called');
  assert(progressMsgs[0] === 'Extracting audio...', `expected 'Extracting audio...', got '${progressMsgs[0]}'`);
});

test('audio input reports converting audio', async () => {
  const progressMsgs = [];
  const { spawn, calls } = captureSpawn();
  const ctx = makeContext({ spawn, onProgress: (m) => { progressMsgs.push(m); } });

  try { await runner.runTranscription('/fake/test.wav', 'tiny.en', {}, ctx); } catch (_) {}

  assert(calls.some(c => c.cmd === '/fake/bin/ffmpeg'), 'ffmpeg should be called');
  assert(progressMsgs[0] === 'Converting audio...', `expected 'Converting audio...', got '${progressMsgs[0]}'`);
});

// --- Whisper arg construction tests ---

console.log('\nWhisper arg construction tests\n');

test('plain transcription uses --no-timestamps', async () => {
  const { spawn, calls } = captureSpawn();
  const ctx = makeContext({ spawn });

  try { await runner.runTranscription('/fake/test.wav', 'tiny.en', {}, ctx); } catch (_) {}

  const whisperCall = calls.find(c => c.cmd === '/fake/bin/cpu/whisper-cli');
  assert(whisperCall, 'whisper should be called');
  assert(whisperCall.args.includes('--no-timestamps'), 'should have --no-timestamps for plain transcription');
  assert(!whisperCall.args.includes('--tinydiarize'), 'should not have --tinydiarize');
  assert(!whisperCall.args.includes('--output-json-full'), 'should not have --output-json-full');
});

test('tdrz model uses --tinydiarize', async () => {
  const { spawn, calls } = captureSpawn();
  const ctx = makeContext({
    spawn,
    modelConfig: { id: 'small.en-tdrz', fileName: 'ggml-small.en-tdrz.bin', tdrz: true },
  });

  try { await runner.runTranscription('/fake/test.wav', 'small.en-tdrz', { diarization: true }, ctx); } catch (_) {}

  const whisperCall = calls.find(c => c.cmd === '/fake/bin/cpu/whisper-cli');
  assert(whisperCall, 'whisper should be called');
  assert(whisperCall.args.includes('--tinydiarize'), 'tdrz model should use --tinydiarize');
  assert(!whisperCall.args.includes('--output-json-full'), 'tdrz should not use --output-json-full');
});

test('diarization uses --output-json-full + --dtw', async () => {
  const { spawn, calls } = captureSpawn();
  const ctx = makeContext({ spawn });

  try { await runner.runTranscription('/fake/test.wav', 'tiny.en', { diarization: true }, ctx); } catch (_) {}

  const whisperCall = calls.find(c => c.cmd === '/fake/bin/cpu/whisper-cli');
  assert(whisperCall, 'whisper should be called');
  assert(whisperCall.args.includes('--output-json-full'), 'diarization should use --output-json-full');
  assert(whisperCall.args.includes('-of'), 'should have -of for output prefix');
  assert(whisperCall.args.includes('--dtw'), 'should have --dtw when supported');
  assert(whisperCall.args.includes('tiny.en'), 'should have dtw preset tiny.en');
});

test('diarization without DTW support skips --dtw', async () => {
  const { spawn, calls } = captureSpawn();
  const ctx = makeContext({ spawn, isDtwSupported: () => false });

  try { await runner.runTranscription('/fake/test.wav', 'tiny.en', { diarization: true }, ctx); } catch (_) {}

  const whisperCall = calls.find(c => c.cmd === '/fake/bin/cpu/whisper-cli');
  assert(whisperCall.args.includes('--output-json-full'), 'should still use JSON output');
  assert(!whisperCall.args.includes('--dtw'), 'should not have --dtw when unsupported');
});

test('anti-corruption adds -mc 0 and sampling flags', async () => {
  const { spawn, calls } = captureSpawn();
  const ctx = makeContext({ spawn });

  try { await runner.runTranscription('/fake/test.wav', 'tiny.en', { antiCorruption: true }, ctx); } catch (_) {}

  const whisperCall = calls.find(c => c.cmd === '/fake/bin/cpu/whisper-cli');
  assert(whisperCall.args.includes('-mc'), 'should have -mc flag');
  assert(whisperCall.args.includes('0'), 'should set -mc 0');
  assert(whisperCall.args.includes('--temperature'), 'should have --temperature');
  assert(whisperCall.args.includes('0.4'), 'should set temperature 0.4');
  assert(whisperCall.args.includes('--entropy-thold'), 'should have --entropy-thold');
  assert(whisperCall.args.includes('1.8'), 'should set entropy threshold 1.8');
});

// --- GPU -> CPU fallback tests ---

console.log('\nGPU fallback tests\n');

test('Vulkan failure falls back to CPU binary', async () => {
  let cpuCalled = false;
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
    if (cmd.includes('cpu')) {
      cpuCalled = true;
      return makeSpawn({ stdout: 'cpu result\n', stderr: '', code: 0 })(cmd, args, opts);
    }
    return makeSpawn({ stdout: '', stderr: '', code: 0 })(cmd, args, opts);
  };

  const ctx = makeContext({
    spawn,
    whisperBinary: '/fake/bin/vulkan/whisper-cli',
    cpuWhisperBinary: '/fake/bin/cpu/whisper-cli',
    whisperBackend: 'vulkan',
  });

  const result = await runner.runTranscription('/fake/test.wav', 'tiny.en', {}, ctx);
  assert(cpuCalled, 'CPU binary should be called after Vulkan failure');
  assert(result === 'cpu result', `expected 'cpu result', got '${result}'`);
});

test('OOM error does not disable GPU', async () => {
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

  const ctx = makeContext({
    spawn,
    whisperBinary: '/fake/bin/vulkan/whisper-cli',
    cpuWhisperBinary: '/fake/bin/cpu/whisper-cli',
    whisperBackend: 'vulkan',
    disableGpu: () => { disabled = true; },
  });

  await runner.runTranscription('/fake/test.wav', 'tiny.en', {}, ctx);
  assert(!disabled, 'OOM should not disable GPU for future runs');
});

test('non-OOM Vulkan error disables GPU', async () => {
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

  const ctx = makeContext({
    spawn,
    whisperBinary: '/fake/bin/vulkan/whisper-cli',
    cpuWhisperBinary: '/fake/bin/cpu/whisper-cli',
    whisperBackend: 'vulkan',
    disableGpu: () => { disabled = true; },
  });

  await runner.runTranscription('/fake/test.wav', 'tiny.en', {}, ctx);
  assert(disabled, 'non-OOM Vulkan error should disable GPU');
});

// --- DTW fallback tests ---

console.log('\nDTW fallback tests\n');

test('DTW error strips --dtw and retries', async () => {
  let whisperCalls = 0;
  let secondCallArgs = null;
  let dtwDisabled = false;

  const spawn = function (cmd, args, opts) {
    if (cmd.includes('whisper')) {
      whisperCalls++;
      if (whisperCalls === 1) {
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
    }
    return makeSpawn({ stdout: '', stderr: '', code: 0 })(cmd, args, opts);
  };

  const ctx = makeContext({
    spawn,
    disableDtw: () => { dtwDisabled = true; },
  });

  const result = await runner.runTranscription('/fake/test.wav', 'tiny.en', { diarization: true }, ctx);
  assert(whisperCalls === 2, `expected 2 whisper spawns, got ${whisperCalls}`);
  assert(dtwDisabled, 'DTW should be disabled after error');
  assert(!secondCallArgs.includes('--dtw'), 'retry should strip --dtw');
  assert(result === 'retry result', `expected 'retry result', got '${result}'`);
});

// --- Cancellation tests ---

console.log('\nCancellation tests\n');

test('aborted signal before ffmpeg throws Cancelled', async () => {
  const controller = new AbortController();
  controller.abort();

  const ctx = makeContext({ signal: controller.signal });

  try {
    await runner.runTranscription('/fake/test.wav', 'tiny.en', {}, ctx);
    assert(false, 'should have thrown');
  } catch (err) {
    assert(err.message === 'Cancelled', `expected 'Cancelled', got '${err.message}'`);
  }
});

test('cancellation during whisper phase kills process', async () => {
  let killed = false;
  let aborted = false;

  const spawn = function (cmd, args, opts) {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {
      killed = true;
      // Simulate real Node behavior: kill emits close with signal code
      process.nextTick(() => proc.emit('close', null));
    };
    // Never emits close on its own — waits for kill
    return proc;
  };

  const controller = new AbortController();
  const ctx = makeContext({ spawn, signal: controller.signal });

  const promise = runner.runTranscription('/fake/test.wav', 'tiny.en', {}, ctx);

  // Abort after a tick
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();

  try {
    await promise;
    assert(false, 'should have thrown');
  } catch (err) {
    aborted = true;
    assert(err.message === 'Cancelled', `expected 'Cancelled', got '${err.message}'`);
  }

  assert(killed, 'process should be killed on abort');
  assert(aborted, 'should reject with Cancelled');
});

// ---------------------------------------------------------------------------

runAll();
