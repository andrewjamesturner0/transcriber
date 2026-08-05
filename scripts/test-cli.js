#!/usr/bin/env node
/**
 * Tests for cli.js
 *
 * Spawns `node cli.js ...` as a subprocess and asserts on stdout, stderr,
 * and exit code. Follows the plain-node style of the other test-*.js scripts.
 *
 * Tests cover: argument parsing, help output, error messages, exit codes,
 * stdout/stderr separation, and the table/JSON output of list-models.
 *
 * Usage:
 *     node scripts/test-cli.js
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CLI = path.join(__dirname, '..', 'cli.js');

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

function runCli(args, opts = {}) {
  const env = { ...process.env };
  // Wipe HF_TOKEN unless caller overrides
  if (!('HF_TOKEN' in (opts.env || {}))) delete env.HF_TOKEN;
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...env, ...(opts.env || {}) },
    timeout: 15000,
  });
}

// --- Top-level dispatch ---

console.log('Top-level dispatch tests\n');

test('no args prints top help and exits 1', () => {
  const r = runCli([]);
  assert(r.status === 1, `expected exit 1, got ${r.status}`);
  assert(r.stdout.includes('Usage: node cli.js'), 'stdout should show usage');
  assert(r.stdout.includes('transcribe'), 'stdout should list transcribe subcommand');
});

test('--help prints top help and exits 0', () => {
  const r = runCli(['--help']);
  assert(r.status === 0, `expected exit 0, got ${r.status}`);
  assert(r.stdout.includes('Usage:'), 'stdout should show usage');
});

test('unknown subcommand exits non-zero with error', () => {
  const r = runCli(['no-such-cmd']);
  assert(r.status !== 0, `expected non-zero exit, got ${r.status}`);
  assert(r.stderr.includes('Unknown subcommand'), 'stderr should mention unknown subcommand');
});

// --- transcribe ---

console.log('\ntranscribe subcommand tests\n');

test('transcribe --help exits 0 and prints help', () => {
  const r = runCli(['transcribe', '--help']);
  assert(r.status === 0, `expected exit 0, got ${r.status}`);
  assert(r.stdout.includes('--diarize'), 'help should mention --diarize');
  assert(r.stdout.includes('--format txt|json'), 'help should mention --format');
  assert(r.stdout.includes('--job-mode transcribe|translate'), 'help should mention job mode');
  assert(r.stdout.includes('--source-language'), 'help should mention source language');
  assert(r.stdout.includes('--target-language'), 'help should mention target language');
  assert(r.stdout.includes('--reduce-repeated-text'), 'help should mention repetition control');
  assert(r.stdout.includes('compatibility alias'), 'help should document the old flag as an alias');
});

test('transcribe -h exits 0 and prints help', () => {
  const r = runCli(['transcribe', '-h']);
  assert(r.status === 0, `expected exit 0, got ${r.status}`);
  assert(r.stdout.length > 0, 'help should be non-empty');
});

test('transcribe with no file exits non-zero', () => {
  const r = runCli(['transcribe']);
  assert(r.status !== 0, `expected non-zero exit, got ${r.status}`);
  assert(r.stderr.includes('missing'), 'stderr should mention missing file');
});

test('transcribe with missing file exits non-zero', () => {
  const r = runCli(['transcribe', '/does/not/exist/file.wav']);
  assert(r.status !== 0, `expected non-zero exit, got ${r.status}`);
  assert(r.stderr.includes('not found'), 'stderr should mention not found');
});

test('transcribe with unknown flag exits non-zero', () => {
  const r = runCli(['transcribe', '--bogus', '/tmp/x.wav']);
  assert(r.status !== 0, `expected non-zero exit, got ${r.status}`);
  assert(r.stderr.includes('Unknown flag'), 'stderr should mention unknown flag');
});

test('transcribe with unknown model id exits non-zero', () => {
  const tmpFile = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-')) + '/a.wav';
  fs.writeFileSync(tmpFile, '');
  try {
    const r = runCli(['transcribe', '--model', 'no-such-model', tmpFile]);
    assert(r.status !== 0, `expected non-zero exit, got ${r.status}`);
    assert(r.stderr.includes('Unknown model'), `stderr should mention unknown model, got: ${r.stderr}`);
  } finally {
    try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch (_) {}
  }
});

test('transcribe with invalid --backend exits non-zero', () => {
  const tmpFile = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-')) + '/a.wav';
  fs.writeFileSync(tmpFile, '');
  try {
    const r = runCli(['transcribe', '--backend', 'cuda', tmpFile]);
    assert(r.status !== 0, `expected non-zero exit, got ${r.status}`);
    assert(r.stderr.includes('--backend'), 'stderr should mention --backend');
  } finally {
    try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch (_) {}
  }
});

test('transcribe with invalid --format exits non-zero', () => {
  const tmpFile = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-')) + '/a.wav';
  fs.writeFileSync(tmpFile, '');
  try {
    const r = runCli(['transcribe', '--format', 'srt', tmpFile]);
    assert(r.status !== 0, `expected non-zero exit, got ${r.status}`);
    assert(r.stderr.includes('--format'), 'stderr should mention --format');
  } finally {
    try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch (_) {}
  }
});

test('transcribe --diarize without HF token exits non-zero before any work', () => {
  const tmpFile = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-')) + '/a.wav';
  fs.writeFileSync(tmpFile, '');
  try {
    const r = runCli(['transcribe', '--diarize', tmpFile]);
    assert(r.status !== 0, `expected non-zero exit, got ${r.status}`);
    assert(r.stderr.includes('HF_TOKEN') || r.stderr.includes('hf-token'),
      `stderr should mention HF token, got: ${r.stderr}`);
  } finally {
    try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch (_) {}
  }
});

test('transcribe accepts --anti-corruption flag combo (parses successfully)', () => {
  // Pass a valid model id but missing file, so we exit on file-not-found AFTER arg parsing succeeded.
  const r = runCli(['transcribe', '--model', 'tiny.en', '--anti-corruption', '--quiet', '/no/such/file.wav']);
  assert(r.status !== 0, 'should fail because file is missing');
  assert(r.stderr.includes('not found'), 'should reach file-existence check (i.e. arg parsing succeeded)');
});

function withEmptyInput(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
  const file = path.join(dir, 'a.wav');
  fs.writeFileSync(file, '');
  try {
    return fn(file);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

test('invalid job mode fails with the shared validation code before subprocess work', () => withEmptyInput((file) => {
  const r = runCli(['transcribe', '--job-mode', 'summarize', file]);
  assert(r.status !== 0, 'should fail');
  assert(r.stderr.includes('INVALID_JOB_MODE'), `expected shared code, got: ${r.stderr}`);
  assert(!r.stderr.includes('ffmpeg'), 'should fail before FFmpeg');
}));

test('translation rejects a model without translation support', () => withEmptyInput((file) => {
  const r = runCli(['transcribe', '--model', 'tiny.en', '--job-mode', 'translate', '--target-language', 'en', file]);
  assert(r.status !== 0, 'should fail');
  assert(r.stderr.includes('TRANSLATION_UNSUPPORTED'), `expected shared code, got: ${r.stderr}`);
}));

test('translation requires a target language', () => withEmptyInput((file) => {
  const r = runCli(['transcribe', '--model', 'tiny', '--job-mode', 'translate', file]);
  assert(r.status !== 0, 'should fail');
  assert(r.stderr.includes('TARGET_LANGUAGE_REQUIRED'), `expected shared code, got: ${r.stderr}`);
}));

test('translation rejects an unsupported language pair', () => withEmptyInput((file) => {
  const r = runCli(['transcribe', '--model', 'canary-180m-flash', '--job-mode', 'translate', '--source-language', 'en', '--target-language', 'zh', file]);
  assert(r.status !== 0, 'should fail');
  assert(r.stderr.includes('TRANSLATION_PAIR_UNSUPPORTED'), `expected shared code, got: ${r.stderr}`);
}));

test('source language uses the shared fixed-language validation', () => withEmptyInput((file) => {
  const r = runCli(['transcribe', '--model', 'tiny.en', '--source-language', 'fr', file]);
  assert(r.status !== 0, 'should fail');
  assert(r.stderr.includes('SOURCE_LANGUAGE_FIXED'), `expected shared code, got: ${r.stderr}`);
}));

test('multilingual Whisper accepts an explicit source language', () => withEmptyInput((file) => {
  const r = runCli(['transcribe', '--backend', 'cpu', '--model', 'small', '--job-mode', 'translate', '--source-language', 'fr', '--target-language', 'en', file]);
  assert(r.status !== 0, 'empty input or missing model should prevent inference success');
  assert(!r.stderr.includes('SOURCE_LANGUAGE_UNSUPPORTED'), `explicit language should validate, got: ${r.stderr}`);
  assert(!r.stderr.includes('TRANSLATION_PAIR_UNSUPPORTED'), `translation pair should validate, got: ${r.stderr}`);
}));

test('required source language is enforced before subprocess work', () => withEmptyInput((file) => {
  const r = runCli(['transcribe', '--model', 'canary-180m-flash', file]);
  assert(r.status !== 0, 'should fail');
  assert(r.stderr.includes('SOURCE_LANGUAGE_REQUIRED'), `expected shared code, got: ${r.stderr}`);
}));

test('reduce repeated text rejects unsupported models', () => withEmptyInput((file) => {
  const r = runCli(['transcribe', '--model', 'moonshine-tiny', '--reduce-repeated-text', file]);
  assert(r.status !== 0, 'should fail');
  assert(r.stderr.includes('REPETITION_CONTROL_UNSUPPORTED'), `expected shared code, got: ${r.stderr}`);
}));

test('anti-corruption alias uses repetition validation', () => withEmptyInput((file) => {
  const r = runCli(['transcribe', '--model', 'moonshine-tiny', '--anti-corruption', file]);
  assert(r.status !== 0, 'should fail');
  assert(r.stderr.includes('REPETITION_CONTROL_UNSUPPORTED'), `expected shared code, got: ${r.stderr}`);
}));

test('unsupported diarization fails before token or Python checks', () => withEmptyInput((file) => {
  const r = runCli(['transcribe', '--model', 'moonshine-tiny', '--diarize', file]);
  assert(r.status !== 0, 'should fail');
  assert(r.stderr.includes('SPEAKER_LABELS_UNSUPPORTED'), `expected shared code, got: ${r.stderr}`);
  assert(!r.stderr.includes('requires --hf-token'), 'capability validation should happen first');
}));

test('speaker count requires diarization', () => withEmptyInput((file) => {
  const r = runCli(['transcribe', '--model', 'tiny.en', '--num-speakers', '2', file]);
  assert(r.status !== 0, 'should fail');
  assert(r.stderr.includes('EXPECTED_SPEAKERS_REQUIRES_LABELS'), `expected shared code, got: ${r.stderr}`);
}));

test('MOSS remains visible but transcription is deferred', () => withEmptyInput((file) => {
  const r = runCli(['transcribe', '--model', 'moss-transcribe-diarize', file]);
  assert(r.status !== 0, 'should fail');
  assert(r.stderr.includes('deferred'), `expected deferred explanation, got: ${r.stderr}`);
  assert(r.stderr.includes('compatible transcribe.cpp release'), 'should explain runtime availability');
}));

test('transcribe --num-speakers requires a positive integer', () => {
  const tmpFile = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-')) + '/a.wav';
  fs.writeFileSync(tmpFile, '');
  try {
    const r = runCli(['transcribe', '--num-speakers', 'foo', '--diarize', '--hf-token', 'hf_x', tmpFile]);
    assert(r.status !== 0, 'should fail');
    assert(r.stderr.includes('--num-speakers'), 'stderr should mention num-speakers');
  } finally {
    try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch (_) {}
  }
});

for (const invalid of ['2.5', '2abc']) {
  test(`transcribe --num-speakers rejects the complete value ${invalid}`, () => withEmptyInput((file) => {
    const r = runCli(['transcribe', '--num-speakers', invalid, '--diarize', '--hf-token', 'hf_x', file]);
    assert(r.status !== 0, 'should fail');
    assert(r.stderr.includes('--num-speakers'), `stderr should mention num-speakers, got: ${r.stderr}`);
  }));
}

// --- download-model ---

console.log('\ndownload-model subcommand tests\n');

test('download-model --help exits 0', () => {
  const r = runCli(['download-model', '--help']);
  assert(r.status === 0, `expected exit 0, got ${r.status}`);
  assert(r.stdout.includes('Hugging Face'), 'help should mention Hugging Face');
  assert(r.stdout.includes('--hf-token'), 'help should mention authenticated downloads');
});

test('download-model with no id exits non-zero', () => {
  const r = runCli(['download-model']);
  assert(r.status !== 0, `expected non-zero exit, got ${r.status}`);
  assert(r.stderr.includes('missing'), 'stderr should mention missing id');
});

test('download-model with unknown id exits non-zero', () => {
  const r = runCli(['download-model', 'no-such-id']);
  assert(r.status !== 0, `expected non-zero exit, got ${r.status}`);
  assert(r.stderr.includes('Unknown model'), `stderr should mention unknown model, got: ${r.stderr}`);
});

test('download-model parses --quiet flag', () => {
  // Unknown id still rejected, but at least --quiet is accepted by parser
  const r = runCli(['download-model', '--quiet', 'no-such-id']);
  assert(r.status !== 0, 'should still fail on unknown id');
  assert(!r.stderr.includes('Unknown flag'), 'should not reject --quiet as unknown');
});

test('download-model rejects a deferred runtime before network work', () => {
  const r = runCli(['download-model', 'moss-transcribe-diarize']);
  assert(r.status !== 0, 'should fail');
  assert(r.stderr.includes('deferred'), `expected deferred explanation, got: ${r.stderr}`);
  assert(r.stderr.includes('compatible transcribe.cpp release'), 'should explain runtime availability');
});

test('non-Whisper SIGINT awaits shutdown and exits promptly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-sigint-test-'));
  const input = path.join(dir, 'input.wav');
  const preload = path.join(dir, 'fake-runner.js');
  const readyMarker = path.join(dir, 'ready.txt');
  const shutdownMarker = path.join(dir, 'shutdown.txt');
  fs.writeFileSync(input, '');
  fs.writeFileSync(preload, `
const fs = require('fs');
const Module = require('module');
const originalLoad = Module._load;
process.on('message', (message) => {
  if (message === 'fake-sigint') process.emit('SIGINT');
});
Module._load = function(request, parent, isMain) {
  if (request === './lib/transcription-runner' && parent && /cli\\.js$/.test(parent.filename)) {
    return {
      createTranscriptionRunner() {
        return {
          runTranscription({ signal }) {
            fs.writeFileSync(process.env.FAKE_READY_MARKER, 'ready');
            return new Promise((resolve, reject) => {
              const cancel = () => reject(new Error('Cancelled'));
              if (signal.aborted) cancel();
              else signal.addEventListener('abort', cancel, { once: true });
            });
          },
          async shutdown() {
            await new Promise((resolve) => setTimeout(resolve, 40));
            fs.writeFileSync(process.env.FAKE_SHUTDOWN_MARKER, 'done');
          },
        };
      },
    };
  }
  return originalLoad.apply(this, arguments);
};
`);

  try {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [CLI, 'transcribe', '--backend', 'cpu', '--model', 'moonshine-tiny', input], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${preload}`,
        FAKE_READY_MARKER: readyMarker,
        FAKE_SHUTDOWN_MARKER: shutdownMarker,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    const readyDeadline = Date.now() + 1500;
    while (!fs.existsSync(readyMarker) && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert(fs.existsSync(readyMarker), `fake runner did not start: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const exitPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`CLI hung after SIGINT (shutdown=${fs.existsSync(shutdownMarker)}): ${stderr}`));
      }, 2000);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    child.send('fake-sigint');
    const result = await exitPromise;
    assert(result.code === 130, `expected exit 130, got code=${result.code} signal=${result.signal}`);
    assert(Date.now() - startedAt < 2000, 'SIGINT exit should be prompt');
    assert(fs.existsSync(shutdownMarker), 'CLI should await runner shutdown before exiting');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gated download requires a supplied or environment token before network work', () => {
  const r = runCli(['download-model', 'medasr']);
  assert(r.status !== 0, 'should fail');
  assert(r.stderr.includes('--hf-token') && r.stderr.includes('HF_TOKEN'), `expected token paths, got: ${r.stderr}`);
  assert(r.stderr.includes('huggingface.co/google/medasr'), 'should show the access request URL');
});

test('download token flag parses and is never printed', () => {
  const token = 'hf_cli_test_secret';
  const r = runCli(['download-model', '--hf-token', token, 'no-such-id']);
  assert(r.status !== 0, 'should fail on unknown id');
  assert(!r.stderr.includes('Unknown flag'), 'should accept --hf-token');
  assert(!r.stdout.includes(token) && !r.stderr.includes(token), 'must not print the token');
});

test('gated download accepts HF_TOKEN without printing it', () => {
  const modelPath = path.join(__dirname, '..', 'models', 'medasr-Q8_0.gguf');
  const existed = fs.existsSync(modelPath);
  const token = 'hf_cli_env_test_secret';
  if (!existed) fs.writeFileSync(modelPath, 'test placeholder');
  try {
    const r = runCli(['download-model', 'medasr'], { env: { HF_TOKEN: token } });
    assert(r.status === 0, `expected accepted environment token, got: ${r.stderr}`);
    assert(r.stderr.includes('already downloaded'), 'should pass gated validation before the disk check');
    assert(!r.stdout.includes(token) && !r.stderr.includes(token), 'must not print the environment token');
  } finally {
    if (!existed) {
      try { fs.unlinkSync(modelPath); } catch (_) {}
    }
  }
});

// --- list-models ---

console.log('\nlist-models subcommand tests\n');

test('list-models --help exits 0', () => {
  const r = runCli(['list-models', '--help']);
  assert(r.status === 0, `expected exit 0, got ${r.status}`);
  assert(r.stdout.length > 0, 'help should be non-empty');
});

test('list-models default prints a table with headers', () => {
  const r = runCli(['list-models']);
  assert(r.status === 0, `expected exit 0, got ${r.status}`);
  assert(r.stdout.includes('ID'), 'table should include ID header');
  assert(r.stdout.includes('Label'), 'table should include Label header');
  assert(r.stdout.includes('Downloaded'), 'table should include Downloaded header');
  assert(r.stdout.includes('Task'), 'table should include Task header');
  assert(r.stdout.includes('Status'), 'table should include Status header');
  assert(r.stdout.includes('Languages'), 'table should include Languages header');
  assert(r.stdout.includes('Licence'), 'table should include Licence header');
  assert(r.stdout.includes('Capabilities'), 'table should include Capabilities header');
  assert(r.stdout.includes('tiny.en'), 'table should include tiny.en row');
  assert(r.stdout.includes('moss-transcribe-diarize'), 'table should keep MOSS visible');
  assert(r.stdout.includes('unavailable'), 'table should mark unavailable runtimes');
});

test('list-models --json emits valid JSON to stdout', () => {
  const r = runCli(['list-models', '--json']);
  assert(r.status === 0, `expected exit 0, got ${r.status}`);
  const parsed = JSON.parse(r.stdout);
  assert(Array.isArray(parsed), 'should be an array');
  assert(parsed.length === 19, `should have all 19 curated models, got ${parsed.length}`);
  assert(parsed.every((m) => typeof m.id === 'string'), 'every entry should have id');
  assert(parsed.every((m) => typeof m.downloaded === 'boolean'), 'every entry should have downloaded flag');
  for (const model of parsed) {
    assert(typeof model.task === 'string', `${model.id} should have task`);
    assert(typeof model.status === 'string', `${model.id} should have status`);
    assert(Array.isArray(model.languages) && model.languages.length > 0, `${model.id} should have languages`);
    assert(typeof model.size === 'string', `${model.id} should have size`);
    assert(typeof model.licence === 'string', `${model.id} should have licence`);
    assert(model.capabilities && typeof model.capabilities === 'object', `${model.id} should have capabilities`);
  }
  assert(!r.stdout.includes('sha256'), 'presentation JSON should omit checksums');
  assert(!r.stdout.includes('repository'), 'presentation JSON should omit internal repository fields');
  const moss = parsed.find((model) => model.id === 'moss-transcribe-diarize');
  assert(moss.status === 'experimental', 'MOSS should remain experimental');
  assert(moss.availability === 'deferred', 'MOSS should be deferred');
  assert(moss.capabilities.runtimeAvailable === false, 'MOSS runtime should be unavailable');
});

// --- gpu-status ---

console.log('\ngpu-status subcommand tests\n');

test('gpu-status --help exits 0', () => {
  const r = runCli(['gpu-status', '--help']);
  assert(r.status === 0, `expected exit 0, got ${r.status}`);
  assert(r.stdout.length > 0, 'help should be non-empty');
});

test('gpu-status default prints human-readable status', () => {
  const r = runCli(['gpu-status']);
  assert(r.status === 0, `expected exit 0, got ${r.status}`);
  assert(r.stdout.includes('Backend'), 'should print Backend line');
  assert(r.stdout.includes('DTW supported'), 'should print DTW supported line');
});

test('gpu-status --json emits valid JSON', () => {
  const r = runCli(['gpu-status', '--json']);
  assert(r.status === 0, `expected exit 0, got ${r.status}`);
  const parsed = JSON.parse(r.stdout);
  assert(typeof parsed.backend === 'string', 'should have backend');
  assert(Array.isArray(parsed.available), 'should have available array');
  assert(typeof parsed.dtwSupported === 'boolean', 'should have dtwSupported flag');
});

// --- stdout/stderr separation ---

console.log('\nstream separation tests\n');

test('list-models output is all stdout, not stderr', () => {
  const r = runCli(['list-models']);
  assert(r.stdout.length > 0, 'stdout should be non-empty');
  assert(r.stderr.length === 0, `stderr should be empty, got: ${r.stderr}`);
});

test('error messages go to stderr, not stdout', () => {
  const r = runCli(['transcribe', '/does/not/exist.wav']);
  assert(r.status !== 0, 'should fail');
  assert(r.stderr.length > 0, 'stderr should have the error');
  // stdout is allowed to be empty; the important thing is the error is on stderr.
  assert(!r.stdout.includes('not found'), 'error text should not appear on stdout');
});

// ---------------------------------------------------------------------------

runAll();
