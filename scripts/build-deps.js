#!/usr/bin/env node
// Shared build policy. No runtime dependencies; used on native Windows and Linux.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { pipeline } = require('stream/promises');
const { execFileSync } = require('child_process');
const deps = require('../deps.json');

function digest(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('error', reject);
    input.on('data', data => hash.update(data));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function asset(key, manifest = deps) {
  if (key === 'model') return manifest.model;
  if (key === 'whisper-win') return {
    url: manifest.whisper.releaseUrl.replace('${version}', manifest.whisper.version) + '/' + manifest.whisper.winCpuAsset,
    sha256: manifest.whisper.winCpuSha256,
    size: manifest.whisper.winCpuSize,
  };
  if (key.startsWith('ffmpeg-') && manifest.ffmpeg[key.slice(7)]) return manifest.ffmpeg[key.slice(7)];
  throw new Error(`Unknown build asset: ${key}`);
}

async function verify(file, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected.sha256 || '')) throw new Error('Missing pinned SHA-256');
  if (expected.size !== undefined && fs.statSync(file).size !== expected.size) throw new Error(`Size mismatch: ${file}`);
  if (await digest(file) !== expected.sha256) throw new Error(`SHA-256 mismatch: ${file}`);
}

async function response(url, redirects = 0) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Expected HTTP(S) asset URL');
  return new Promise((resolve, reject) => {
    const request = (parsed.protocol === 'https:' ? https : http).get(parsed, res => {
      res.on('error', reject);
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (redirects >= 5 || !res.headers.location) return reject(new Error('Invalid asset redirect'));
        const next = new URL(res.headers.location, parsed);
        if (parsed.protocol === 'https:' && next.protocol !== 'https:') return reject(new Error('Insecure asset redirect'));
        response(next, redirects + 1).then(resolve, reject);
      } else if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Asset download failed: HTTP ${res.statusCode}`));
      } else resolve(res);
    });
    request.setTimeout(30000, () => request.destroy(new Error('Asset download timed out')));
    request.on('error', reject);
  });
}

async function download(expected, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(path.dirname(destination), '.download-'));
  const file = path.join(temporary, 'asset');
  try {
    await pipeline(await response(expected.url), fs.createWriteStream(file, { flags: 'wx' }));
    await verify(file, expected);
    fs.renameSync(file, destination);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function fetchAsset(key, destination, manifest = deps) {
  const expected = asset(key, manifest);
  if (fs.existsSync(destination)) await verify(destination, expected);
  else await download(expected, destination);
}

function git(directory, ...args) {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function ensureSource(directory, whisper = deps.whisper) {
  if (!/^[a-f0-9]{40}$/.test(whisper.revision || '')) throw new Error('Missing pinned Whisper revision');
  let fetched = false;
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    const temporary = fs.mkdtempSync(path.join(path.dirname(directory), '.whisper-source-'));
    try {
      git(temporary, 'init');
      git(temporary, 'remote', 'add', 'origin', whisper.repo.includes('://') ? whisper.repo : `https://github.com/${whisper.repo}.git`);
      git(temporary, 'fetch', '--depth', '1', 'origin', `refs/tags/${whisper.version}`);
      if (git(temporary, 'rev-parse', 'FETCH_HEAD^{commit}') !== whisper.revision) throw new Error('Whisper tag does not match pinned revision');
      git(temporary, 'checkout', '--detach', whisper.revision);
      fetched = true;
      fs.renameSync(temporary, directory);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  if (git(directory, 'rev-parse', 'HEAD') !== whisper.revision) throw new Error(`Wrong Whisper checkout: ${directory}. Quarantine it and rerun.`);
  if (git(directory, 'status', '--porcelain', '--untracked-files=no')) throw new Error(`Modified Whisper source: ${directory}`);
  // Old CMake outputs can survive a checkout change. Refuse to bless them.
  const marker = path.join(directory, '.transcriber-source.json');
  const expected = { version: whisper.version, revision: whisper.revision };
  const known = fs.existsSync(marker) && JSON.stringify(JSON.parse(fs.readFileSync(marker))) === JSON.stringify(expected);
  if (fs.readdirSync(directory).some(name => name.startsWith('build-')) && !known) {
    throw new Error(`Unknown Whisper build provenance: ${directory}. Quarantine it and rerun.`);
  }
  if (!known && !fetched) {
    git(directory, 'fetch', '--depth', '1', 'origin', `refs/tags/${whisper.version}`);
    if (git(directory, 'rev-parse', 'FETCH_HEAD^{commit}') !== whisper.revision) throw new Error('Whisper tag does not match pinned revision');
  }
  fs.writeFileSync(marker, JSON.stringify(expected) + '\n');
}

function identity(key, manifest = deps) {
  if (key.startsWith('whisper-')) return {
    key, version: manifest.whisper.version, revision: manifest.whisper.revision,
    archive: key === 'whisper-win-cpu' ? manifest.whisper.winCpuSha256 : null,
    architecture: key.startsWith('whisper-linux-') ? process.arch : 'x64',
  };
  return { key, ...asset(key, manifest) };
}

async function inventory(directory) {
  const result = {};
  for (const name of fs.readdirSync(directory).sort()) {
    if (name === '.build-provenance.json') continue;
    const file = path.join(directory, name);
    if (!fs.statSync(file).isFile()) throw new Error(`Unexpected build output: ${file}`);
    result[name] = await digest(file);
  }
  if (!Object.keys(result).length) throw new Error('No build outputs to record');
  return result;
}

async function cache(directory, key, manifest = deps) {
  if (!fs.existsSync(directory) || fs.readdirSync(directory).length === 0) return 'missing';
  const receipt = path.join(directory, '.build-provenance.json');
  if (!fs.existsSync(receipt)) throw new Error(`Unknown binary provenance: ${directory}. Quarantine it and rerun.`);
  const stored = JSON.parse(fs.readFileSync(receipt));
  if (JSON.stringify(stored.identity) !== JSON.stringify(identity(key, manifest)) ||
      JSON.stringify(stored.files) !== JSON.stringify(await inventory(directory))) {
    throw new Error(`Build cache identity mismatch: ${directory}. Quarantine it and rerun.`);
  }
  return 'valid';
}

async function record(directory, key, manifest = deps) {
  fs.writeFileSync(path.join(directory, '.build-provenance.json'),
    JSON.stringify({ identity: identity(key, manifest), files: await inventory(directory) }, null, 2) + '\n');
}

async function cacheFile(file, key, manifest = deps) {
  if (!fs.existsSync(file)) return 'missing';
  const receipt = file + '.build-provenance.json';
  if (!fs.existsSync(receipt)) throw new Error(`Unknown binary provenance: ${file}. Quarantine it and rerun.`);
  const stored = JSON.parse(fs.readFileSync(receipt));
  if (JSON.stringify(stored.identity) !== JSON.stringify(identity(key, manifest)) || stored.sha256 !== await digest(file)) {
    throw new Error(`Build cache identity mismatch: ${file}`);
  }
  return 'valid';
}

async function recordFile(file, key, manifest = deps) {
  fs.writeFileSync(file + '.build-provenance.json', JSON.stringify({ identity: identity(key, manifest), sha256: await digest(file) }) + '\n');
}

async function main([command, key, target]) {
  switch (command) {
    case 'source': ensureSource(key); break;
    case 'fetch': await fetchAsset(key, target); break;
    case 'verify': await verify(target, asset(key)); break;
    case 'cache': console.log(await cache(target, key)); break;
    case 'record': await record(target, key); break;
    case 'cache-file': console.log(await cacheFile(target, key)); break;
    case 'record-file': await recordFile(target, key); break;
    default: throw new Error('Usage: build-deps.js source DIRECTORY | fetch|verify|cache|record|cache-file|record-file KEY PATH');
  }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { digest, asset, verify, download, fetchAsset, ensureSource, cache, record, cacheFile, recordFile };
