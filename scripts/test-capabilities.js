#!/usr/bin/env node
/**
 * Tests for lib/capabilities.js
 *
 * Covers: CPU fallback when Vulkan binary missing, preference override,
 * DTW probe caching, Python detection caching. Follows the same plain-node
 * style as scripts/test-merge.js (no test framework).
 *
 * Usage:
 *     node scripts/test-capabilities.js
 */

const Capabilities = require('../lib/capabilities');

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

function makePaths(overrides = {}) {
  return {
    getWhisperBinary: (backend) => `/fake/bin/linux/${backend}/whisper-cli`,
    getFfmpegBinary: () => '/fake/bin/linux/ffmpeg',
    makeEnvWithLibPath: (dir) => ({ PATH: '/usr/bin' }),
    ...overrides,
  };
}

function makeSpawn(behaviour = {}) {
  return function (cmd, args, opts) {
    const key = behaviour._keyFor ? behaviour._keyFor(cmd, args) : 'default';
    const entry = behaviour[key] || behaviour.default;
    if (typeof entry === 'function') return entry(cmd, args, opts);
    if (entry instanceof Error) {
      const proc = new (require('events').EventEmitter)();
      proc.stdout = new (require('events').EventEmitter)();
      proc.stderr = new (require('events').EventEmitter)();
      process.nextTick(() => proc.emit('error', entry));
      return proc;
    }
    // Default: succeed with no output
    return makeSuccessfulSpawn(entry);
  };
}

function makeSuccessfulSpawn(stderrText) {
  const { EventEmitter } = require('events');
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  process.nextTick(() => {
    if (stderrText) proc.stderr.emit('data', Buffer.from(stderrText));
    proc.emit('close', 0);
  });
  return proc;
}

// ---------------------------------------------------------------------------
// Tests: GPU detection
// ---------------------------------------------------------------------------

console.log('GPU detection tests\n');

test('CPU fallback when Vulkan binary missing', async () => {
  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: (p) => p.includes('/cpu/') && !p.includes('/vulkan/'),
    logWrite: () => {},
  });
  await caps.detect();
  const status = caps.getStatus();
  assert(status.detected === 'cpu', `expected cpu, got ${status.detected}`);
  assert(status.backend === 'cpu', `backend should be cpu, got ${status.backend}`);
  assert(status.available.length === 1 && status.available[0] === 'cpu',
    `expected only cpu available, got ${status.available}`);
});

test('Vulkan detected when binary exists and devices reported', async () => {
  const stderr = `
ggml_vulkan: 0 = NVIDIA GeForce RTX 3060 (driver 535.xx) | uma: 0 | fp16: 1 | warp size: 32
  `;
  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: () => true,
    spawn: makeSpawn({ default: stderr }),
    logWrite: () => {},
  });
  await caps.detect();
  const status = caps.getStatus();
  assert(status.detected === 'vulkan', `expected vulkan, got ${status.detected}`);
  assert(status.deviceName === 'NVIDIA GeForce RTX 3060', `expected device name, got ${status.deviceName}`);
  assert(status.available.includes('vulkan'), 'vulkan should be available');
});

test('Intel GPU falls back to CPU', async () => {
  const stderr = `
ggml_vulkan: 0 = Intel(R) UHD Graphics 630 (driver 31.0) | uma: 1 | fp16: 1 | warp size: 32
  `;
  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: () => true,
    spawn: makeSpawn({ default: stderr }),
    logWrite: () => {},
  });
  await caps.detect();
  const status = caps.getStatus();
  assert(status.detected === 'cpu', `expected cpu fallback for Intel, got ${status.detected}`);
});

test('Vulkan spawn failure falls back to CPU', async () => {
  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: () => true,
    spawn: makeSpawn({ default: new Error('ENOENT') }),
    logWrite: () => {},
  });
  await caps.detect();
  const status = caps.getStatus();
  assert(status.detected === 'cpu', `expected cpu after spawn failure, got ${status.detected}`);
});

test('preference override: setting cpu overrides detected vulkan', async () => {
  const stderr = 'ggml_vulkan: 0 = NVIDIA GeForce RTX 3060 | uma: 0 | fp16: 1 | warp size: 32';
  let stored = {};
  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: () => true,
    spawn: makeSpawn({ default: stderr }),
    logWrite: () => {},
    getPreference: (key) => stored[key],
    setPreference: (key, value) => { stored[key] = value; },
  });
  await caps.detect();
  assert(caps.getActiveBackend() === 'vulkan', 'should detect vulkan initially');

  caps.setBackendPreference('cpu');
  assert(caps.getActiveBackend() === 'cpu', 'cpu preference should override detection');
  assert(stored.gpuBackend === 'cpu', 'preference should be persisted');
});

