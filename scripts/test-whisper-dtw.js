#!/usr/bin/env node
// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

/**
 * Opt-in real-binary DTW check.
 *
 * Runs the bundled whisper-cli with the same arguments production uses for
 * a diarised job (built by lib/whisper-runner.js), then checks that every
 * text token in the JSON output has a valid DTW anchor (t_dtw). Downloads
 * nothing: the binary, model and audio must already be on disk.
 *
 * Usage:
 *     node scripts/test-whisper-dtw.js --backend cpu|vulkan --audio <wav> --model <id> [--keep <dir>]
 *
 * Exit codes:
 *     0  PASS - every text token has a valid anchor inside the audio
 *     1  FAIL - with reason (disable warning, missing anchors, out of range...)
 *     2  SKIP - with reason (binary, model or audio missing, backend
 *               unavailable, flags unsupported, bad arguments)
 *
 * --keep <dir> runs in <dir> and leaves the JSON output there; otherwise a
 * temp dir is used and removed.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const paths = require('../lib/paths');
paths.initPaths({ isPackaged: false, resourcesPath: REPO_ROOT });
const models = require('../lib/models');
const Capabilities = require('../lib/capabilities');
const { _buildWhisperArgs, _findDtwDisableWarning } = require('../lib/whisper-runner');

const USAGE = 'Usage: node scripts/test-whisper-dtw.js --backend cpu|vulkan --audio <wav> --model <id> [--keep <dir>]';
const SAMPLE_COUNT = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pass(msg) { console.log(`\nPASS: ${msg}`); process.exit(0); }
function fail(msg) { console.log(`\nFAIL: ${msg}`); process.exit(1); }
function skip(msg) { console.log(`\nSKIP: ${msg}`); process.exit(2); }

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!['--backend', '--audio', '--model', '--keep'].includes(a)) {
      skip(`bad arguments: unknown option ${a}\n${USAGE}`);
    }
    if (i + 1 >= argv.length) skip(`bad arguments: ${a} needs a value\n${USAGE}`);
    out[a.slice(2)] = argv[++i];
  }
  if (!out.backend || !out.audio || !out.model) skip(`bad arguments: --backend, --audio and --model are required\n${USAGE}`);
  if (!['cpu', 'vulkan'].includes(out.backend)) skip(`bad arguments: --backend must be cpu or vulkan\n${USAGE}`);
  return out;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/** Run a command; resolve { code, stdout, stderr } (never rejects on exit code). */
function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, opts);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', reject);
  });
}

/** Return the duration in ms of a PCM WAV file, or null if it cannot be read. */
function wavDurationMs(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (_) { return null; }
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let byteRate = null;
  let dataBytes = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(off + 16);
    if (id === 'data') { dataBytes = Math.min(size, buf.length - off - 8); break; }
    off += 8 + size + (size % 2);
  }
  if (!byteRate || dataBytes == null) return null;
  return (dataBytes / byteRate) * 1000;
}

