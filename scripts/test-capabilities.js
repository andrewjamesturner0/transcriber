#!/usr/bin/env node
/**
 * Tests for lib/capabilities.js
 *
 * Covers: CPU fallback when Vulkan binary missing, preference override,
 * per-backend DTW probing, Python detection caching, TRANSCRIBER_PYTHON, and
 * mapping of `lib/diarize.py --check` output. Follows the same plain-node
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

test('GPU status can wait for the shared detection probe', async () => {
  const { EventEmitter } = require('events');
  let vulkanProc;
  let vulkanSpawnCount = 0;
  const delayedSpawn = function (cmd) {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();

    if (cmd.includes('/vulkan/')) {
      vulkanSpawnCount++;
      vulkanProc = proc;
    } else {
      process.nextTick(() => proc.emit('close', 0));
    }
    return proc;
  };
  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: () => true,
    spawn: delayedSpawn,
    logWrite: () => {},
  });

  const firstProbe = caps.detectGpu();
  const secondProbe = caps.detectGpu();
  assert(firstProbe === secondProbe, 'concurrent callers should share one GPU probe');
  assert(caps.getStatus().backend === 'cpu', 'backend is unresolved while the probe runs');

  vulkanProc.stderr.emit('data', Buffer.from(
    'ggml_vulkan: 0 = NVIDIA GeForce RTX 3060 (driver 535.xx) | uma: 0\n'
  ));
  vulkanProc.emit('close', 0);
  await firstProbe;

  assert(vulkanSpawnCount === 1, `GPU probe should run once, got ${vulkanSpawnCount}`);
  assert(caps.getStatus().backend === 'vulkan', 'backend should be Vulkan after awaiting detection');
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

const DTW_HELP = '  -dtw MODEL --dtw MODEL  compute token-level timestamps\n'
  + '  -nfa,      --no-flash-attn  disable flash attention\n';

test('DTW supported when --dtw and --no-flash-attn present in help output', async () => {
  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: () => true,
    spawn: makeSpawn({ default: DTW_HELP }),
    logWrite: () => {},
  });

  // Before detection, isDtwSupported should be optimistic
  assert(caps.isDtwSupported() === true, 'should be optimistic before probe');

  await caps.detect();
  assert(caps.isDtwSupported() === true, 'DTW should be supported when both flags present');
  assert(caps.isDtwSupported('vulkan') === true, 'vulkan DTW should be supported too');
});

test('DTW not supported when --dtw present but --no-flash-attn absent', async () => {
  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: () => true,
    spawn: makeSpawn({ default: '  --dtw         enable DTW alignment\n' }),
    logWrite: () => {},
  });
  await caps.detect();
  assert(caps.isDtwSupported() === false, 'DTW needs --no-flash-attn as well');
  assert(caps.isDtwSupported('vulkan') === false, 'vulkan DTW needs --no-flash-attn as well');
});

test('DTW supported when only the short -nfa form is listed', async () => {
  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: () => true,
    spawn: makeSpawn({ default: '  --dtw MODEL  token timestamps\n  -nfa  disable flash attention\n' }),
    logWrite: () => {},
  });
  await caps.detect();
  assert(caps.isDtwSupported('cpu') === true, '-nfa should count as --no-flash-attn');
});

test('DTW probe checks cpu and vulkan binaries, each with its own lib path env', async () => {
  const { EventEmitter } = require('events');
  const helpCalls = [];
  const spawn = function (cmd, args, opts) {
    if (args.includes('--help')) helpCalls.push({ cmd, opts });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    // CPU binary supports both flags; Vulkan binary lacks --no-flash-attn.
    const text = cmd.includes('/cpu/') ? DTW_HELP : '  --dtw MODEL  token timestamps\n';
    process.nextTick(() => {
      proc.stderr.emit('data', Buffer.from(text));
      proc.emit('close', 0);
    });
    return proc;
  };
  const caps = new Capabilities({
    paths: makePaths({ makeEnvWithLibPath: (dir) => ({ LIBDIR: dir }) }),
    fsExists: () => true,
    spawn,
    logWrite: () => {},
  });
  const result = await caps.detectDtw();
  const cpuCall = helpCalls.find(c => c.cmd === '/fake/bin/linux/cpu/whisper-cli');
  const vkCall = helpCalls.find(c => c.cmd === '/fake/bin/linux/vulkan/whisper-cli');
  assert(cpuCall, 'cpu binary should be probed');
  assert(vkCall, 'vulkan binary should be probed');
  assert(cpuCall.opts.env && cpuCall.opts.env.LIBDIR === '/fake/bin/linux/cpu', 'cpu probe needs cpu lib path env');
  assert(vkCall.opts.env && vkCall.opts.env.LIBDIR === '/fake/bin/linux/vulkan', 'vulkan probe needs vulkan lib path env');
  assert(cpuCall.opts.timeout > 0 && vkCall.opts.timeout > 0, 'probes keep their timeout');
  assert(result.cpu === true && result.vulkan === false, `unexpected result ${JSON.stringify(result)}`);
  assert(caps.isDtwSupported('cpu') === true, 'cpu supported');
  assert(caps.isDtwSupported('vulkan') === false, 'vulkan unsupported');
  assert(caps.isDtwSupported() === true, 'no-arg call reports cpu');
});

test('DTW probe skips vulkan when its binary is missing', async () => {
  const probed = [];
  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: (p) => !p.includes('/vulkan/'),
    spawn: (cmd, args, opts) => { probed.push(cmd); return makeSuccessfulSpawn(DTW_HELP); },
    logWrite: () => {},
  });
  const result = await caps.detectDtw();
  assert(!probed.some(c => c.includes('/vulkan/')), 'vulkan binary should not be probed');
  assert(result.cpu === true && result.vulkan === null, `unexpected result ${JSON.stringify(result)}`);
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
    spawn: makeSpawn({ default: DTW_HELP }),
    logWrite: () => {},
  });
  await caps.detect();
  assert(caps.isDtwSupported() === true, 'initially supported');
  caps.disableDtw();
  assert(caps.isDtwSupported() === false, 'disabled after call');
  assert(caps.isDtwSupported('vulkan') === false, 'no-arg disableDtw disables every backend');
});

test('disableDtw(backend) disables only that backend', async () => {
  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: () => true,
    spawn: makeSpawn({ default: DTW_HELP }),
    logWrite: () => {},
  });
  await caps.detectDtw();
  caps.disableDtw('vulkan');
  assert(caps.isDtwSupported('vulkan') === false, 'vulkan disabled');
  assert(caps.isDtwSupported('cpu') === true, 'cpu still supported');
});

test('getStatus reports DTW support for the active backend and per backend', async () => {
  const caps = new Capabilities({
    paths: makePaths(),
    fsExists: () => true,
    spawn: makeSpawn({ default: DTW_HELP }),
    logWrite: () => {},
  });
  await caps.detectDtw();
  caps.setBackendPreference('vulkan');
  caps.disableDtw('vulkan');
  let status = caps.getStatus();
  assert(status.backend === 'vulkan', 'vulkan active');
  assert(status.dtwSupported === false, 'active backend dtwSupported should follow vulkan');
  assert(status.dtwSupport.cpu === true && status.dtwSupport.vulkan === false,
    `unexpected dtwSupport ${JSON.stringify(status.dtwSupport)}`);
  caps.setBackendPreference('cpu');
  status = caps.getStatus();
  assert(status.dtwSupported === true, 'active backend dtwSupported should follow cpu');
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
// Tests: diarize.py --check probe and TRANSCRIBER_PYTHON
// ---------------------------------------------------------------------------

console.log('\nDiarization check tests\n');

const SCRIPT = '/fake/res/lib/diarize.py';

function makeCheckPaths() {
  return makePaths({ getResourcePath: (rel) => '/fake/res/' + rel.split(require('path').sep).join('/') });
}

function checkJson(overrides = {}) {
  return JSON.stringify({
    status: 'ready',
    message: 'Speaker diarization is ready.',
    versions: { python: '3.12.3', 'pyannote.audio': '4.0.7', torch: '2.8.0+cu128' },
    pythonSupported: true,
    pyannoteSupported: true,
    cudaAvailable: true,
    model: { id: 'pyannote/speaker-diarization-community-1', revision: '3533c8cf8e369892e6b79ff1bf80f7b0286a54ee' },
    modelReady: true,
    modelPath: '/home/u/.cache/huggingface/hub/x',
    loadChecked: false,
    ...overrides,
  });
}

/**
 * Spawn mock for Python probes. `runnable` lists commands that exist;
 * `version` is the --version output; `check` is the --check stdout (string),
 * an exit code (number) or an Error; `pyannote`/`torch` answer the legacy
 * -c probes (string stdout, or null for an import failure).
 */