test('preference override: auto respects detection', async () => {
  const stderr = 'ggml_vulkan: 0 = NVIDIA GeForce RTX 3060 | uma: 0 | fp16: 1 | warp size: 32';
  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: () => true,
    spawn: makeSpawn({ default: stderr }),
    logWrite: () => {},
    getPreference: () => 'auto',
  });
  await caps.detect();
  assert(caps.getActiveBackend() === 'vulkan', 'auto should use detected vulkan');

  caps.setBackendPreference('auto');
  assert(caps.getActiveBackend() === 'vulkan', 'still vulkan after auto');
});

test('setBackendPreference rejects invalid values', () => {
  const caps = new Capabilities({ paths: makePaths(), fsExists: () => true, logWrite: () => {} });
  assert(caps.setBackendPreference('invalid') === false, 'invalid backend should return false');
  assert(caps.setBackendPreference('vulkan') === true, 'valid backend should return true');
});

// ---------------------------------------------------------------------------
// Tests: DTW detection
// ---------------------------------------------------------------------------

console.log('\nDTW detection tests\n');

test('DTW supported when --dtw flag present in help output', async () => {
  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: () => true,
    spawn: makeSpawn({ default: '  --dtw         enable DTW alignment\n' }),
    logWrite: () => {},
  });

  // Before detection, isDtwSupported should be optimistic
  assert(caps.isDtwSupported() === true, 'should be optimistic before probe');

  await caps.detect();
  assert(caps.isDtwSupported() === true, 'DTW should be supported when --dtw flag present');
});

test('DTW not supported when --dtw flag absent', async () => {
  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: () => true,
    spawn: makeSpawn({ default: '  --no-timestamps    do not print timestamps\n' }),
    logWrite: () => {},
  });
  await caps.detect();
  assert(caps.isDtwSupported() === false, 'DTW should not be supported');
});

test('DTW probe failure defaults to unsupported', async () => {
  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: () => true,
    spawn: makeSpawn({ default: new Error('spawn failed') }),
    logWrite: () => {},
  });
  await caps.detect();
  assert(caps.isDtwSupported() === false, 'DTW should be false after probe failure');
});

test('disableDtw sets supported to false after session', async () => {
  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: () => true,
    spawn: makeSpawn({ default: '  --dtw   DTW alignment\n' }),
    logWrite: () => {},
  });
  await caps.detect();
  assert(caps.isDtwSupported() === true, 'initially supported');
  caps.disableDtw();
  assert(caps.isDtwSupported() === false, 'disabled after call');
});

// ---------------------------------------------------------------------------
// Tests: Python detection
// ---------------------------------------------------------------------------

console.log('\nPython detection tests\n');

test('Python detection caches after first call', async () => {
  let runCalls = 0;
  const spawnCalls = [];

  // Capture calls per command for assertion
  const trackingSpawn = function (cmd, args, opts) {
    spawnCalls.push({ cmd, args: [...args] });
    runCalls++;

    const proc = new (require('events').EventEmitter)();
    proc.stdout = new (require('events').EventEmitter)();
    proc.stderr = new (require('events').EventEmitter)();

    const argStr = args.join(' ');
    if (argStr.includes('--version')) {
      // Return valid Python 3.11
      process.nextTick(() => {
        proc.stdout.emit('data', Buffer.from('Python 3.11.5\n'));
        proc.emit('close', 0);
      });
    } else if (argStr.includes('pyannote.audio')) {
      process.nextTick(() => {
        proc.stdout.emit('data', Buffer.from('3.1.0\n'));
        proc.emit('close', 0);
      });
    } else if (argStr.includes('torch.cuda.is_available')) {
      process.nextTick(() => {
        proc.stdout.emit('data', Buffer.from('True\n'));
        proc.emit('close', 0);
      });
    } else {
      process.nextTick(() => proc.emit('close', 0));
    }
    return proc;
  };

  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: () => true,
    spawn: trackingSpawn,
    logWrite: () => {},
  });

  const info1 = await caps.getPythonInfo();
  assert(info1.pythonFound === true, 'python should be found');
  assert(info1.pythonVersion === '3.11.5', `expected 3.11.5, got ${info1.pythonVersion}`);
  assert(info1.pyannoteInstalled === true, 'pyannote should be installed');
  assert(info1.pyannoteVersion === '3.1.0', `expected 3.1.0, got ${info1.pyannoteVersion}`);
  assert(info1.gpuAvailable === true, 'GPU should be available');

  const callsAfterFirst = runCalls;
  const info2 = await caps.getPythonInfo();
  assert(runCalls === callsAfterFirst, `cached result should not re-run probes (calls: ${runCalls})`);
  assert(info2.pythonFound === true, 'cached result should match');
  assert(info2.pythonVersion === '3.11.5', 'cached version should match');
});

