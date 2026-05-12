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

const { spawnSync } = require('child_process');
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

// --- download-model ---

console.log('\ndownload-model subcommand tests\n');

test('download-model --help exits 0', () => {
  const r = runCli(['download-model', '--help']);
  assert(r.status === 0, `expected exit 0, got ${r.status}`);
  assert(r.stdout.includes('Hugging Face'), 'help should mention Hugging Face');
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
  assert(r.stdout.includes('tiny.en'), 'table should include tiny.en row');
});

test('list-models --json emits valid JSON to stdout', () => {
  const r = runCli(['list-models', '--json']);
  assert(r.status === 0, `expected exit 0, got ${r.status}`);
  const parsed = JSON.parse(r.stdout);
  assert(Array.isArray(parsed), 'should be an array');
  assert(parsed.length > 0, 'should have models');
  assert(parsed.every((m) => typeof m.id === 'string'), 'every entry should have id');
  assert(parsed.every((m) => typeof m.downloaded === 'boolean'), 'every entry should have downloaded flag');
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