function makePythonSpawn({ runnable = ['python3'], version = 'Python 3.12.3\n', check, pyannote = null, torch = 'False' } = {}) {
  const { EventEmitter } = require('events');
  const calls = [];
  const spawn = function (cmd, args, opts) {
    calls.push({ cmd, args: [...args], opts });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    const finish = (stdout, code = 0) => process.nextTick(() => {
      if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
      proc.emit('close', code);
    });
    if (!runnable.includes(cmd)) {
      process.nextTick(() => proc.emit('error', new Error('ENOENT')));
      return proc;
    }
    const argStr = args.join(' ');
    if (args.includes('--version')) finish(version);
    else if (args.includes('--check')) {
      if (check instanceof Error) process.nextTick(() => proc.emit('error', check));
      else if (typeof check === 'number') finish('', check);
      else finish(check);
    } else if (argStr.includes('pyannote.audio')) {
      if (pyannote === null) finish('', 1); else finish(pyannote + '\n');
    } else if (argStr.includes('torch.cuda')) {
      finish(torch + '\n');
    } else finish('');
    return proc;
  };
  return { spawn, calls };
}

function makeCaps(spawnMock, opts = {}) {
  return new Capabilities({
    paths: makeCheckPaths(),
    fsExists: opts.fsExists || (() => true),
    spawn: spawnMock.spawn,
    env: opts.env || {},
    logWrite: () => {},
  });
}

