#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const executable = process.argv[2];
const worker = process.argv[3];
if (!executable || !worker) {
  process.stderr.write('Usage: node scripts/smoke-packaged-worker.js <electron-executable> <worker-path>\n');
  process.exit(1);
}

for (const file of [executable, worker]) {
  if (!fs.existsSync(file)) {
    process.stderr.write(`Packaged worker smoke file is missing: ${file}\n`);
    process.exit(1);
  }
}

const unpackedRoot = path.resolve(path.dirname(worker), '..');
const nativeRelative = process.platform === 'win32'
  ? ['node_modules', '@transcribe-cpp', 'win32-x64-cpu-vulkan', 'transcribe.dll']
  : ['node_modules', '@transcribe-cpp', 'linux-x64-cpu-vulkan', 'libtranscribe.so'];
const nativeLibrary = path.join(unpackedRoot, ...nativeRelative);
if (!fs.existsSync(nativeLibrary)) {
  process.stderr.write(`Packaged native library is missing: ${nativeLibrary}\n`);
  process.exit(1);
}

const result = spawnSync(executable, [worker], {
  input: '{"id":"packaged-smoke","op":"shutdown"}\n',
  encoding: 'utf8',
  timeout: 15000,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
if (result.status !== 0) {
  process.stderr.write(result.stderr || `Packaged worker exited with ${result.status}\n`);
  process.exit(1);
}
let reply;
try {
  reply = JSON.parse(result.stdout.trim());
} catch (_) {
  process.stderr.write(`Packaged worker returned invalid output: ${result.stdout}\n`);
  process.exit(1);
}
if (!reply.ok || !reply.result?.shutdown) {
  process.stderr.write(`Packaged worker returned an unexpected reply: ${result.stdout}\n`);
  process.exit(1);
}
process.stdout.write('Packaged transcribe.cpp worker smoke passed\n');
