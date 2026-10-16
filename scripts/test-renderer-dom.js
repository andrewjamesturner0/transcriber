#!/usr/bin/env node
// Launch the real installed Electron. A failed launch is never a passing test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-renderer-dom-'));
const resultPath = path.join(directory, 'result.json');
const nonce = randomUUID();
try {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(require('electron'), [
    path.join(__dirname, 'fixtures', 'renderer-dom', 'main.js'),
    resultPath, nonce, `--user-data-dir=${path.join(directory, 'profile')}`,
  ], { env, encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024 });
  assert.ifError(run.error);
  assert.equal(run.status, 0, `Electron DOM test failed (${run.signal || run.status})\n${run.stdout || ''}${run.stderr || ''}`);
  assert.ok(fs.existsSync(resultPath), 'Electron must write verified assertion results');
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  assert.equal(result.nonce, nonce, 'Result must belong to this launch');
  assert.equal(result.passed, true);
  assert.ok(result.checks.length >= 20, 'Expected all real DOM assertions');
  console.log(`Renderer DOM: ${result.checks.length} assertions passed in installed Electron ${result.electron}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