test('TRANSCRIBER_PYTHON is used instead of the PATH search, for probes and jobs', async () => {
  const py = '/opt/venv/bin/python';
  const mock = makePythonSpawn({ runnable: [py, 'python3'], check: checkJson() });
  const caps = makeCaps(mock, { env: { TRANSCRIBER_PYTHON: py } });
  const info = await caps.getPythonInfo();
  assert(info.pythonFound === true, 'python found');
  assert(await caps.getPythonCommand() === py, 'getPythonCommand returns the override');
  const spawnInfo = await caps.getPythonSpawn();
  assert(spawnInfo.command === py && spawnInfo.args.length === 0, `unexpected spawn info ${JSON.stringify(spawnInfo)}`);
  assert(!mock.calls.some(c => c.cmd !== py), 'no other interpreter should be spawned');
  const checkCall = mock.calls.find(c => c.args.includes('--check'));
  assert(checkCall, '--check should be run');
  assert(checkCall.args[0] === SCRIPT && checkCall.args[1] === '--check', `unexpected args ${checkCall.args}`);
  assert(checkCall.opts.timeout > 0, '--check runs with a timeout');
});

test('TRANSCRIBER_PYTHON that cannot run reports not found (no PATH fallback)', async () => {
  const mock = makePythonSpawn({ runnable: ['python3'], check: checkJson() });
  const caps = makeCaps(mock, { env: { TRANSCRIBER_PYTHON: '/missing/python' } });
  const info = await caps.getPythonInfo();
  assert(info.pythonFound === false, 'python should not be found');
  assert(info.diarizationStatus === 'python-missing', `status ${info.diarizationStatus}`);
  assert(!mock.calls.some(c => c.cmd === 'python3'), 'PATH python3 must not be tried');
  assert(await caps.getPythonSpawn() === null, 'no spawn info');
});

