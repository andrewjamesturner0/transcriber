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

// Use a real temporary resource tree with one canonical model catalogue.
const FAKE_APP = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-test-'));
const FAKE_MODELS = path.join(FAKE_APP, 'models');
fs.mkdirSync(FAKE_MODELS);
const { getCatalogue } = require('../lib/models');
for (const model of getCatalogue()) {
  fs.writeFileSync(path.join(FAKE_MODELS, model.fileName), 'fixture model');
}

// Also create fake binary dirs
fs.mkdirSync(path.join(FAKE_APP, 'bin', 'linux', 'cpu'), { recursive: true });
fs.mkdirSync(path.join(FAKE_APP, 'bin', 'linux', 'vulkan'), { recursive: true });
fs.writeFileSync(path.join(FAKE_APP, 'bin', 'linux', 'cpu', 'whisper-cli'), '');
fs.writeFileSync(path.join(FAKE_APP, 'bin', 'linux', 'vulkan', 'whisper-cli'), '');
fs.writeFileSync(path.join(FAKE_APP, 'bin', 'linux', 'ffmpeg'), '');

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
    getPythonSpawn: async () => null,
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

function makeRunner(overrides = {}) {
  const { spawn } = captureSpawn();
  return createTranscriptionRunner({
    capabilities: makeCapabilities(overrides.capabilities),
    paths: makePaths(overrides.paths),
    spawn: overrides.spawn || spawn,
    log: overrides.log || (() => {}),
    tmpDir: overrides.tmpDir || os.tmpdir(),
    modelStore: overrides.modelStore,
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
  assert(!whisperCall.args.includes('--dtw'), 'plain transcription should not have --dtw');
  assert(!whisperCall.args.includes('--no-flash-attn'), 'plain transcription should not have --no-flash-attn');
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

  try { await runner.runTranscription({ filePath: '/fake/test.wav', modelId: 'tiny.en', options: { diarization: true, dtw: true }, onProgress: () => {} }); } catch (_) {}

  const whisperCall = calls.find(c => c.cmd.includes('whisper-cli'));
  assert(whisperCall, 'whisper should be called');
  assert(whisperCall.args.includes('--output-json-full'), 'diarization should use --output-json-full');
  assert(whisperCall.args.includes('-of'), 'should have -of for output prefix');
  assert(whisperCall.args.includes('--dtw'), 'should have --dtw when supported');
  assert(whisperCall.args.includes('tiny.en'), 'should have dtw preset tiny.en');
  assert(whisperCall.args.filter(a => a === '--no-flash-attn').length === 1,
    'DTW needs --no-flash-attn exactly once (flash attention silently disables DTW)');
});

test('diarization without DTW support skips --dtw', async () => {
  const { spawn, calls } = captureSpawn();
  const runner = makeRunner({
    spawn,
    capabilities: { isDtwSupported: () => false },
  });

  try { await runner.runTranscription({ filePath: '/fake/test.wav', modelId: 'tiny.en', options: { diarization: true, dtw: true }, onProgress: () => {} }); } catch (_) {}

  const whisperCall = calls.find(c => c.cmd.includes('whisper-cli'));
  assert(whisperCall.args.includes('--output-json-full'), 'should still use JSON output');
  assert(!whisperCall.args.includes('--dtw'), 'should not have --dtw when unsupported');
  assert(!whisperCall.args.includes('--no-flash-attn'), 'should not have --no-flash-attn when unsupported');
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

test('outputJson without diarization uses --output-json-full and not --no-timestamps', async () => {
  const { spawn, calls } = captureSpawn();
  const runner = makeRunner({ spawn });

  try {
    await runner.runTranscription({
      filePath: '/fake/test.wav',
      modelId: 'tiny.en',
      options: { outputJson: true },
      onProgress: () => {},
    });
  } catch (_) {}

  const whisperCall = calls.find(c => c.cmd.includes('whisper-cli'));
  assert(whisperCall, 'whisper should be called');
  assert(whisperCall.args.includes('--output-json-full'), 'should have --output-json-full when outputJson is true');
  assert(whisperCall.args.includes('-of'), 'should have -of for output prefix');
  assert(!whisperCall.args.includes('--no-timestamps'), 'should not have --no-timestamps when JSON mode is on');
  assert(!whisperCall.args.includes('--dtw'), 'should not have --dtw without diarization');
  assert(!whisperCall.args.includes('--no-flash-attn'), 'should not have --no-flash-attn without diarization');
});

test('runner returns { text } shape by default', async () => {
  const { spawn } = captureSpawn();
  const runner = makeRunner({ spawn });

  let result;
  try {
    result = await runner.runTranscription({
      filePath: '/fake/test.wav',
      modelId: 'tiny.en',
      onProgress: () => {},
    });
  } catch (_) {}

  assert(result && typeof result === 'object', 'result should be an object');
  assert(typeof result.text === 'string', 'result.text should be a string');
  assert(!('json' in result), 'result should not include json without outputJson');
  assert(result.transcript.kind === 'plain' && result.transcript.version === 1);
  assert(result.transcript.blocks.length === 0 && result.transcript.warnings.length === 0);
});

test('runner reads whisper JSON when outputJson is true', async () => {
  // Spawn that writes a JSON file at the path passed via `-of`
  const writingSpawn = function (cmd, args, opts) {
    if (cmd.includes('whisper-cli')) {
      const ofIdx = args.indexOf('-of');
      if (ofIdx >= 0) {
        fs.writeFileSync(args[ofIdx + 1] + '.json', JSON.stringify({ transcription: [{ text: 'hello' }] }));
      }
    }
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    process.nextTick(() => {
      proc.stdout.emit('data', Buffer.from('hello\n'));
      proc.emit('close', 0);
    });
    return proc;
  };
  const runner = makeRunner({ spawn: writingSpawn });

  const result = await runner.runTranscription({
    filePath: '/fake/test.wav',
    modelId: 'tiny.en',
    options: { outputJson: true },
    onProgress: () => {},
  });

  assert(result.text === 'hello', `expected text 'hello', got '${result.text}'`);
  assert(result.json && Array.isArray(result.json.transcription), 'result.json should be parsed whisper JSON');
  assert(result.json.transcription[0].text === 'hello', 'json content preserved');
});

// --- Diarised pipeline tests ---

console.log('\nDiarised pipeline tests\n');

fs.mkdirSync(path.join(FAKE_APP, 'lib'), { recursive: true });
fs.writeFileSync(path.join(FAKE_APP, 'lib', 'diarize.py'), '');
fs.writeFileSync(path.join(FAKE_APP, 'lib', 'align.py'), '');

/**
 * Spawn mock for the full diarised pipeline. whisper-cli writes `whisperJson`
 * to its -of prefix; python writes `diarizeOutput` (raw JSON text or value)
 * to --output and emits `diarizeStderr` chunks.
 */
function pipelineSpawn({ whisperJson, diarizeOutput, diarizeStderr = [], diarizeCode = 0, calls = [], hang = false,
  alignOutput, alignCode = 0, alignStderr = [], hangAlign = false }) {
  return function (cmd, args, opts) {
    calls.push({ cmd, args: [...args] });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => process.nextTick(() => proc.emit('close', null));
    let code = 0;
    if (cmd.includes('ffmpeg')) {
      fs.writeFileSync(args[args.length - 1], 'RIFF');
    } else if (cmd.includes('whisper-cli')) {
      const ofIdx = args.indexOf('-of');
      if (ofIdx >= 0) fs.writeFileSync(args[ofIdx + 1] + '.json', JSON.stringify(whisperJson));
    } else if (cmd === 'python3' && args[0].endsWith('align.py')) {
      const input = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf-8'));
      calls[calls.length - 1].alignInput = input;
      const out = typeof alignOutput === 'function' ? alignOutput(input) : alignOutput;
      if (out !== undefined) {
        fs.writeFileSync(args[args.indexOf('--output') + 1], typeof out === 'string' ? out : JSON.stringify(out));
      }
      if (hangAlign) return proc;
      process.nextTick(() => {
        for (const chunk of alignStderr) proc.stderr.emit('data', Buffer.from(chunk));
        proc.emit('close', alignCode);
      });
      return proc;
    } else if (cmd === 'python3') {
      const outIdx = args.indexOf('--output');
      if (diarizeOutput !== undefined && outIdx >= 0) {
        fs.writeFileSync(args[outIdx + 1], typeof diarizeOutput === 'string' ? diarizeOutput : JSON.stringify(diarizeOutput));
      }
      code = diarizeCode;
    }
    if (hang && cmd === 'python3') return proc;
    process.nextTick(() => {
      if (cmd.includes('whisper-cli')) proc.stdout.emit('data', Buffer.from(' Ready? Yes. Continue.\n'));
      if (cmd === 'python3') for (const chunk of diarizeStderr) proc.stderr.emit('data', Buffer.from(chunk));
      proc.emit('close', code);
    });
    return proc;
  };
}

const READY_YES_JSON = {
  transcription: [{
    offsets: { from: 0, to: 2800 },
    text: ' Ready? Yes. Continue.',
    tokens: [
      { text: ' Ready?', offsets: { from: 0, to: 800 }, t_dtw: 10 },
      { text: ' Yes.', offsets: { from: 1000, to: 1500 }, t_dtw: 105 },
      { text: ' Continue.', offsets: { from: 2000, to: 2800 }, t_dtw: 205 },
    ],
  }],
};
const READY_YES_SPEAKERS = [
  { start: 0, end: 0.9, speaker: 'A' },
  { start: 1, end: 1.6, speaker: 'B' },
  { start: 2, end: 3, speaker: 'A' },
];

test('diarised job returns merged text and additive JSON evidence', async () => {
  const runner = makeRunner({
    spawn: pipelineSpawn({ whisperJson: READY_YES_JSON, diarizeOutput: READY_YES_SPEAKERS }),
    capabilities: { getPythonSpawn: async () => ({ command: 'python3', args: [] }) },
  });
  const plain = await runner.runTranscription({
    filePath: '/fake/test.wav', modelId: 'tiny.en', options: { diarization: true, dtw: true },
    onProgress: () => {}, onDiarizeProgress: () => {},
  });
  assert(typeof plain.text === 'string' && !('json' in plain), 'text-only result without outputJson');
  assert(plain.text.includes('[Speaker 2] Yes.'), plain.text);

  const result = await runner.runTranscription({
    filePath: '/fake/test.wav', modelId: 'tiny.en', options: { diarization: true, dtw: true, outputJson: true },
    onProgress: () => {}, onDiarizeProgress: () => {},
  });
  const j = result.json;
  assert(j.whisper && Array.isArray(j.diarize) && typeof j.merged === 'string', 'legacy keys kept');
  assert(j.merged === result.text, 'merged equals returned text');
  const sa = j.speakerAttribution;
  assert(sa && sa.version === 1 && !('text' in sa), 'additive speakerAttribution without duplicate text');
  assert(sa.words.length === 3 && sa.words.every((w) => w.timingSource === 'dtw'), JSON.stringify(sa.summary));
  assert(sa.whisperDtw && sa.whisperDtw.requested === true, JSON.stringify(sa.whisperDtw));
});

function envelope(regular, exclusive, extra = {}) {
  return {
    format: 'transcriber-diarization', version: 1,
    regular, exclusive, exclusiveAvailable: exclusive !== null,
    model: { id: 'pyannote/speaker-diarization-community-1', revision: 'abc' },
    versions: { python: '3.12.3', 'pyannote.audio': '4.0.7', torch: '2.8.0' },
    device: 'cpu', numSpeakersRequested: null,
    audio: { sampleRate: 16000, channels: 1, durationSec: 3 }, processingSec: 1,
    ...extra,
  };
}

async function runDiarised(spawnOpts, extra = {}) {
  const calls = [];
  const progress = [];
  const diarizeEvents = [];
  const runner = makeRunner({
    spawn: pipelineSpawn({ whisperJson: READY_YES_JSON, calls, ...spawnOpts }),
    capabilities: { getPythonSpawn: async () => ({ command: 'python3', args: [] }) },
  });
  const result = await runner.runTranscription({
    filePath: '/fake/test.wav', modelId: 'tiny.en',
    options: { diarization: true, outputJson: true, hfToken: 'hf_secret_value', ...extra.options },
    signal: extra.signal,
    onProgress: (m) => progress.push(m), onDiarizeProgress: (d) => diarizeEvents.push(d),
  });
  return { result, calls, progress, diarizeEvents };
}

test('exclusive timeline assigns words; regular overlap kept as evidence', async () => {
  const regular = [{ start: 0, end: 1.2, speaker: 'A' }, { start: 0.95, end: 1.6, speaker: 'B' }, { start: 2, end: 3, speaker: 'A' }];
  const exclusive = [{ start: 0, end: 0.95, speaker: 'A' }, { start: 0.95, end: 1.6, speaker: 'B' }, { start: 2, end: 3, speaker: 'A' }];
  const { result } = await runDiarised({ diarizeOutput: envelope(regular, exclusive) });
  const j = result.json;
  assert(j.speakerAttribution.timeline === 'exclusive', j.speakerAttribution.timeline);
  assert(result.text.includes('[Speaker 2] Yes.'), result.text);
  assert(JSON.stringify(j.diarize) === JSON.stringify(regular), 'diarize stays the regular array');
  assert(JSON.stringify(j.diarizeExclusive) === JSON.stringify(exclusive), 'diarizeExclusive added');
  assert(j.diarizeInfo.model.id === 'pyannote/speaker-diarization-community-1' && !('regular' in j.diarizeInfo), 'info without arrays');
  const yes = j.speakerAttribution.words[1];
  assert(yes.evidence.overlapSpeakers.slice().sort().join() === 'A,B', JSON.stringify(yes.evidence));
});

test('missing exclusive output is declared and regular timeline is used', async () => {
  const { result } = await runDiarised({ diarizeOutput: envelope(READY_YES_SPEAKERS, null) });
  assert(result.json.diarizeExclusive === null, 'exclusive null');
  assert(result.json.speakerAttribution.timeline === 'regular', 'regular used');
});

test('legacy bare array is accepted as a regular timeline', async () => {
  const { result } = await runDiarised({ diarizeOutput: READY_YES_SPEAKERS });
  assert(result.json.diarizeInfo.legacy === true, JSON.stringify(result.json.diarizeInfo));
  assert(result.json.diarizeExclusive === null, 'no invented exclusive');
  assert(result.text.includes('[Speaker 2] Yes.'), result.text);
});

test('malformed or unknown output falls back to the plain transcript', async () => {
  for (const bad of ['{not json', { format: 'other', version: 1 }, envelope([{ start: 0 }], null),
    envelope(READY_YES_SPEAKERS, [{ start: 'x', end: 1, speaker: 'A' }])]) {
    const { result, progress } = await runDiarised({ diarizeOutput: bad });
    assert(!('json' in result) && result.text === 'Ready? Yes. Continue.', JSON.stringify(result));
    assert(progress.some((m) => /^Speaker labelling failed \(.+\), using plain transcript$/.test(m)), progress.join(' | '));
  }
});

test('missing output file falls back to the plain transcript', async () => {
  const { result } = await runDiarised({ diarizeOutput: undefined });
  assert(result.text === 'Ready? Yes. Continue.', result.text);
});

test('helper error code and message reach progress and fallback', async () => {
  const err = JSON.stringify({ error: 'Speaker model not prepared. Run scripts/setup-diarization.py', code: 'model-not-prepared' });
  const { result, progress, diarizeEvents } = await runDiarised({ diarizeOutput: undefined, diarizeStderr: [err + '\n'], diarizeCode: 1 });
  assert(result.text === 'Ready? Yes. Continue.', result.text);
  assert(diarizeEvents.some((d) => d.code === 'model-not-prepared'), JSON.stringify(diarizeEvents));
  assert(progress.some((m) => m.includes('Speaker model not prepared')), progress.join(' | '));
});

test('progress JSON split across stderr chunks is parsed once', async () => {
  const line = JSON.stringify({ message: 'Running diarization...', percent: 30 }) + '\n';
  const { diarizeEvents } = await runDiarised({
    diarizeOutput: envelope(READY_YES_SPEAKERS, null),
    diarizeStderr: [line.slice(0, 12), line.slice(12, 30), line.slice(30) + 'plain log line\n'],
  });
  const hits = diarizeEvents.filter((d) => d.message === 'Running diarization...' && d.percent === 30);
  assert(hits.length === 1, JSON.stringify(diarizeEvents));
});

test('no Hugging Face token reaches the inference command line', async () => {
  const { calls } = await runDiarised({ diarizeOutput: envelope(READY_YES_SPEAKERS, null) });
  const py = calls.find((c) => c.cmd === 'python3');
  assert(py && !py.args.includes('--hf-token') && !py.args.some((a) => a.includes('hf_secret')), JSON.stringify(py && py.args));
});

test('temporary WAV, Whisper JSON and diarize output are removed after success and failure', async () => {
  for (const opts of [{ diarizeOutput: envelope(READY_YES_SPEAKERS, null) }, { diarizeOutput: '{bad' }]) {
    const { calls } = await runDiarised(opts);
    const wav = calls.find((c) => c.cmd.includes('ffmpeg')).args.slice(-1)[0];
    const wjson = calls.find((c) => c.cmd.includes('whisper-cli')).args[calls.find((c) => c.cmd.includes('whisper-cli')).args.indexOf('-of') + 1] + '.json';
    const py = calls.find((c) => c.cmd === 'python3');
    const out = py.args[py.args.indexOf('--output') + 1];
    for (const f of [wav, wjson, out]) assert(!fs.existsSync(f), `left behind: ${f}`);
  }
});

test('cancellation during diarisation propagates and cleans up', async () => {
  const controller = new AbortController();
  const calls = [];
  const runner = makeRunner({
    spawn: pipelineSpawn({ whisperJson: READY_YES_JSON, diarizeOutput: envelope(READY_YES_SPEAKERS, null), calls, hang: true }),
    capabilities: { getPythonSpawn: async () => ({ command: 'python3', args: [] }) },
  });
  const promise = runner.runTranscription({
    filePath: '/fake/test.wav', modelId: 'tiny.en', options: { diarization: true, outputJson: true },
    signal: controller.signal, onProgress: () => {}, onDiarizeProgress: () => {},
  });
  while (!calls.some((c) => c.cmd === 'python3')) await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  let caught = null;
  try { await promise; } catch (e) { caught = e; }
  assert(caught && caught.message === 'Cancelled', `expected Cancelled, got ${caught && caught.message}`);
  const py = calls.find((c) => c.cmd === 'python3');
  assert(!fs.existsSync(py.args[py.args.indexOf('--output') + 1]), 'diarize output removed');
  assert(!fs.existsSync(calls.find((c) => c.cmd.includes('ffmpeg')).args.slice(-1)[0]), 'WAV removed');
});

// --- Forced alignment pipeline tests (D3) ---

console.log('\nForced alignment pipeline tests\n');

/** Aligner stub: every word measured at a fixed position, optionally overridden. */
function alignAll(times, quality = 'measured', provider = { name: 'transcriber-align', version: '1.0' }) {
  return (input) => ({
    format: 'transcriber-alignment', version: 1,
    provider: { ...provider, model: 'WAV2VEC2_ASR_BASE_960H', language: input.language },
    device: 'cpu', processingSec: 1,
    segments: input.segments.map((seg) => ({
      index: seg.index, status: 'aligned', reason: null,
      words: seg.words.map((_, k) => times[k] === null
        ? { startMs: null, endMs: null, score: null, quality: 'unaligned' }
        : { startMs: times[k][0], endMs: times[k][1], score: 0.9, quality }),
    })),
  });
}

// A forced job runs Whisper without --dtw, so its tokens carry no anchors.
const READY_YES_NO_DTW = JSON.parse(JSON.stringify(READY_YES_JSON));
for (const t of READY_YES_NO_DTW.transcription[0].tokens) t.t_dtw = -1;

async function runForced(spawnOpts, options = {}) {
  const calls = [];
  const progress = [];
  const runner = makeRunner({
    spawn: pipelineSpawn({ whisperJson: READY_YES_NO_DTW, calls, diarizeOutput: envelope(READY_YES_SPEAKERS, null), ...spawnOpts }),
    capabilities: { getPythonSpawn: async () => ({ command: 'python3', args: [] }) },
  });
  const result = await runner.runTranscription({
    filePath: '/fake/test.wav', modelId: 'tiny.en',
    options: { diarization: true, outputJson: true, alignment: 'forced', ...options },
    signal: spawnOpts.signal, onProgress: (m) => progress.push(m), onDiarizeProgress: () => {},
  });
  return { result, calls, progress };
}

test('forced alignment: one Whisper pass without DTW, aligner before diariser, forced timing used', async () => {
  // Aligner moves "Yes." into speaker A's time; the speaker must follow the aligner.
  const { result, calls } = await runForced({ alignOutput: alignAll([[100, 700], [700, 850], [2100, 2700]]) });
  const order = calls.map((c) => (c.cmd.includes('ffmpeg') ? 'ffmpeg' : c.cmd.includes('whisper-cli') ? 'whisper'
    : c.args[0].endsWith('align.py') ? 'align' : 'diarize'));
  assert(JSON.stringify(order) === JSON.stringify(['ffmpeg', 'whisper', 'align', 'diarize']), order.join(','));
  const w = calls.find((c) => c.cmd.includes('whisper-cli'));
  assert(!w.args.includes('--dtw') && !w.args.includes('--no-flash-attn'), 'no DTW for forced jobs');
  const align = calls.find((c) => c.alignInput);
  assert(align.alignInput.language === 'en' && align.alignInput.segments[0].words.join(' ') === 'Ready? Yes. Continue.', JSON.stringify(align.alignInput));
  const sa = result.json.speakerAttribution;
  assert(result.transcript.kind === 'speaker-labelled');
  assert(result.transcript.alignment.status === 'aligned');
  assert(result.transcript.attribution.words.length === sa.words.length);
  assert(sa.words.every((x) => x.timingSource === 'forced' && x.timingQuality === 'measured'), JSON.stringify(sa.summary.timing));
  assert(sa.alignment.status === 'aligned' && sa.alignment.provider.name === 'transcriber-align', JSON.stringify(sa.alignment));
  assert(sa.alignment.provider.version === '1.0' && sa.alignment.provider.language === 'en', JSON.stringify(sa.alignment));
  assert(sa.whisperDtw.requested === false, 'DTW not requested');
  assert(result.text.includes('[Speaker 1] Ready? Yes.'), result.text);
});

test('forced alignment: an older WhisperX-provider envelope is still accepted', async () => {
  const legacy = { name: 'whisperx', version: '3.8.6' };
  const { result } = await runForced({ alignOutput: alignAll([[100, 700], [700, 850], [2100, 2700]], 'measured', legacy) });
  const sa = result.json.speakerAttribution;
  assert(sa.alignment.status === 'aligned' && sa.alignment.provider.name === 'whisperx', JSON.stringify(sa.alignment));
  assert(sa.words.every((x) => x.timingSource === 'forced'), JSON.stringify(sa.summary.timing));
});

test('forced alignment: interpolated words (no recognised characters) use their times honestly', async () => {
  const { result } = await runForced({ alignOutput: alignAll([[100, 700], [700, 850], [2100, 2700]], 'interpolated') });
  const words = result.json.speakerAttribution.words;
  assert(words.every((x) => x.timingSource === 'forced' && x.timingQuality === 'interpolated'), JSON.stringify(words));
  assert(words[1].startMs === 700 && words[1].endMs === 850, JSON.stringify(words[1]));
});

test('forced alignment: unaligned words keep Whisper timing with a reason', async () => {
  const { result } = await runForced({ alignOutput: alignAll([[100, 700], null, [2100, 2700]]) });
  const words = result.json.speakerAttribution.words;
  assert(words[1].timingSource === 'token' && words[1].timingFallback === 'alignment-unaligned', JSON.stringify(words[1]));
  assert(words[0].timingSource === 'forced', 'others aligned');
});

test('forced alignment: helper failure keeps text and Whisper timing, one message', async () => {
  const err = JSON.stringify({ error: 'Alignment model not prepared', code: 'model-not-prepared' }) + '\n';
  const { result, progress } = await runForced({ alignOutput: undefined, alignStderr: [err], alignCode: 1 });
  assert(result.text.includes('[Speaker 2] Yes.'), result.text);
  const sa = result.json.speakerAttribution;
  assert(sa.alignment.status === 'failed' && /not prepared/.test(sa.alignment.reason), JSON.stringify(sa.alignment));
  assert(sa.words.every((x) => x.timingSource === 'token'), JSON.stringify(sa.summary.timing));
  assert(progress.filter((m) => m.startsWith('Word alignment failed')).length === 1, progress.join(' | '));
  assert(!progress.some((m) => m.startsWith('Speaker labelling failed')), 'diarisation still ran');
});

test('forced alignment: malformed output (wrong word count or format) falls back', async () => {
  for (const bad of ['{nope', { format: 'x', version: 1, segments: [] },
    (input) => ({ ...alignAll([[1, 2]])(input), segments: [{ index: 0, words: [{ startMs: 1, endMs: 2, quality: 'measured' }] }] })]) {
    const { result } = await runForced({ alignOutput: bad });
    assert(result.json.speakerAttribution.alignment.status === 'failed', JSON.stringify(result.json.speakerAttribution.alignment));
    assert(result.text.includes('Ready?'), 'text kept');
  }
});

test('default and plain jobs never start the aligner', async () => {
  for (const options of [{ diarization: true, outputJson: true }, { diarization: true, alignment: 'whisper' }, {}]) {
    const calls = [];
    const runner = makeRunner({
      spawn: pipelineSpawn({ whisperJson: READY_YES_JSON, calls, diarizeOutput: envelope(READY_YES_SPEAKERS, null) }),
      capabilities: { getPythonSpawn: async () => ({ command: 'python3', args: [] }) },
    });
    await runner.runTranscription({ filePath: '/fake/test.wav', modelId: 'tiny.en', options, onProgress: () => {}, onDiarizeProgress: () => {} });
    assert(!calls.some((c) => c.cmd === 'python3' && c.args[0].endsWith('align.py')), JSON.stringify(options));
  }
});

test('invalid timing options fail before any process starts', async () => {
  for (const options of [{ diarization: true, alignment: 'wav2vec' }, { alignment: 'forced' }, { dtw: true }, { diarization: true, alignment: 'forced', dtw: true }]) {
    const calls = [];
    const runner = makeRunner({ spawn: pipelineSpawn({ whisperJson: READY_YES_JSON, calls }) });
    let caught = null;
    try {
      await runner.runTranscription({ filePath: '/fake/test.wav', modelId: 'tiny.en', options, onProgress: () => {} });
    } catch (e) { caught = e; }
    assert(caught && /alignment|diarisation|DTW/i.test(caught.message), caught && caught.message);
    assert(calls.length === 0, `no subprocess expected, got ${calls.length}`);
  }
});

test('cancellation during alignment propagates, skips diarisation and cleans up', async () => {
  const controller = new AbortController();
  const calls = [];
  const runner = makeRunner({
    spawn: pipelineSpawn({ whisperJson: READY_YES_JSON, calls, alignOutput: undefined, hangAlign: true }),
    capabilities: { getPythonSpawn: async () => ({ command: 'python3', args: [] }) },
  });
  const promise = runner.runTranscription({
    filePath: '/fake/test.wav', modelId: 'tiny.en', options: { diarization: true, alignment: 'forced' },
    signal: controller.signal, onProgress: () => {}, onDiarizeProgress: () => {},
  });
  while (!calls.some((c) => c.alignInput)) await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  let caught = null;
  try { await promise; } catch (e) { caught = e; }
  assert(caught && caught.message === 'Cancelled', caught && caught.message);
  const a = calls.find((c) => c.alignInput);
  for (const f of [a.args[a.args.indexOf('--input') + 1], a.args[a.args.indexOf('--output') + 1], calls[0].args.slice(-1)[0]]) {
    assert(!fs.existsSync(f), `left behind: ${f}`);
  }
  assert(!calls.some((c) => c.cmd === 'python3' && c.args[0].endsWith('diarize.py')), 'diarisation not started');
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

test('structured GUI results retain Unknown without requesting full JSON', async () => {
  const whisperJson = JSON.parse(JSON.stringify(READY_YES_NO_DTW));
  whisperJson.transcription[0].offsets.to = 28000;
  whisperJson.transcription[0].tokens[1].offsets = { from: 20000, to: 20500 };
  whisperJson.transcription[0].tokens[2].offsets = { from: 27000, to: 27500 };
  const { result } = await runDiarised({
    whisperJson,
    diarizeOutput: [{ start: 0, end: 1, speaker: 'A' }, { start: 27, end: 28, speaker: 'B' }],
  }, { options: { outputJson: false } });
  assert(!('json' in result), 'GUI need not carry full Whisper JSON');
  assert(result.transcript.kind === 'speaker-labelled');
  assert(result.transcript.blocks.some((block) => block.speaker === 'Unknown' && block.text === 'Yes.'));
  assert(result.transcript.attribution.words.map((word) => word.text).join('|') === 'Ready?|Yes.|Continue.');
});

test('structured results retain completed alignment and a speaker fallback warning', async () => {
  const { result } = await runForced({
    alignOutput: alignAll([[100, 700], [700, 850], [2100, 2700]]),
    diarizeCode: 1,
  });
  assert(result.transcript.kind === 'plain');
  assert(result.transcript.alignment.status === 'aligned');
  assert(result.transcript.warnings.some((warning) => warning.startsWith('Speaker labelling failed')));
  assert(result.transcript.attribution === null);
});

test('injected stores control model paths independently of singleton paths', async () => {
  const { createModelStore } = require('../lib/model-store');
  const stores = ['store-one', 'store-two'].map((name) => {
    const directory = path.join(FAKE_APP, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'ggml-tiny.en.bin'), 'fixture weights');
    return createModelStore({ bundledDir: directory });
  });
  const modelPaths = [];
  for (const modelStore of stores) {
    const { spawn, calls } = captureSpawn();
    await makeRunner({ modelStore, spawn }).runTranscription({ filePath: '/fake/test.wav', onProgress: () => {} });
    const whisper = calls.find((call) => call.cmd.includes('whisper-cli'));
    modelPaths.push(whisper.args[whisper.args.indexOf('-m') + 1]);
  }
  assert(modelPaths[0] === stores[0].getModelPath('tiny.en'));
  assert(modelPaths[1] === stores[1].getModelPath('tiny.en'));
  assert(modelPaths[0] !== modelPaths[1]);
});

test('an empty installed model is rejected before any subprocess starts', async () => {
  const { createModelStore } = require('../lib/model-store');
  const directory = path.join(FAKE_APP, 'empty-store');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'ggml-tiny.en.bin'), '');
  const modelStore = createModelStore({ bundledDir: directory });
  let called = false;
  const runner = makeRunner({ modelStore, spawn: () => { called = true; throw new Error('unexpected spawn'); } });
  try {
    await runner.runTranscription({ filePath: '/fake/test.wav', onProgress: () => {} });
    assert(false, 'empty weights must fail');
  } catch (error) { assert(error.message.includes('model not found'), error.message); }
  assert(!called, 'model availability must be checked before conversion');
});

test('same-clock jobs use private isolated workspaces and clean every file', async () => {
  const tmpDir = path.join(FAKE_APP, 'concurrent-work');
  fs.mkdirSync(tmpDir);
  const directories = new Set();
  const spawn = (cmd, args, opts) => {
    if (cmd.includes('ffmpeg')) {
      const wavPath = args[args.length - 1];
      const directory = path.dirname(wavPath);
      directories.add(directory);
      if (process.platform !== 'win32') {
        assert((fs.statSync(directory).mode & 0o777) === 0o700, 'job directory must be private');
      }
      fs.writeFileSync(wavPath, 'fixture wav');
      fs.writeFileSync(path.join(directory, 'unexpected-sidecar'), 'must be removed');
    }
    return makeSpawn({ stdout: 'fixture transcript', code: 0 })(cmd, args, opts);
  };
  const runner = makeRunner({ spawn, tmpDir });
  const originalNow = Date.now;
  Date.now = () => 1234;
  try {
    const job = () => runner.runTranscription({
      filePath: '/fake/test.wav', modelId: 'tiny.en', onProgress: () => {},
    });
    const results = await Promise.all([job(), job()]);
    assert(results.every((result) => result.text === 'fixture transcript'));
    assert(directories.size === 2, 'same millisecond must not share a directory');
    assert(fs.readdirSync(tmpDir).length === 0, 'all job files and directories must be removed');
  } finally {
    Date.now = originalNow;
  }
});

test('failed conversion cleans its complete private workspace', async () => {
  const tmpDir = path.join(FAKE_APP, 'failed-work');
  fs.mkdirSync(tmpDir);
  const runner = makeRunner({ tmpDir, spawn: (cmd, args, opts) => {
    fs.writeFileSync(args[args.length - 1], 'partial wav');
    return makeSpawn({ code: 1, stderr: 'fixture conversion failed' })(cmd, args, opts);
  } });
  let failure;
  try {
    await runner.runTranscription({ filePath: '/fake/test.wav', onProgress: () => {} });
  } catch (error) { failure = error; }
  assert(failure && failure.message.includes('fixture conversion failed'));
  assert(fs.readdirSync(tmpDir).length === 0, 'failed job must leave no workspace');
});

runAll();