test('Python not found returns empty info', async () => {
  let spawned = false;
  const noPythonSpawn = function (cmd, args, opts) {
    spawned = true;
    const proc = new (require('events').EventEmitter)();
    proc.stdout = new (require('events').EventEmitter)();
    proc.stderr = new (require('events').EventEmitter)();
    process.nextTick(() => proc.emit('error', new Error('ENOENT')));
    return proc;
  };

  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: () => true,
    spawn: noPythonSpawn,
    logWrite: () => {},
  });

  // Override _findPython to skip actual probing (we already test spawn)
  // Actually, _findPython uses the injected spawn, so it'll fail with ENOENT
  const info = await caps.getPythonInfo();
  assert(info.pythonFound === false, 'python should not be found');
  assert(info.pyannoteInstalled === false, 'pyannote should not be installed');
  assert(info.gpuAvailable === false, 'GPU should not be available');
});

test('Python found but pyannote not installed', async () => {
  const partialSpawn = function (cmd, args, opts) {
    const proc = new (require('events').EventEmitter)();
    proc.stdout = new (require('events').EventEmitter)();
    proc.stderr = new (require('events').EventEmitter)();

    const argStr = args.join(' ');
    if (argStr.includes('--version')) {
      process.nextTick(() => {
        proc.stdout.emit('data', Buffer.from('Python 3.10.12\n'));
        proc.emit('close', 0);
      });
    } else if (argStr.includes('pyannote.audio')) {
      process.nextTick(() => proc.emit('close', 1)); // import fails
    } else if (argStr.includes('torch.cuda.is_available')) {
      process.nextTick(() => {
        proc.stdout.emit('data', Buffer.from('False\n'));
        proc.emit('close', 0);
      });
    } else {
      process.nextTick(() => proc.emit('close', 0));
    }
    return proc;
  };

  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: () => true,
    spawn: partialSpawn,
    logWrite: () => {},
  });

  const info = await caps.getPythonInfo();
  assert(info.pythonFound === true, 'python found');
  assert(info.pythonVersion === '3.10.12', 'version correct');
  assert(info.pyannoteInstalled === false, 'pyannote not installed');
  assert(info.pyannoteVersion === null, 'pyannote version null');
  assert(info.gpuAvailable === false, 'GPU not available');
});

test('getPythonCommand returns cached python command', async () => {
  let callCount = 0;
  const spawnPy = function (cmd, args, opts) {
    const proc = new (require('events').EventEmitter)();
    proc.stdout = new (require('events').EventEmitter)();
    proc.stderr = new (require('events').EventEmitter)();
    if (cmd === 'python3') {
      callCount++;
      process.nextTick(() => {
        proc.stdout.emit('data', Buffer.from('Python 3.11.0\n'));
        proc.emit('close', 0);
      });
    } else {
      process.nextTick(() => proc.emit('error', new Error('ENOENT')));
    }
    return proc;
  };

  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: () => true,
    spawn: spawnPy,
    logWrite: () => {},
  });

  const cmd1 = await caps.getPythonCommand();
  assert(cmd1 === 'python3', `expected python3, got ${cmd1}`);
  const cmd2 = await caps.getPythonCommand();
  assert(cmd2 === 'python3', 'cached result should match');
  assert(callCount === 1, `python spawn should only be called once, got ${callCount}`);
});

// ---------------------------------------------------------------------------
// Tests: getStatus availability
// ---------------------------------------------------------------------------

console.log('\ngetStatus tests\n');

test('getStatus reports vulkan available when binary exists', () => {
  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: () => true,
    logWrite: () => {},
  });
  const status = caps.getStatus();
  assert(status.available.includes('vulkan'), 'vulkan should be in available');
  assert(status.available.includes('cpu'), 'cpu should be in available');
  assert(status.available.length === 2, 'both backends available');
});

test('getStatus reports only cpu when vulkan binary missing', () => {
  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: (p) => !p.includes('vulkan'),
    logWrite: () => {},
  });
  const status = caps.getStatus();
  assert(!status.available.includes('vulkan'), 'vulkan should not be available');
  assert(status.available.length === 1 && status.available[0] === 'cpu', 'only cpu');
});

// ---------------------------------------------------------------------------

runAll();