test('py launcher given by TRANSCRIBER_PYTHON gets -3 before the script', async () => {
  const py = 'C:\\Windows\\py.exe';
  const mock = makePythonSpawn({ runnable: [py], check: checkJson() });
  const caps = makeCaps(mock, { env: { TRANSCRIBER_PYTHON: py } });
  await caps.getPythonInfo();
  const checkCall = mock.calls.find(c => c.args.includes('--check'));
  assert(checkCall.args[0] === '-3' && checkCall.args[1] === SCRIPT, `unexpected args ${checkCall.args}`);
  const spawnInfo = await caps.getPythonSpawn();
  assert(spawnInfo.args.length === 1 && spawnInfo.args[0] === '-3', 'spawn prefix should be -3');
});

test('--check JSON fills the new fields and keeps the old ones', async () => {
  const mock = makePythonSpawn({ check: 'some torch warning\n' + checkJson() + '\n' });
  const info = await makeCaps(mock).getPythonInfo();
  assert(info.pythonFound === true && info.pythonVersion === '3.12.3', 'python fields');
  assert(info.pythonSupported === true, 'python supported');
  assert(info.pyannoteInstalled === true && info.pyannoteVersion === '4.0.7', 'pyannote fields');
  assert(info.pyannoteSupported === true, 'pyannote supported');
  assert(info.gpuAvailable === true, 'gpu from cudaAvailable');
  assert(info.diarizationStatus === 'ready', `status ${info.diarizationStatus}`);
  assert(info.modelReady === true, 'model ready');
  assert(info.model.id === 'pyannote/speaker-diarization-community-1', 'model id');
  assert(info.model.revision === '3533c8cf8e369892e6b79ff1bf80f7b0286a54ee', 'model revision');
  assert(!mock.calls.some(c => c.args.join(' ').includes('import pyannote')), 'legacy probes not needed');
});

test('--check model-not-prepared is reported with its message', async () => {
  const mock = makePythonSpawn({ check: checkJson({ status: 'model-not-prepared', modelReady: false, message: 'run setup' }) });
  const info = await makeCaps(mock).getPythonInfo();
  assert(info.diarizationStatus === 'model-not-prepared', `status ${info.diarizationStatus}`);
  assert(info.modelReady === false, 'model not ready');
  assert(info.diarizationMessage === 'run setup', 'message passed through');
});

test('Python 3.9 is found but unsupported', async () => {
  const mock = makePythonSpawn({
    version: 'Python 3.9.18\n',
    check: checkJson({ status: 'python-unsupported', pythonSupported: false, versions: { python: '3.9.18', 'pyannote.audio': null, torch: null }, pyannoteSupported: false, cudaAvailable: false, modelReady: false }),
  });
  const info = await makeCaps(mock).getPythonInfo();
  assert(info.pythonFound === true, '3.9 counts as found');
  assert(info.pythonVersion === '3.9.18', 'version kept');
  assert(info.pythonSupported === false, '3.9 is not supported');
  assert(info.diarizationStatus === 'python-unsupported', `status ${info.diarizationStatus}`);
});

test('Python 3.9 without the check script is still found but unsupported', async () => {
  const mock = makePythonSpawn({ version: 'Python 3.9.18\n', check: checkJson() });
  const info = await makeCaps(mock, { fsExists: (p) => p !== SCRIPT }).getPythonInfo();
  assert(info.pythonFound === true && info.pythonSupported === false, 'found but unsupported');
  assert(info.diarizationStatus === 'python-unsupported', `status ${info.diarizationStatus}`);
});

