#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const deps = require('../deps.json');

function fail(message) {
  process.stderr.write(`transcribe.cpp runtime check failed: ${message}\n`);
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${file} is missing or invalid: ${error.message}`);
  }
}

function packageDir(packageName) {
  return path.join(root, 'node_modules', ...packageName.split('/'));
}

const requested = process.argv[2] || (process.platform === 'win32' ? 'win32-x64' : 'linux-x64');
if (!['linux-x64', 'win32-x64'].includes(requested)) {
  fail('target must be linux-x64 or win32-x64');
}

const runtime = deps.transcribeCpp;
if (!runtime || !runtime.version || !runtime.binding?.integrity || !runtime[requested]?.integrity) {
  fail(`deps.json has no complete pin and checksum set for ${requested}`);
}

const bindingManifest = readJson(path.join(packageDir(runtime.binding.package), 'package.json'));
if (bindingManifest.version !== runtime.version) {
  fail(`expected ${runtime.binding.package} ${runtime.version}, found ${bindingManifest.version}`);
}

const koffiManifest = readJson(path.join(packageDir('koffi'), 'package.json'));
if (koffiManifest.version !== runtime.koffi.version) {
  fail(`expected koffi ${runtime.koffi.version}, found ${koffiManifest.version}`);
}

const native = runtime[requested];
const nativeDir = packageDir(native.package);
const nativeManifest = readJson(path.join(nativeDir, 'package.json'));
if (nativeManifest.version !== runtime.version) {
  fail(`expected ${native.package} ${runtime.version}, found ${nativeManifest.version}`);
}
for (const required of [native.library, 'contract.json']) {
  if (!fs.existsSync(path.join(nativeDir, required))) {
    fail(`${native.package} is missing ${required}`);
  }
}

const platform = requested.startsWith('win32') ? 'win32' : 'linux';
const koffiProvider = `@koromix/koffi-${platform}-x64`;
const providerManifest = readJson(path.join(packageDir(koffiProvider), 'package.json'));
if (providerManifest.version !== runtime.koffi.version) {
  fail(`expected ${koffiProvider} ${runtime.koffi.version}, found ${providerManifest.version}`);
}

process.stdout.write(`transcribe.cpp ${runtime.version} runtime ready for ${requested}\n`);
