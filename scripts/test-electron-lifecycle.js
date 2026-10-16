#!/usr/bin/env node
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');

function alive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      // A reaped parent's orphan can briefly be a zombie, which cannot execute.
      const status = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      if (/^\d+ \(.+\) Z /.test(status)) return false;
    }
    return true;
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'ENOENT') return false;
    throw error;
  }
}
try {
  for (const stage of ['ffmpeg', 'whisper', 'alignment', 'diarization', 'setup', 'download', 'probe']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-lifecycle-'));
    const nonce = randomUUID();
    try {
      fs.writeFileSync(path.join(directory, 'input.wav'), 'fixture');
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const started = Date.now();
      const run = spawnSync(require('electron'), [
        path.join(__dirname, 'fixtures/electron-lifecycle/main.js'), directory, stage, nonce,
        stage === 'setup' ? 'update' : 'quit',
        '--user-data-dir=' + path.join(directory, 'profile'),
      ], { env, encoding: 'utf8', timeout: 25000, maxBuffer: 1024 * 1024 });
      assert.ifError(run.error);
      assert.equal(run.status, 0, stage + ': ' + run.stdout + run.stderr);
      const result = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'));
      assert.equal(result.nonce, nonce);
      assert.equal(result.passed, true);
      const children = fs.readFileSync(path.join(directory, 'child.json'), 'utf8').trim().split('\n').map(JSON.parse);
      for (const child of children) {
        assert.equal(alive(child.pid), false, stage + ': parent survives');
        assert.equal(alive(child.descendant), false, stage + ': descendant survives');
      }
      assert.ok(Date.now() - started < 15000, 'Shutdown must finish within its bound');
      console.log('Electron lifecycle: ' + stage + ' cleanup and process tree passed');
    } finally {
      const marker = path.join(directory, 'child.json');
      if (fs.existsSync(marker)) {
        for (const child of fs.readFileSync(marker, 'utf8').trim().split('\n').map(JSON.parse)) {
          if (alive(child.pid) || alive(child.descendant)) {
            if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
            else { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {} }
          }
        }
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
} catch (error) { console.error(error.stack); process.exitCode = 1; }
