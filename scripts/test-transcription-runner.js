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
const fs = require('fs');
const os = require('os');

// Set up a temp directory as the fake app root so that lib/models
// (called by transcription-runner) can resolve model paths that pass fs.existsSync.
const FAKE_APP = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-test-'));
const FAKE_MODELS = path.join(FAKE_APP, 'models');
fs.mkdirSync(FAKE_MODELS);
// Create fake model files (symlink to this test script) for every model id.
// The runner only checks fs.existsSync, not file contents.
const MODEL_IDS = [
  'tiny.en', 'tiny', 'base.en', 'base',
  'small.en', 'small', 'small.en-tdrz',
  'medium.en', 'medium',
  'large-v3', 'large-v3-turbo', 'large-v3-turbo-q5_0', 'large-v3-q5_0',
];
const MODEL_FILENAMES = {
  'tiny.en': 'ggml-tiny.en.bin',
  'tiny': 'ggml-tiny.bin',
  'base.en': 'ggml-base.en.bin',
  'base': 'ggml-base.bin',
  'small.en': 'ggml-small.en.bin',
  'small': 'ggml-small.bin',
  'small.en-tdrz': 'ggml-small.en-tdrz.bin',
  'medium.en': 'ggml-medium.en.bin',
  'medium': 'ggml-medium.bin',
  'large-v3': 'ggml-large-v3.bin',
  'large-v3-turbo': 'ggml-large-v3-turbo.bin',
  'large-v3-turbo-q5_0': 'ggml-large-v3-turbo-q5_0.bin',
  'large-v3-q5_0': 'ggml-large-v3-q5_0.bin',
};
for (const [id, fn] of Object.entries(MODEL_FILENAMES)) {
  fs.writeFileSync(path.join(FAKE_MODELS, fn), '');
}

// Also create fake binary dirs
fs.mkdirSync(path.join(FAKE_APP, 'bin', 'linux', 'cpu'), { recursive: true });
fs.mkdirSync(path.join(FAKE_APP, 'bin', 'linux', 'vulkan'), { recursive: true });
fs.writeFileSync(path.join(FAKE_APP, 'bin', 'linux', 'cpu', 'whisper-cli'), '');
fs.writeFileSync(path.join(FAKE_APP, 'bin', 'linux', 'vulkan', 'whisper-cli'), '');
fs.writeFileSync(path.join(FAKE_APP, 'bin', 'linux', 'ffmpeg'), '');

// Initialize lib/paths so that lib/models (required by transcription-runner) can resolve paths
const libPaths = require('../lib/paths');
libPaths.initPaths({ isPackaged: false, resourcesPath: FAKE_APP });

const { createTranscriptionRunner } = require('../lib/transcription-runner');

// Cleanup on exit
process.on('exit', () => {
  try { fs.rmSync(FAKE_APP, { recursive: true, force: true }); } catch (_) {}
});

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
    getPythonCommand: async () => null,
    ...overrides,
  };
}

function makePaths(overrides = {}) {
  // Use real paths under FAKE_APP where we've created actual files.
  return {
    getWhisperBinary: (backend) => path.join(FAKE_APP, 'bin', 'linux', backend, 'whisper-cli'),
    getFfmpegBinary: () => path.join(FAKE_APP, 'bin', 'linux', 'ffmpeg'),
    getResourcePath: (rel) => path.join(FAKE_APP, rel),
    makeEnvWithLibPath: (dir) => ({ PATH: '/usr/bin' }),
    ...overrides,
  };
}

// Require models here for path init - must be after our mocks set up
// We override paths.getResourcePath in makePaths, so models isn't needed directly
// The runner requires models internally which uses lib/paths - let it run with defaults

function makeRunner(overrides = {}) {
  const { spawn } = captureSpawn();
  return createTranscriptionRunner({
    capabilities: makeCapabilities(overrides.capabilities),
    paths: makePaths(overrides.paths),
    spawn: overrides.spawn || spawn,
    log: overrides.log || (() => {}),
    tmpDir: '/tmp',
  });
}

// --- FFmpeg arg construction tests ---

console.log('FFmpeg arg construction tests\n');

test('audio input produces ffmpeg args without video flag', async () => {
  const { spawn, calls } = captureSpawn();
  const runner = makeRunner({ spawn });

  try { await runner.runTranscription({ filePath: '/fake/test.mp3', modelId: 'tiny.en', onProgress: () => {} }); } catch (_) {}

  const ffmpegCall = calls.find(c => c.cmd.includes('ffmpeg'));
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
  const runner = makeRunner({ spawn });

  try { await runner.runTranscription({ filePath: '/fake/test.mp4', modelId: 'tiny.en', onProgress: (m) => { progressMsgs.push(m); } }); } catch (_) {}

  assert(calls.some(c => c.cmd.includes('ffmpeg')), 'ffmpeg should be called');
  assert(progressMsgs[0] === 'Extracting audio...', `expected 'Extracting audio...', got '${progressMsgs[0]}'`);
});

