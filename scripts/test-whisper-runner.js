#!/usr/bin/env node
/**
 * Tests for lib/whisper-runner.js
 *
 * Covers: arg construction, DTW flags and status, DTW fallback, GPU
 * fallback, cancellation.
 * No FFmpeg or diarization - those are pipeline-runner concerns.
 *
 * Usage:
 *     node scripts/test-whisper-runner.js
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createWhisperRunner, _buildWhisperArgs, _stripDtwArgs, _findDtwDisableWarning } = require('../lib/whisper-runner');

// --- Helpers ---

const testTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-whisper-'));
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
  fs.rmSync(testTmp, { recursive: true, force: true });
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
    tmpDir: testTmp,
    capabilities: makeCapabilities(overrides.capabilities),
    paths: makePaths(overrides.paths),
    spawn: overrides.spawn || makeSpawn({ stdout: 'result\n', stderr: '', code: 0 }),
    log: overrides.log || (() => {}),
  });
}

const MODEL_SPEC = { id: 'tiny.en', fileName: 'ggml-tiny.en.bin', dtwPreset: 'tiny.en' };
const BASE = {
  modelSpec: MODEL_SPEC,
  modelPath: '/fake/models/ggml-tiny.en.bin',
  wavPath: '/fake/test.wav',
  jsonPrefix: '/fake/out/whisper_out',
  onProgress: () => {},
};
const FLASH_WARNING = 'whisper_init_with_params_no_state: dtw_token_timestamps is not supported with flash_attn - disabling\n';

// A process that exits with `code` after writing stderr.
function failingProc(stderrText, code = 1) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  process.nextTick(() => {
    proc.stderr.emit('data', Buffer.from(stderrText));
    proc.emit('close', code);
  });
  return proc;
}

// A process that never exits until killed (for cancellation tests).
function hangingProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => { process.nextTick(() => proc.emit('close', null)); };
  return proc;
}

function count(arr, v) {
  return arr.filter(x => x === v).length;
}
const TDRZ_SPEC = { id: 'small.en-tdrz', fileName: 'ggml-small.en-tdrz.bin', tdrz: true };

// --- Arg construction tests ---

console.log('Arg construction tests\n');

test('catalogue IDs choose language for every output and alignment mode', () => {
  const { getModel } = require('../lib/models');
  const models = ['tiny.en', 'tiny', 'base.en', 'base', 'small.en', 'small', 'small.en-tdrz', 'medium.en', 'medium', 'large-v3', 'large-v3-turbo', 'large-v3-turbo-q5_0', 'large-v3-q5_0'].map(getModel);
  for (const model of models) {
    for (const options of [{}, { outputJson: true }, { diarization: true, dtw: true }, { diarization: true, alignment: 'forced' }]) {
      const args = _buildWhisperArgs('/model', '/audio', '/json', options, model, () => true);
      const expected = /\.en(?:$|-)/.test(model.id) ? 'en' : 'auto';
      assert(args[args.indexOf('-l') + 1] === expected, `wrong language for ${model.id}`);
      assert(count(args, '-l') === 1, 'language must appear once');
    }
  }
});

test('multilingual DTW and CPU retries retain automatic detection', async () => {
  for (const failure of ['unknown DTW preset: tiny', 'GPU device lost']) {
    const calls = [];
    const spawn = (cmd, args, opts) => {
      calls.push([...args]);
      return calls.length === 1 ? failingProc(failure) : makeSpawn()(cmd, args, opts);
    };
    const runner = makeRunner({ spawn, capabilities: { getActiveBackend: () => 'vulkan' } });
    await runner.transcribe({ ...BASE, modelSpec: { id: 'tiny', dtwPreset: 'tiny' }, options: { diarization: true, dtw: true } });
    assert(calls.length === 2, 'expected a retry');
    assert(calls.every(args => args[args.indexOf('-l') + 1] === 'auto'), 'every attempt must detect language');
  }
});

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

test('default diarised job keeps flash attention and ordinary timing even when DTW is supported', async () => {
  const { spawn, calls } = captureSpawn();
  const runner = makeRunner({ spawn });
  const result = await runner.transcribe({ ...BASE, options: { diarization: true } });
  assert(calls[0].args.includes('--output-json-full'), 'word offsets still requested');
  assert(!calls[0].args.includes('--dtw'), 'default must not enable DTW');
  assert(!calls[0].args.includes('--no-flash-attn'), 'default decoder must keep flash attention');
  assert(result.dtw.requested === false && result.dtw.disabledReason === null, 'DTW is not requested');
});

test('diarization + DTW supported adds --output-json-full + --dtw', async () => {
  const { spawn, calls } = captureSpawn();
  const runner = makeRunner({ spawn });

  await runner.transcribe({
    modelSpec: MODEL_SPEC,
    modelPath: '/fake/models/ggml-tiny.en.bin',
    wavPath: '/fake/test.wav',
    options: { diarization: true, dtw: true },
    onProgress: () => {},
  });

  const wcall = calls[0];
  assert(wcall.args.includes('--output-json-full'), 'should have --output-json-full');
  assert(wcall.args.includes('-of'), 'should have -of');
  assert(wcall.args.includes('--dtw'), 'should have --dtw');
  assert(wcall.args.includes('tiny.en'), 'should have dtw preset tiny.en');
});

test('diarised DTW job adds --no-flash-attn exactly once, next to --dtw', async () => {
  const { spawn, calls } = captureSpawn();
  const runner = makeRunner({ spawn });

  const result = await runner.transcribe({ ...BASE, options: { diarization: true, dtw: true } });

  const args = calls[0].args;
  assert(count(args, '--no-flash-attn') === 1, `--no-flash-attn should appear once: ${args.join(' ')}`);
  assert(count(args, '--dtw') === 1, '--dtw should appear once');
  const i = args.indexOf('--dtw');
  assert(args[i + 1] === 'tiny.en' && args[i + 2] === '--no-flash-attn',
    `expected --dtw tiny.en --no-flash-attn, got ${args.join(' ')}`);
  assert(result.dtw.requested === true, 'dtw.requested should be true');
  assert(result.dtw.preset === 'tiny.en', `dtw.preset should be tiny.en, got ${result.dtw.preset}`);
  assert(result.dtw.disabledReason === null, `dtw.disabledReason should be null, got ${result.dtw.disabledReason}`);
});

test('plain job args are unchanged and DTW is not requested', async () => {
  const { spawn, calls } = captureSpawn();
  const runner = makeRunner({ spawn });

  const result = await runner.transcribe({ ...BASE });

  const expected = ['-m', BASE.modelPath, '-f', BASE.wavPath, '-t', '4', '-l', 'en', '--no-timestamps'];
  assert(JSON.stringify(calls[0].args) === JSON.stringify(expected),
    `plain args changed: ${calls[0].args.join(' ')}`);
  assert(result.dtw.requested === false && result.dtw.preset === null && result.dtw.disabledReason === null,
    `unexpected dtw status ${JSON.stringify(result.dtw)}`);
});

test('plain job with anti-corruption keeps its exact flags', async () => {
  const { spawn, calls } = captureSpawn();
  const runner = makeRunner({ spawn });

  await runner.transcribe({ ...BASE, options: { antiCorruption: true, threads: 8 } });

  const expected = ['-m', BASE.modelPath, '-f', BASE.wavPath, '-t', '8', '-l', 'en', '--no-timestamps',
    '-mc', '0', '--temperature', '0.4', '--entropy-thold', '1.8'];
  assert(JSON.stringify(calls[0].args) === JSON.stringify(expected),
    `anti-corruption args changed: ${calls[0].args.join(' ')}`);
});

test('outputJson-only job args are unchanged (no DTW flags)', async () => {
  const { spawn, calls } = captureSpawn();
  const runner = makeRunner({ spawn });

  const result = await runner.transcribe({ ...BASE, options: { outputJson: true } });

  const expected = ['-m', BASE.modelPath, '-f', BASE.wavPath, '-t', '4', '-l', 'en', '--output-json-full', '-of', BASE.jsonPrefix];
  assert(JSON.stringify(calls[0].args) === JSON.stringify(expected),
    `outputJson args changed: ${calls[0].args.join(' ')}`);
  assert(result.dtw.requested === false, 'outputJson-only job should not request DTW');
});

test('tdrz model does not request DTW', async () => {
  const { spawn } = captureSpawn();
  const runner = makeRunner({ spawn });
  const result = await runner.transcribe({ ...BASE, modelSpec: TDRZ_SPEC, options: { diarization: true, dtw: true } });
  assert(result.dtw.requested === false, 'tdrz should not request DTW');
});

test('DTW support is checked for the executable that will run (vulkan)', async () => {
  const { spawn, calls } = captureSpawn();
  const asked = [];
  const runner = makeRunner({
    spawn,
    capabilities: {
      getActiveBackend: () => 'vulkan',
      isDtwSupported: (b) => { asked.push(b); return b !== 'vulkan'; },
    },
  });

  const result = await runner.transcribe({ ...BASE, options: { diarization: true, dtw: true } });

  assert(calls[0].cmd.includes('vulkan'), 'vulkan binary should run');
  assert(asked[0] === 'vulkan', `support should be asked for vulkan, got ${asked.join(',')}`);
  assert(!calls[0].args.includes('--dtw'), 'unsupported backend should get no --dtw');
  assert(!calls[0].args.includes('--no-flash-attn'), 'unsupported backend should get no --no-flash-attn');
  assert(result.dtw.requested === true, 'DTW was still requested by the job');
  assert(result.dtw.disabledReason && /vulkan/.test(result.dtw.disabledReason),
    `disabledReason should name vulkan, got ${result.dtw.disabledReason}`);
});

test('helpers: strip removes both DTW flags; warning finder matches the flash_attn line', () => {
  const stripped = _stripDtwArgs(['-m', 'x', '--dtw', 'tiny.en', '--no-flash-attn', '-t', '4']);
  assert(JSON.stringify(stripped) === JSON.stringify(['-m', 'x', '-t', '4']), `got ${stripped.join(' ')}`);
  assert(_findDtwDisableWarning('foo\n' + FLASH_WARNING + 'bar\n') === FLASH_WARNING.trim(), 'flash_attn warning');
  assert(_findDtwDisableWarning('aheads: dtw requested but model lacks heads - disabling dtw\n'), 'generic dtw disabling line');
  assert(_findDtwDisableWarning('whisper_init: dtw = 1\nflash attn = 0\n') === null, 'param dump is not a warning');
  const args = _buildWhisperArgs('m', 'w', 'p', { diarization: true, dtw: true }, MODEL_SPEC, () => true);
  assert(count(args, '--no-flash-attn') === 1, 'builder adds --no-flash-attn once');
});

// --- DTW stderr warning tests ---

console.log('\nDTW stderr warning tests\n');

test('stderr flash_attn disable warning sets dtw.disabledReason and does not retry', async () => {
  let spawnCount = 0;
  const logs = [];
  const spawn = function (cmd, args, opts) {
    spawnCount++;
    // Warning split across two chunks, still exits 0.
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    process.nextTick(() => {
      proc.stderr.emit('data', Buffer.from(FLASH_WARNING.slice(0, 40)));
      proc.stderr.emit('data', Buffer.from(FLASH_WARNING.slice(40)));
      proc.stdout.emit('data', Buffer.from('text\n'));
      proc.emit('close', 0);
    });
    return proc;
  };
  const runner = makeRunner({ spawn, log: (m) => logs.push(m) });

  const result = await runner.transcribe({ ...BASE, options: { diarization: true, dtw: true } });

  assert(spawnCount === 1, `expected no retry, got ${spawnCount} spawns`);
  assert(result.output === 'text', `output should be kept, got '${result.output}'`);
  assert(result.dtw.requested === true, 'DTW requested');
  assert(result.dtw.disabledReason && result.dtw.disabledReason.includes('not supported with flash_attn'),
    `disabledReason should quote the warning, got ${result.dtw.disabledReason}`);
  assert(logs.some(l => l.startsWith('[DTW]')), 'should log a [DTW] line');
});

test('stderr warning on a non-DTW job is ignored', async () => {
  const runner = makeRunner({ spawn: makeSpawn({ stdout: 'x\n', stderr: FLASH_WARNING, code: 0 }) });
  const result = await runner.transcribe({ ...BASE });
  assert(result.dtw.disabledReason === null, 'plain job should not report a DTW reason');
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
    options: { diarization: true, dtw: true },
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
    options: { diarization: true, dtw: true },
    onProgress: () => {},
  });

  assert(dtwDisabled, 'DTW should be disabled after error');
  assert(!secondCallArgs.includes('--dtw'), 'retry should strip --dtw');
  assert(!secondCallArgs.includes('tiny.en'), 'retry should strip the preset');
  assert(!secondCallArgs.includes('--no-flash-attn'), 'retry should strip --no-flash-attn');
  assert(secondCallArgs.includes('--output-json-full'), 'retry keeps JSON output');
  assert(result.output === 'retry result', `expected 'retry result', got '${result.output}'`);
  assert(result.dtw.requested === true && result.dtw.disabledReason,
    `retry path should set disabledReason, got ${JSON.stringify(result.dtw)}`);
});

test('DTW error on GPU retries on the same GPU binary and disables DTW only for vulkan', async () => {
  const calls = [];
  const disabled = [];
  let gpuDisabled = false;
  const spawn = function (cmd, args, opts) {
    calls.push({ cmd, args: [...args] });
    if (calls.length === 1) return failingProc('error: unknown DTW preset: tiny.en\n');
    return makeSpawn({ stdout: 'retry result\n', stderr: '', code: 0 })(cmd, args, opts);
  };
  const runner = makeRunner({
    spawn,
    capabilities: {
      getActiveBackend: () => 'vulkan',
      disableDtw: (b) => { disabled.push(b); },
      disableGpu: () => { gpuDisabled = true; },
    },
  });

  const result = await runner.transcribe({ ...BASE, options: { diarization: true, dtw: true } });

  assert(calls.length === 2, `expected 2 spawns, got ${calls.length}`);
  assert(calls[1].cmd.includes('vulkan'), 'DTW retry should stay on the vulkan binary');
  assert(!calls[1].args.includes('--dtw') && !calls[1].args.includes('--no-flash-attn'),
    'retry should strip both DTW flags');
  assert(JSON.stringify(disabled) === JSON.stringify(['vulkan']), `disableDtw should get only vulkan, got ${disabled}`);
  assert(!gpuDisabled, 'a DTW error should not disable the GPU');
  assert(result.backend === 'vulkan', `backend should stay vulkan, got ${result.backend}`);
  assert(result.dtw.disabledReason, 'disabledReason should be set');
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
      options: { diarization: true, dtw: true },
      onProgress: () => {},
    });
    assert(false, 'should have thrown');
  } catch (err) {
    assert(err.message.includes('DTW preset'), `expected DTW error, got '${err.message}'`);
  }
});

// --- GPU fallback tests ---

console.log('\nGPU fallback tests\n');

test('GPU failure falls back to CPU with DTW args recomputed for CPU (CPU supports DTW)', async () => {
  const calls = [];
  const spawn = function (cmd, args, opts) {
    calls.push({ cmd, args: [...args] });
    if (cmd.includes('vulkan')) return failingProc('ggml_vulkan: device lost\n');
    return makeSpawn({ stdout: 'cpu result\n', stderr: '', code: 0 })(cmd, args, opts);
  };
  const runner = makeRunner({
    spawn,
    capabilities: { getActiveBackend: () => 'vulkan', isDtwSupported: (b) => b === 'cpu' },
  });

  const result = await runner.transcribe({ ...BASE, options: { diarization: true, dtw: true } });

  assert(!calls[0].args.includes('--dtw'), 'vulkan run should have no DTW flags');
  assert(calls[1].cmd.includes('/cpu/'), 'second run should use CPU binary');
  assert(count(calls[1].args, '--dtw') === 1 && count(calls[1].args, '--no-flash-attn') === 1,
    `CPU run should get DTW flags: ${calls[1].args.join(' ')}`);
  assert(result.backend === 'cpu', 'backend should be cpu');
  assert(result.dtw.disabledReason === null, `DTW ran on CPU, got ${result.dtw.disabledReason}`);
});

test('GPU failure falls back to CPU and drops DTW args when CPU lacks DTW', async () => {
  const calls = [];
  const spawn = function (cmd, args, opts) {
    calls.push({ cmd, args: [...args] });
    if (cmd.includes('vulkan')) return failingProc('ggml_vulkan: device lost\n');
    return makeSpawn({ stdout: 'cpu result\n', stderr: '', code: 0 })(cmd, args, opts);
  };
  const runner = makeRunner({
    spawn,
    capabilities: { getActiveBackend: () => 'vulkan', isDtwSupported: (b) => b === 'vulkan' },
  });

  const result = await runner.transcribe({ ...BASE, options: { diarization: true, dtw: true } });

  assert(calls[0].args.includes('--dtw') && calls[0].args.includes('--no-flash-attn'), 'vulkan run had DTW');
  assert(!calls[1].args.includes('--dtw') && !calls[1].args.includes('--no-flash-attn'),
    `CPU run should drop DTW flags: ${calls[1].args.join(' ')}`);
  assert(result.backend === 'cpu', 'backend should be cpu');
  assert(result.dtw.disabledReason && /cpu/.test(result.dtw.disabledReason),
    `disabledReason should name cpu, got ${result.dtw.disabledReason}`);
});

test('GPU failure + CPU fallback failure rethrows the original error', async () => {
  const spawn = function (cmd) {
    if (cmd.includes('vulkan')) return failingProc('ORIGINAL vulkan failure\n');
    return failingProc('second cpu failure\n');
  };
  const runner = makeRunner({ spawn, capabilities: { getActiveBackend: () => 'vulkan' } });
  try {
    await runner.transcribe({ ...BASE, options: { diarization: true, dtw: true } });
    assert(false, 'should have thrown');
  } catch (err) {
    assert(err.message.includes('ORIGINAL vulkan failure'), `expected original error, got '${err.message}'`);
  }
});

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

test('Cancellation mid-run on a diarised GPU job never retries', async () => {
  let spawnCount = 0;
  const spawn = function () { spawnCount++; return hangingProc(); };
  const controller = new AbortController();
  const runner = makeRunner({ spawn, capabilities: { getActiveBackend: () => 'vulkan' } });

  const promise = runner.transcribe({ ...BASE, options: { diarization: true, dtw: true }, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();

  try {
    await promise;
    assert(false, 'should have thrown');
  } catch (err) {
    assert(err.message === 'Cancelled', `expected 'Cancelled', got '${err.message}'`);
  }
  assert(spawnCount === 1, `expected 1 spawn, got ${spawnCount}`);
});

test('Cancellation during DTW retry throws Cancelled with no further fallback', async () => {
  let spawnCount = 0;
  const spawn = function () {
    spawnCount++;
    if (spawnCount === 1) return failingProc('error: unknown DTW preset: tiny.en\n');
    return hangingProc();
  };
  const controller = new AbortController();
  const runner = makeRunner({ spawn, capabilities: { getActiveBackend: () => 'vulkan' } });

  const promise = runner.transcribe({ ...BASE, options: { diarization: true, dtw: true }, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();

  try {
    await promise;
    assert(false, 'should have thrown');
  } catch (err) {
    assert(err.message === 'Cancelled', `expected 'Cancelled', got '${err.message}'`);
  }
  assert(spawnCount === 2, `expected 2 spawns (no GPU fallback after cancel), got ${spawnCount}`);
});

test('early split DTW and OOM evidence survives a large diagnostic tail', async () => {
  for (const failure of ['unknown DTW preset: tiny.en', 'OutOfDeviceMemory', 'failed to allocate']) {
    let calls = 0;
    let gpuDisabled = false;
    let dtwDisabled = false;
    const spawn = (cmd, args, opts) => {
      calls++;
      if (calls > 1) return makeSpawn()(cmd, args, opts);
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
      process.nextTick(() => {
        for (const part of [failure.slice(0, 4), failure.slice(4), '\n', ...Array(100).fill('later diagnostics '.repeat(100) + '\n')]) {
          proc.stderr.emit('data', Buffer.from(part));
        }
        proc.emit('close', 1);
      });
      return proc;
    };
    const runner = makeRunner({ spawn, capabilities: {
      getActiveBackend: () => 'vulkan',
      disableGpu: () => { gpuDisabled = true; },
      disableDtw: () => { dtwDisabled = true; },
    } });
    const result = await runner.transcribe({ ...BASE, options: { diarization: true, dtw: true } });
    assert(calls === 2, 'must retry once');
    if (failure.includes('DTW')) {
      assert(dtwDisabled && result.backend === 'vulkan', 'early DTW error must keep its retry policy');
    } else {
      assert(!gpuDisabled && result.backend === 'cpu', 'early OOM must keep GPU enabled');
    }
  }
});

test('early DTW warning survives many later chunks on successful exit', async () => {
  const spawn = () => {
    const proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    process.nextTick(() => {
      proc.stderr.emit('data', Buffer.from(FLASH_WARNING.slice(0, 35)));
      proc.stderr.emit('data', Buffer.from(FLASH_WARNING.slice(35)));
      for (let i = 0; i < 100; i++) proc.stderr.emit('data', Buffer.from('later '.repeat(300) + '\n'));
      proc.emit('close', 0);
    });
    return proc;
  };
  const result = await makeRunner({ spawn }).transcribe({ ...BASE, options: { diarization: true, dtw: true } });
  assert(result.dtw.disabledReason.includes('disabled DTW'), 'warning must survive');
});

test('standalone JSON calls have unique owned paths and idempotent cleanup', async () => {
  const spawn = (cmd, args, opts) => {
    const prefix = args[args.indexOf('-of') + 1];
    fs.writeFileSync(`${prefix}.json`, '{}');
    return makeSpawn()(cmd, args, opts);
  };
  const runner = makeRunner({ spawn });
  const results = await Promise.all([1, 2].map(() => runner.transcribe({ ...BASE, jsonPrefix: undefined, options: { outputJson: true } })));
  assert(results[0].jsonPath !== results[1].jsonPath, 'paths must be unique');
  for (const result of results) {
    assert(fs.existsSync(result.jsonPath), 'JSON must remain retrievable');
    await Promise.all([result.cleanup(), result.cleanup()]);
    assert(!fs.existsSync(path.dirname(result.jsonPath)), 'private directory must be removed');
  }
});

test('caller JSON survives cleanup and failure; private no-JSON and failure work is removed', async () => {
  const callerDir = fs.mkdtempSync(path.join(testTmp, 'caller-'));
  const prefix = path.join(callerDir, 'output');
  fs.writeFileSync(`${prefix}.json`, '{}');
  const result = await makeRunner().transcribe({ ...BASE, jsonPrefix: prefix, options: { outputJson: true } });
  await result.cleanup();
  assert(fs.existsSync(`${prefix}.json`), 'caller output must survive cleanup');
  try { await makeRunner({ spawn: () => failingProc('failure') }).transcribe({ ...BASE, jsonPrefix: prefix }); } catch (_) {}
  assert(fs.existsSync(`${prefix}.json`), 'caller output must survive failure');
  const before = fs.readdirSync(testTmp).sort().join();
  await makeRunner().transcribe({ ...BASE, jsonPrefix: undefined });
  try { await makeRunner({ spawn: () => failingProc('failure') }).transcribe({ ...BASE, jsonPrefix: undefined }); } catch (_) {}
  assert(fs.readdirSync(testTmp).sort().join() === before, 'private work must be removed');
});

// ---------------------------------------------------------------------------

runAll();
