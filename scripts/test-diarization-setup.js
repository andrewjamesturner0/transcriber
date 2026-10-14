#!/usr/bin/env node
/**
 * Tests for lib/diarization-setup.js (user-directed model setup, D2).
 *
 * Usage:
 *     node scripts/test-diarization-setup.js
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createDiarizationSetup } = require('../lib/diarization-setup');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-test-'));
fs.mkdirSync(path.join(ROOT, 'scripts'));
fs.writeFileSync(path.join(ROOT, 'scripts', 'setup-diarization.py'), '');
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {} });

let passed = 0;
let failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function fakeSpawn({ stdout = '', stderr = [], code = 0, calls }) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], env: opts.env });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => process.nextTick(() => proc.emit('close', null));
    process.nextTick(() => {
      for (const c of stderr) proc.stderr.emit('data', Buffer.from(c));
      if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
      proc.emit('close', code);
    });
    return proc;
  };
}

function makeSetup(spawnOpts, python = { command: '/venv/bin/python', args: [] }) {
  const calls = [];
  const logs = [];
  let refreshed = 0;
  const setup = createDiarizationSetup({
    capabilities: {
      getPythonSpawn: async () => python,
      getPythonInfo: async (opts) => { if (opts && opts.refresh) refreshed++; return {}; },
    },
    paths: { getResourcePath: (rel) => path.join(ROOT, rel), makeEnvWithLibPath: () => ({ PATH: '/usr/bin' }) },
    spawn: fakeSpawn({ ...spawnOpts, calls }),
    log: (m) => logs.push(m),
  });
  return { setup, calls, logs, refreshCount: () => refreshed };
}

const SUMMARY = JSON.stringify({ status: 'ready', model: { id: 'pyannote/speaker-diarization-community-1' } });

test('token travels in the child environment only, never argv or logs', async () => {
  const { setup, calls, logs } = makeSetup({ stdout: SUMMARY + '\n' });
  const summary = await setup.prepare({ token: 'hf_secret_123' });
  assert(summary.status === 'ready', JSON.stringify(summary));
  assert(calls[0].env.HF_TOKEN === 'hf_secret_123', 'token in env');
  assert(!calls[0].args.some((a) => a.includes('hf_secret')), 'token not in argv');
  assert(!logs.some((l) => l.includes('hf_secret')), 'token not logged');
});

test('progress lines are forwarded and capabilities are re-probed after success', async () => {
  const seen = [];
  const line = JSON.stringify({ message: 'Downloading speaker model...', percent: 40 }) + '\n';
  const { setup, refreshCount } = makeSetup({ stdout: SUMMARY, stderr: [line.slice(0, 9), line.slice(9)] });
  await setup.prepare({ token: 't', onProgress: (p) => seen.push(p) });
  assert(seen.length === 1 && seen[0].percent === 40, JSON.stringify(seen));
  assert(refreshCount() === 1, 'refreshed once');
});

test('helper error message is surfaced instead of the exit code', async () => {
  const err = JSON.stringify({ error: 'Accept the licence at hf.co/pyannote/speaker-diarization-community-1', code: 'model-access-denied' }) + '\n';
  const { setup } = makeSetup({ stderr: [err], code: 1 });
  let caught = null;
  try { await setup.prepare({ token: 't' }); } catch (e) { caught = e; }
  assert(caught && caught.message.startsWith('Accept the licence'), caught && caught.message);
});

test('py launcher prefix and --alignment are passed through', async () => {
  const { setup, calls } = makeSetup({ stdout: SUMMARY }, { command: 'py', args: ['-3'] });
  await setup.prepare({ token: 't', alignment: true });
  assert(calls[0].cmd === 'py' && calls[0].args[0] === '-3', JSON.stringify(calls[0].args));
  assert(calls[0].args.includes('--alignment'), 'alignment flag');
});

test('missing Python fails clearly without spawning', async () => {
  const { setup, calls } = makeSetup({}, null);
  let caught = null;
  try { await setup.prepare({ token: 't' }); } catch (e) { caught = e; }
  assert(caught && /Python 3\.10/.test(caught.message) && calls.length === 0, caught && caught.message);
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log(`  PASS: ${name}`); passed++; } catch (e) { console.log(`  FAIL: ${name} -- ${e.message}`); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