test('Python 3.10 is supported', async () => {
  const mock = makePythonSpawn({ version: 'Python 3.10.0\n', check: 7 /* exit code, forces fallback */, pyannote: '4.0.7' });
  const info = await makeCaps(mock).getPythonInfo();
  assert(info.pythonSupported === true, '3.10 supported');
});

test('pyannote 3.x is unsupported, not missing (from --check)', async () => {
  const mock = makePythonSpawn({ check: checkJson({ status: 'pyannote-unsupported', pyannoteSupported: false, modelReady: false, versions: { python: '3.12.3', 'pyannote.audio': '3.1.1', torch: '2.3.0' } }) });
  const info = await makeCaps(mock).getPythonInfo();
  assert(info.pyannoteInstalled === true && info.pyannoteVersion === '3.1.1', 'installed with version');
  assert(info.pyannoteSupported === false, 'not supported');
  assert(info.diarizationStatus === 'pyannote-unsupported', `status ${info.diarizationStatus}`);
});

test('pyannote missing is distinguished from unsupported (from --check)', async () => {
  const mock = makePythonSpawn({ check: checkJson({ status: 'pyannote-missing', pyannoteSupported: false, modelReady: false, versions: { python: '3.12.3', 'pyannote.audio': null, torch: null }, cudaAvailable: false }) });
  const info = await makeCaps(mock).getPythonInfo();
  assert(info.pyannoteInstalled === false && info.pyannoteVersion === null, 'not installed');
  assert(info.diarizationStatus === 'pyannote-missing', `status ${info.diarizationStatus}`);
});

test('fallback probes distinguish pyannote 3.x (unsupported) from missing', async () => {
  const noScript = { fsExists: (p) => p !== SCRIPT };
  const old = await makeCaps(makePythonSpawn({ pyannote: '3.1.0' }), noScript).getPythonInfo();
  assert(old.pyannoteInstalled === true && old.pyannoteSupported === false, 'old pyannote installed but unsupported');
  assert(old.diarizationStatus === 'pyannote-unsupported', `status ${old.diarizationStatus}`);
  const missing = await makeCaps(makePythonSpawn({ pyannote: null }), noScript).getPythonInfo();
  assert(missing.pyannoteInstalled === false, 'missing');
  assert(missing.diarizationStatus === 'pyannote-missing', `status ${missing.diarizationStatus}`);
  const current = await makeCaps(makePythonSpawn({ pyannote: '4.0.7', torch: 'True' }), noScript).getPythonInfo();
  assert(current.pyannoteSupported === true && current.gpuAvailable === true, '4.x supported');
  assert(current.diarizationStatus === 'unknown', 'model readiness unknown without --check');
  assert(current.modelReady === false && current.model === null, 'no model info without --check');
});

test('malformed --check output falls back without throwing', async () => {
  for (const check of ['not json at all', '{"status": 5}', '[1,2,3]', '', 3, new Error('spawn EACCES')]) {
    const mock = makePythonSpawn({ check, pyannote: '4.0.7' });
    const info = await makeCaps(mock).getPythonInfo();
    assert(info.pythonFound === true, `python found for ${String(check)}`);
    assert(info.pyannoteVersion === '4.0.7', `legacy probe used for ${String(check)}`);
    assert(info.diarizationStatus === 'unknown', `status ${info.diarizationStatus} for ${String(check)}`);
  }
});

test('unknown --check status maps to unknown', async () => {
  const info = await makeCaps(makePythonSpawn({ check: checkJson({ status: 'something-new' }) })).getPythonInfo();
  assert(info.diarizationStatus === 'unknown', `status ${info.diarizationStatus}`);
});