test('audio input reports converting audio', async () => {
  const progressMsgs = [];
  const { spawn, calls } = captureSpawn();
  const runner = makeRunner({ spawn });

  try { await runner.runTranscription({ filePath: '/fake/test.wav', modelId: 'tiny.en', onProgress: (m) => { progressMsgs.push(m); } }); } catch (_) {}

  assert(calls.some(c => c.cmd.includes('ffmpeg')), 'ffmpeg should be called');
  assert(progressMsgs[0] === 'Converting audio...', `expected 'Converting audio...', got '${progressMsgs[0]}'`);
});

// --- Whisper arg construction tests ---

console.log('\nWhisper arg construction tests\n');

test('plain transcription uses --no-timestamps', async () => {
  const { spawn, calls } = captureSpawn();
  const runner = makeRunner({ spawn });

  try { await runner.runTranscription({ filePath: '/fake/test.wav', modelId: 'tiny.en', onProgress: () => {} }); } catch (_) {}

  const whisperCall = calls.find(c => c.cmd.includes('whisper-cli'));
  assert(whisperCall, 'whisper should be called');
  assert(whisperCall.args.includes('--no-timestamps'), 'should have --no-timestamps for plain transcription');
  assert(!whisperCall.args.includes('--tinydiarize'), 'should not have --tinydiarize');
  assert(!whisperCall.args.includes('--output-json-full'), 'should not have --output-json-full');
});

test('tdrz model uses --tinydiarize', async () => {
  const { spawn, calls } = captureSpawn();
  const runner = makeRunner({ spawn });

  try { await runner.runTranscription({ filePath: '/fake/test.wav', modelId: 'small.en-tdrz', options: { diarization: true }, onProgress: () => {} }); } catch (_) {}

  const whisperCall = calls.find(c => c.cmd.includes('whisper-cli'));
  assert(whisperCall, 'whisper should be called');
  assert(whisperCall.args.includes('--tinydiarize'), 'tdrz model should use --tinydiarize');
  assert(!whisperCall.args.includes('--output-json-full'), 'tdrz should not use --output-json-full');
});

test('diarization uses --output-json-full + --dtw', async () => {
  const { spawn, calls } = captureSpawn();
  const runner = makeRunner({ spawn });

  try { await runner.runTranscription({ filePath: '/fake/test.wav', modelId: 'tiny.en', options: { diarization: true }, onProgress: () => {} }); } catch (_) {}

  const whisperCall = calls.find(c => c.cmd.includes('whisper-cli'));
  assert(whisperCall, 'whisper should be called');
  assert(whisperCall.args.includes('--output-json-full'), 'diarization should use --output-json-full');
  assert(whisperCall.args.includes('-of'), 'should have -of for output prefix');
  assert(whisperCall.args.includes('--dtw'), 'should have --dtw when supported');
  assert(whisperCall.args.includes('tiny.en'), 'should have dtw preset tiny.en');
});

test('diarization without DTW support skips --dtw', async () => {
  const { spawn, calls } = captureSpawn();
  const runner = makeRunner({
    spawn,
    capabilities: { isDtwSupported: () => false },
  });

  try { await runner.runTranscription({ filePath: '/fake/test.wav', modelId: 'tiny.en', options: { diarization: true }, onProgress: () => {} }); } catch (_) {}

  const whisperCall = calls.find(c => c.cmd.includes('whisper-cli'));
  assert(whisperCall.args.includes('--output-json-full'), 'should still use JSON output');
  assert(!whisperCall.args.includes('--dtw'), 'should not have --dtw when unsupported');
});

test('anti-corruption adds -mc 0 and sampling flags', async () => {
  const { spawn, calls } = captureSpawn();
  const runner = makeRunner({ spawn });

  try { await runner.runTranscription({ filePath: '/fake/test.wav', modelId: 'tiny.en', options: { antiCorruption: true }, onProgress: () => {} }); } catch (_) {}

  const whisperCall = calls.find(c => c.cmd.includes('whisper-cli'));
  assert(whisperCall.args.includes('-mc'), 'should have -mc flag');
  assert(whisperCall.args.includes('0'), 'should set -mc 0');
  assert(whisperCall.args.includes('--temperature'), 'should have --temperature');
  assert(whisperCall.args.includes('0.4'), 'should set temperature 0.4');
  assert(whisperCall.args.includes('--entropy-thold'), 'should have --entropy-thold');
  assert(whisperCall.args.includes('1.8'), 'should set entropy threshold 1.8');
});

// Retry/fallback tests moved to scripts/test-whisper-runner.js

// --- Cancellation tests ---

console.log('\nCancellation tests\n');

test('aborted signal before ffmpeg throws Cancelled', async () => {
  const controller = new AbortController();
  controller.abort();

  const runner = makeRunner();

  try {
    await runner.runTranscription({ filePath: '/fake/test.wav', modelId: 'tiny.en', signal: controller.signal, onProgress: () => {} });
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
      process.nextTick(() => proc.emit('close', null));
    };
    return proc;
  };

  const controller = new AbortController();
  const runner = makeRunner({ spawn });

  const promise = runner.runTranscription({ filePath: '/fake/test.wav', modelId: 'tiny.en', signal: controller.signal, onProgress: () => {} });

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
