#!/usr/bin/env node
// Exercise the real CLI and runners in a child Node process, with controlled
// subprocess events and temporary resources supplied by a preload fixture.
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cli = path.join(__dirname, '..', 'cli.js');
const preload = path.join(__dirname, 'fixtures', 'cli-runtime', 'preload.js');
let passed = 0;

function run(name, flags, check) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber cli pipeline '));
  try {
    const input = path.join(root, 'input audio.wav');
    const output = path.join(root, 'output transcript.txt');
    fs.writeFileSync(input, 'synthetic fixture input');
    const env = { ...process.env, TRANSCRIBER_CLI_FIXTURE_ROOT: root };
    delete env.HF_TOKEN;
    const args = typeof flags === 'function' ? flags(output) : flags;
    const result = spawnSync(process.execPath, ['--require', preload, cli, 'transcribe', input, ...args], {
      env, encoding: 'utf8', timeout: 15000,
    });
    assert.ifError(result.error);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.signal, null);
    const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'tmp')), [], 'runner must clean temporary outputs');
    check(result, calls, output);
    passed++;
    console.log(`  PASS: ${name}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function plainCalls(calls, json) {
  assert.deepStrictEqual(calls.map((call) => call.stage), ['ffmpeg', 'whisper']);
  assert.strictEqual(calls[1].args.includes('--output-json-full'), json);
  assert.strictEqual(calls[1].args.includes('--no-timestamps'), !json);
  assert(!calls[1].args.includes('--dtw'));
}

for (const quiet of [false, true]) {
  for (const format of ['txt', 'json']) {
    run(`plain ${format}${quiet ? ' quiet' : ''} succeeds through real runner`,
      ['--format', format, ...(quiet ? ['--quiet'] : [])], (result, calls) => {
        plainCalls(calls, format === 'json');
        if (format === 'txt') assert.strictEqual(result.stdout, 'Hello world.\n');
        else assert.strictEqual(JSON.parse(result.stdout).transcription[0].text, 'Hello world.');
        if (quiet) assert.strictEqual(result.stderr, '');
        else {
          assert(result.stderr.includes('Converting audio...'), result.stderr);
          assert(result.stderr.includes('Transcribing (CPU)...'), result.stderr);
        }
        assert(!result.stdout.includes('fixture decoder log'));
      });
  }
}

run('plain --output writes transcript and keeps stdout empty',
  (output) => ['--output', output, '--quiet'], (result, calls, output) => {
    plainCalls(calls, false);
    assert.strictEqual(result.stdout, '');
    assert.strictEqual(result.stderr, '');
    assert.strictEqual(fs.readFileSync(output, 'utf8'), 'Hello world.');
  });

run('labelled default runs forced alignment before diarization',
  ['--diarize', '--format', 'json'], (result, calls) => {
    assert.deepStrictEqual(calls.map((call) => call.stage), ['ffmpeg', 'whisper', 'align', 'diarize']);
    const payload = JSON.parse(result.stdout);
    assert.strictEqual(payload.speakerAttribution.alignment.requested, 'forced');
    assert.strictEqual(payload.speakerAttribution.alignment.status, 'aligned');
    assert(payload.speakerAttribution.words.every((word) => word.timingSource === 'forced'));
    assert(payload.merged.includes('[Speaker 1] Hello world.'), payload.merged);
    assert(result.stderr.includes('Matching words to the audio...'), result.stderr);
    assert(result.stderr.includes('Fixture aligned words (100%)'), result.stderr);
    assert(!result.stderr.includes('failed'), result.stderr);
    assert(!calls[1].args.includes('--dtw'));
  });

run('explicit Whisper timing skips alignment and quiet suppresses helper progress',
  ['--diarize', '--alignment', 'whisper', '--format', 'json', '--quiet'], (result, calls) => {
    assert.deepStrictEqual(calls.map((call) => call.stage), ['ffmpeg', 'whisper', 'diarize']);
    const payload = JSON.parse(result.stdout);
    assert.strictEqual(payload.speakerAttribution.alignment.requested, 'whisper');
    assert.strictEqual(payload.speakerAttribution.alignment.status, 'not-requested');
    assert(payload.merged.includes('[Speaker 1] Hello world.'), payload.merged);
    assert.strictEqual(result.stderr, '');
  });

for (const mode of ['reset', 'cancel', 'success']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber cli download '));
  try {
    const env = { ...process.env, TRANSCRIBER_CLI_FIXTURE_ROOT: root, TRANSCRIBER_CLI_TRANSFER_MODE: mode };
    const invoke = (command, args) => spawnSync(process.execPath, ['--require', preload, cli, command, ...args], {
      env, encoding: 'utf8', timeout: 15000,
    });
    const result = invoke('download-model', ['base', '--quiet']);
    assert.ifError(result.error);
    assert.strictEqual(result.status, mode === 'success' ? 0 : mode === 'cancel' ? 130 : 1, result.stderr);
    assert.strictEqual(result.stdout, '');
    const files = fs.readdirSync(path.join(root, 'models'));
    assert(!files.some((file) => file.endsWith('.download')), 'partial transfers must be removed');
    assert.strictEqual(files.includes('ggml-base.bin'), mode === 'success');
    if (mode === 'success') {
      // The preload leaves existing files alone, so a second command sees installation.
      const listed = invoke('list-models', ['--json']);
      assert.strictEqual(JSON.parse(listed.stdout).find((model) => model.id === 'base').downloaded, true);
      env.TRANSCRIBER_CLI_TRANSFER_MODE = 'reset';
      assert.strictEqual(invoke('download-model', ['base', '--quiet']).status, 0, 'installed file makes download a no-op');
    }
    passed++;
    console.log('  PASS: CLI model transfer ' + mode + ' uses store and safe transport');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

console.log(`\n${passed} passed, 0 failed`);