test('concurrent getPythonInfo calls share one probe; refresh probes again', async () => {
  const mock = makePythonSpawn({ check: checkJson({ status: 'model-not-prepared', modelReady: false }) });
  const caps = makeCaps(mock);
  const [a, b] = await Promise.all([caps.getPythonInfo(), caps.getPythonInfo()]);
  assert(a === b, 'same result object');
  const checks = () => mock.calls.filter(c => c.args.includes('--check')).length;
  assert(checks() === 1, `one --check run, got ${checks()}`);
  await caps.getPythonInfo();
  assert(checks() === 1, 'cached');
  await caps.getPythonInfo({ refresh: true });
  assert(checks() === 2, 'refresh runs --check again');
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

// ---------------------------------------------------------------------------
// Tests: align.py --check probe (design decisions D3, D4)
// ---------------------------------------------------------------------------

test('getAlignmentInfo runs align.py --check with the job Python and caches per language', async () => {
  const py = '/opt/venv/bin/python';
  const mock = makePythonSpawn({ runnable: [py], check: JSON.stringify({
    status: 'ready', message: 'ok', provider: { name: 'transcriber-align', version: '1.0' },
    versions: { torch: '2.8.0', whisperx: null, nltk: null }, punktReady: null,
    model: { name: 'WAV2VEC2_ASR_BASE_960H', type: 'torchaudio' },
  }) });
  const caps = makeCaps(mock, { env: { TRANSCRIBER_PYTHON: py } });
  const info = await caps.getAlignmentInfo({ language: 'en' });
  assert(info.alignmentStatus === 'ready', JSON.stringify(info));
  assert(info.alignmentProvider.name === 'transcriber-align' && info.alignmentProvider.version === '1.0', JSON.stringify(info));
  assert(info.whisperxVersion === null, 'deprecated whisperxVersion is null for the local aligner');
  const call = mock.calls.find((c) => c.args.includes('--check'));
  assert(call.cmd === py && call.args[0] === '/fake/res/lib/align.py' && call.args.join(' ').includes('--language en'), JSON.stringify(call));
  const before = mock.calls.length;
  await caps.getAlignmentInfo({ language: 'en' });
  assert(mock.calls.length === before, 'cached');
  await caps.getAlignmentInfo({ language: 'en', refresh: true });
  assert(mock.calls.length > before, 'refresh probes again');
});

test('getAlignmentInfo reports missing Python, missing script and unreadable output', async () => {
  const none = await makeCaps(makePythonSpawn({ runnable: [] })).getAlignmentInfo();
  assert(none.alignmentStatus === 'python-missing', none.alignmentStatus);
  const noScript = await makeCaps(makePythonSpawn({ check: '{}' }), { fsExists: (p) => !p.endsWith('align.py') }).getAlignmentInfo();
  assert(noScript.alignmentStatus === 'unknown', noScript.alignmentStatus);
  const garbled = await makeCaps(makePythonSpawn({ check: 'Traceback...' })).getAlignmentInfo();
  assert(garbled.alignmentStatus === 'unknown', garbled.alignmentStatus);
  const missing = await makeCaps(makePythonSpawn({ check: JSON.stringify({ status: 'alignment-missing', message: 'pip install' }) })).getAlignmentInfo();
  assert(missing.alignmentStatus === 'alignment-missing' && missing.alignmentMessage === 'pip install', JSON.stringify(missing));
  assert(missing.alignmentProvider === null, 'no provider when the helper does not report one');
});

test('getAlignmentInfo still reads an older WhisperX-based helper', async () => {
  const legacy = await makeCaps(makePythonSpawn({ check: JSON.stringify({
    status: 'ready', message: 'ok', versions: { whisperx: '3.8.6' }, punktReady: true,
    model: { name: 'WAV2VEC2_ASR_BASE_960H', type: 'torchaudio' },
  }) })).getAlignmentInfo();
  assert(legacy.alignmentStatus === 'ready' && legacy.whisperxVersion === '3.8.6', JSON.stringify(legacy));
  assert(legacy.alignmentProvider === null, JSON.stringify(legacy));
});

runAll();