/** Library files whose hash identifies the whisper build next to the binary. */
function whisperLibs(dir) {
  return fs.readdirSync(dir)
    .filter((f) => /^libwhisper.*\.so(\..*)?$/.test(f) || /^libwhisper.*\.dylib$/.test(f) || /^whisper\.dll$/i.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

function isValidAnchor(t) {
  return typeof t === 'number' && Number.isInteger(t) && t >= 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const backend = opts.backend;
  const audioPath = path.resolve(opts.audio);

  // --- Inputs --------------------------------------------------------------

  const whisperBin = paths.getWhisperBinary(backend);
  if (!fs.existsSync(whisperBin)) skip(`${backend} whisper-cli not found at ${whisperBin}`);

  let modelSpec;
  try { modelSpec = models.getModel(opts.model); } catch (err) { skip(`bad arguments: ${err.message}`); }
  if (modelSpec.tdrz || !modelSpec.dtwPreset) skip(`model ${opts.model} has no DTW preset`);
  const modelPath = models.getModelPath(opts.model);
  if (!fs.existsSync(modelPath)) skip(`model not found at ${modelPath} (this check never downloads)`);

  if (!fs.existsSync(audioPath)) skip(`audio not found at ${audioPath}`);
  const durationMs = wavDurationMs(audioPath);
  if (durationMs == null) skip(`audio is not a readable PCM WAV file: ${audioPath}`);

  // --- Identify the build --------------------------------------------------

  const binDir = path.dirname(whisperBin);
  console.log(`Backend:        ${backend}`);
  console.log(`Executable:     ${whisperBin}`);
  console.log(`  sha256        ${await sha256(whisperBin)}`);
  for (const lib of whisperLibs(binDir)) {
    console.log(`Library:        ${lib}`);
    console.log(`  sha256        ${await sha256(lib)}`);
  }
  console.log(`Model:          ${opts.model} (${modelPath})`);
  console.log(`  sha256        ${await sha256(modelPath)}`);
  console.log(`Audio:          ${audioPath} (${(durationMs / 1000).toFixed(2)} s)`);

  // --- --help probe: flags and, for Vulkan, devices -------------------------

  const env = paths.makeEnvWithLibPath(binDir);
  const help = await run(whisperBin, ['--help'], { env, timeout: 5000 });
  const helpText = help.stdout + help.stderr;
  const hasDtw = /--dtw\b/i.test(helpText);
  const hasNfa = /(?:--no-flash-attn|(?:^|\s)-nfa)\b/i.test(helpText);
  const caps = new Capabilities({ paths, logWrite: () => {} });
  const supported = await caps._detectDtw(backend);
  console.log(`--help:         --dtw ${hasDtw ? 'listed' : 'MISSING'}, --no-flash-attn ${hasNfa ? 'listed' : 'MISSING'} -> capabilities DTW support: ${supported}`);

  if (backend === 'vulkan') {
    const devices = [...helpText.matchAll(/ggml_vulkan:\s*(\d+)\s*=\s*(.+)$/gm)].map((m) => `${m[1]}=${m[2].trim()}`);
    console.log(`Vulkan devices: ${devices.length ? devices.join('; ') : 'none'}`);
    if (devices.length === 0) {
      const line = (helpText.match(/^ggml_vulkan:.*$/m) || ['no ggml_vulkan device lines in --help output'])[0];
      skip(`Vulkan backend unavailable: ${line.trim()} (whisper-cli would run on the CPU, so this would not test Vulkan)`);
    }
  }
  if (help.code !== 0) skip(`${backend} whisper-cli --help exited with code ${help.code}`);
  if (!supported) skip(`${backend} whisper-cli does not list both --dtw and --no-flash-attn`);

  // --- Run whisper-cli with production args --------------------------------

  const keep = !!opts.keep;
  const workDir = keep ? path.resolve(opts.keep) : fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-dtw-'));
  fs.mkdirSync(workDir, { recursive: true });
  const jsonPrefix = path.join(workDir, 'whisper_out');
  // pass()/fail() call process.exit, so clean up from the exit handler.
  if (!keep) process.on('exit', () => fs.rmSync(workDir, { recursive: true, force: true }));

  const args = _buildWhisperArgs(modelPath, audioPath, jsonPrefix, { diarization: true, dtw: true }, modelSpec, () => true);
  if (!args.includes('--dtw') || !args.includes('--no-flash-attn')) {
    fail(`production arg builder did not add --dtw and --no-flash-attn: ${args.join(' ')}`);
  }
  const quoted = [whisperBin, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  console.log(`Command:        ${quoted}`);
  console.log(`Work dir:       ${workDir}${keep ? ' (kept)' : ' (removed afterwards)'}`);

  const res = await run(whisperBin, args, { env, cwd: workDir });
  const warning = _findDtwDisableWarning(res.stderr);
  if (res.code !== 0) {
    const tail = res.stderr.trim().split('\n').slice(-5).join('\n  ');
    fail(`whisper-cli exited with code ${res.code}:\n  ${tail}`);
  }
  if (warning) fail(`whisper-cli disabled DTW: ${warning}`);

  // --- Check anchors -------------------------------------------------------

  const jsonPath = jsonPrefix + '.json';
  if (!fs.existsSync(jsonPath)) fail(`no JSON output at ${jsonPath}`);
  let json;
  try { json = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')); } catch (err) { fail(`JSON output did not parse: ${err.message}`); }

  const tokens = [];
  for (const seg of json.transcription || []) {
    for (const tok of seg.tokens || []) {
      if (typeof tok.text === 'string' && tok.text.startsWith('[_')) continue;
      tokens.push(tok);
    }
  }
  const valid = tokens.filter((t) => isValidAnchor(t.t_dtw));
  const missing = tokens.filter((t) => !isValidAnchor(t.t_dtw));
  const outOfRange = valid.filter((t) => t.t_dtw * 10 > durationMs);

  console.log(`\nText tokens:    ${tokens.length}`);
  console.log(`Valid anchors:  ${valid.length} (t_dtw integer >= 0; zero counts)`);
  console.log(`Missing:        ${missing.length}`);
  console.log(`Out of range:   ${outOfRange.length} (anchor beyond ${durationMs.toFixed(0)} ms)`);
  console.log('Samples (text | offsets ms | t_dtw*10 ms):');
  for (const t of tokens.slice(0, SAMPLE_COUNT)) {
    const off = t.offsets ? `${t.offsets.from}-${t.offsets.to}` : 'n/a';
    const anchor = isValidAnchor(t.t_dtw) ? String(t.t_dtw * 10) : `invalid (${t.t_dtw})`;
    console.log(`  ${JSON.stringify(t.text).padEnd(16)} | ${off.padEnd(11)} | ${anchor}`);
  }

  if (tokens.length === 0) fail('no text tokens in the JSON output');
  if (missing.length > 0) fail(`${missing.length} of ${tokens.length} text tokens have no valid t_dtw anchor`);
  if (outOfRange.length > 0) fail(`${outOfRange.length} anchors fall outside [0, ${durationMs.toFixed(0)}] ms`);
  pass(`all ${tokens.length} text tokens have valid DTW anchors within the audio (${backend})`);
}

main().catch((err) => {
  console.log(`\nFAIL: unexpected error: ${err.stack || err.message}`);
  process.exit(1);
});
