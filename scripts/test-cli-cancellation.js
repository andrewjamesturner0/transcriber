#!/usr/bin/env node
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const cli = path.join(__dirname, '..', 'cli.js');
const preload = path.join(__dirname, 'fixtures/cli-runtime/probe-preload.js');
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
function alive(pid) { try {
  process.kill(pid, 0);
  if (process.platform === 'linux' && /^\d+ \(.+\) Z /.test(fs.readFileSync('/proc/' + pid + '/stat', 'utf8'))) return false;
  return true; } catch (error) { if (error.code === 'ESRCH' || error.code === 'ENOENT') return false; throw error; } }

(async () => {
  for (const [command, stage, flags] of [
    ['transcribe', 'gpu', []], ['gpu-status', 'gpu', ['--json']],
    ['transcribe', 'python-version', ['--backend', 'cpu', '--diarize']],
    ['transcribe', 'alignment', ['--backend', 'cpu', '--diarize']],
    ...(process.platform === 'win32' ? [] : [['gpu-status', 'gpu-resistant', ['--json']]]),
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-cli-probe-'));
    const input = path.join(root, 'input.wav');
    const marker = path.join(root, 'probe-pids');
    let child;
    let exited = false;
    try {
      fs.writeFileSync(input, 'fixture');
      const args = [command, ...(command === 'transcribe' ? [input, '--quiet'] : []), ...flags];
      child = spawn(process.execPath, ['--require', preload, cli, ...args], {
        detached: process.platform !== 'win32',
        stdio: process.platform === 'win32' ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TRANSCRIBER_CLI_FIXTURE_ROOT: root, TRANSCRIBER_CLI_PROBE_STAGE: stage },
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });
      const outcome = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => { exited = true; resolve({ code, signal }); });
      });
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(marker)) {
        assert.ok(!exited && Date.now() < deadline, 'Probe never started: ' + stage + ' ' + stderr);
        await pause();
      }
      if (process.platform === 'win32') child.send('fixture-interrupt');
      else process.kill(-child.pid, 'SIGINT');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
      if (stage === 'gpu-resistant') {
        while (!fs.existsSync(path.join(root, 'parent-closed'))) {
          assert.ok(!exited && Date.now() < deadline, 'Parent must close during disposal');
          await pause();
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        process.kill(-child.pid, 'SIGINT');
      }
      const result = await outcome;
      clearTimeout(timeout);
      assert.deepEqual(result, { code: 130, signal: null }, stderr);
      assert.equal(stdout, '');
      for (const pid of fs.readFileSync(marker, 'utf8').trim().split('\n').map(Number)) {
        assert.equal(alive(pid), false, 'Detached probe survived Ctrl+C: ' + pid);
      }
      const descendantFile = path.join(root, 'descendant-pid');
      if (fs.existsSync(descendantFile)) assert.equal(alive(Number(fs.readFileSync(descendantFile, 'utf8'))), false, 'Resistant descendant must stop despite second Ctrl+C');
      console.log('PASS: CLI cancellation during ' + command + ' ' + stage + ' cleans real probe');
    } finally {
      if (child && !exited) child.kill('SIGKILL');
      if (fs.existsSync(marker)) for (const pid of fs.readFileSync(marker, 'utf8').trim().split('\n').map(Number)) {
        if (alive(pid) || (process.platform !== 'win32' && fs.existsSync(path.join(root, 'descendant-pid')))) {
          if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
          else { try { process.kill(-pid, 'SIGKILL'); } catch (_) {} }
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
