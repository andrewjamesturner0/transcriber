#!/usr/bin/env node
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const policy = require('./build-deps');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-build-deps-'));
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const good = Buffer.from('verified local model fixture');
let count = 0;
let requests = 0;
let archive;
const server = http.createServer((request, response) => {
  requests++;
  switch (request.url) {
    case '/good': response.end(good); break;
    case '/archive': response.end(archive); break;
    case '/redirect': response.writeHead(302, { location: '/good' }).end(); break;
    case '/html': response.end('<html>error</html>'); break;
    case '/partial':
      response.writeHead(200, { 'Content-Length': good.length + 100 });
      response.write(good.subarray(0, 4));
      setImmediate(() => response.destroy());
      break;
    default: response.writeHead(404).end('Not found');
  }
});
function write(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
function git(dir, ...args) { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
async function test(name, run) { await run(); count++; console.log(`PASS: ${name}`); }
function shell(script, args, directory, env) {
  return new Promise(resolve => {
    let output = '';
    const child = spawn('bash', [script, ...args], { cwd: directory, env: { ...process.env, ...env } });
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('close', code => resolve({ code, output }));
  });
}

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const expected = { url: base + '/good', sha256: hash(good), size: good.length };
  await test('HTTP errors, partial transfers and wrong hashes preserve existing output and clean temporary files', async () => {
    const directory = path.join(root, 'downloads');
    const destination = path.join(directory, 'model.bin');
    write(destination, good);
    for (const route of ['/missing', '/partial', '/html']) {
      await assert.rejects(policy.download({ ...expected, url: base + route }, destination));
      assert.deepEqual(fs.readFileSync(destination), good);
      assert.deepEqual(fs.readdirSync(directory), ['model.bin']);
    }
    fs.unlinkSync(destination);
    await assert.rejects(policy.download({ ...expected, url: base + '/partial' }, destination));
    assert(!fs.existsSync(destination));
    await policy.download({ ...expected, url: base + '/redirect' }, destination);
    assert.deepEqual(fs.readFileSync(destination), good);
  });
  await test('cached model must match pinned size/hash and is never silently adopted', async () => {
    const destination = path.join(root, 'cached-model');
    const manifest = { model: expected };
    await policy.fetchAsset('model', destination, manifest);
    const before = requests;
    await policy.fetchAsset('model', destination, manifest);
    assert.equal(requests, before);
    write(destination, 'bad old response');
    await assert.rejects(policy.fetchAsset('model', destination, manifest), /mismatch/);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'bad old response');
  });

  const upstream = path.join(root, 'upstream');
  fs.mkdirSync(upstream);
  git(upstream, 'init');
  git(upstream, 'config', 'user.email', 'fixture@example.invalid');
  git(upstream, 'config', 'user.name', 'Build fixture');
  write(path.join(upstream, 'source.txt'), 'pinned source\n');
  // Whisper ships this tracked script; it is not a cached build directory.
  write(path.join(upstream, 'build-xcframework.sh'), '#!/bin/sh\n');
  git(upstream, 'add', 'source.txt', 'build-xcframework.sh');
  git(upstream, 'commit', '-m', 'fixture pin');
  const revision = git(upstream, 'rev-parse', 'HEAD');
  git(upstream, 'tag', 'fixture-v1');
  const whisper = { version: 'fixture-v1', revision, repo: new URL('file://' + upstream).href, winCpuSha256: hash('archive') };
  await test('new source accepts tracked build scripts at the pinned tag; mismatched tag is rejected', () => {
    const directory = path.join(root, 'source');
    policy.ensureSource(directory, whisper);
    assert.equal(git(directory, 'rev-parse', 'HEAD'), revision);
    policy.ensureSource(directory, whisper);
    const failed = path.join(root, 'wrong-pin');
    assert.throws(() => policy.ensureSource(failed, { ...whisper, revision: '0'.repeat(40) }), /tag does not match/);
    assert(!fs.existsSync(failed));
    // A manifest version change must not relabel a cached old revision.
    write(path.join(upstream, 'source.txt'), 'next source\n');
    git(upstream, 'add', 'source.txt');
    git(upstream, 'commit', '-m', 'next fixture version');
    git(upstream, 'tag', 'fixture-v2');
    assert.throws(() => policy.ensureSource(directory, { ...whisper, version: 'fixture-v2' }), /tag does not match/);
    assert.equal(git(directory, 'rev-parse', 'HEAD'), revision);
  });
  await test('wrong cached revision, tracked edits and unknown CMake outputs fail without changing source', () => {
    const directory = path.join(root, 'source');
    assert.throws(() => policy.ensureSource(directory, { ...whisper, revision: '1'.repeat(40) }), /Wrong Whisper checkout/);
    assert.equal(git(directory, 'rev-parse', 'HEAD'), revision);
    write(path.join(directory, 'source.txt'), 'changed\n');
    assert.throws(() => policy.ensureSource(directory, whisper), /Modified Whisper source/);
    write(path.join(directory, 'source.txt'), 'pinned source\n');
    fs.mkdirSync(path.join(directory, 'build-cpu'));
    fs.unlinkSync(path.join(directory, '.transcriber-source.json'));
    assert.throws(() => policy.ensureSource(directory, whisper), /Unknown Whisper build provenance/);
  });
  await test('cached binary identity includes revision, variant, architecture and every output hash', async () => {
    const directory = path.join(root, 'binary');
    const manifest = { whisper };
    assert.equal(await policy.cache(directory, 'whisper-linux-cpu', manifest), 'missing');
    write(path.join(directory, 'whisper-cli'), 'binary');
    write(path.join(directory, 'libwhisper.so'), 'library');
    await assert.rejects(policy.cache(directory, 'whisper-linux-cpu', manifest), /Unknown binary provenance/);
    await policy.record(directory, 'whisper-linux-cpu', manifest);
    assert.equal(await policy.cache(directory, 'whisper-linux-cpu', manifest), 'valid');
    await assert.rejects(policy.cache(directory, 'whisper-linux-vulkan', manifest), /identity mismatch/);
    await assert.rejects(policy.cache(directory, 'whisper-linux-cpu', { whisper: { ...whisper, revision: '1'.repeat(40) } }), /identity mismatch/);
    const receipt = path.join(directory, '.build-provenance.json');
    const stored = fs.readFileSync(receipt, 'utf8');
    const changed = JSON.parse(stored);
    changed.identity.architecture = 'wrong-arch';
    write(receipt, JSON.stringify(changed));
    await assert.rejects(policy.cache(directory, 'whisper-linux-cpu', manifest), /identity mismatch/);
    write(receipt, stored);
    write(path.join(directory, 'libwhisper.so'), 'modified library');
    await assert.rejects(policy.cache(directory, 'whisper-linux-cpu', manifest), /identity mismatch/);
  });
  await test('installed FFmpeg receipt binds manifest archive hash and extracted binary hash', async () => {
    const destination = path.join(root, 'ffmpeg');
    const manifest = { ffmpeg: { 'linux-amd64': expected } };
    write(destination, 'ffmpeg fixture');
    await assert.rejects(policy.cacheFile(destination, 'ffmpeg-linux-amd64', manifest), /Unknown binary provenance/);
    await policy.recordFile(destination, 'ffmpeg-linux-amd64', manifest);
    assert.equal(await policy.cacheFile(destination, 'ffmpeg-linux-amd64', manifest), 'valid');
    await assert.rejects(policy.cacheFile(destination, 'ffmpeg-linux-amd64', { ffmpeg: { 'linux-amd64': { ...expected, sha256: '0'.repeat(64) } } }), /identity mismatch/);
    write(destination, 'changed');
    await assert.rejects(policy.cacheFile(destination, 'ffmpeg-linux-amd64', manifest), /identity mismatch/);
  });

  if (process.platform !== 'win32') await test('real build/setup scripts stop on unknown caches; archive hash gates extraction; rerun succeeds', async () => {
    const project = path.join(root, 'project');
    const mockBin = path.join(root, 'commands');
    for (const name of ['build.sh', 'setup.sh', 'build-deps.js']) {
      write(path.join(project, 'scripts', name), fs.readFileSync(path.join(__dirname, name)));
    }
    write(path.join(project, 'dist', 'fixture.AppImage'), 'packaged fixture');
    write(path.join(mockBin, 'npm'), '#!/bin/sh\nexit 0\n');
    write(path.join(mockBin, 'npx'), '#!/bin/sh\necho packaged >> "$FIXTURE_LOG"\n');
    write(path.join(mockBin, 'cmake'), `#!/bin/sh
if [ "$1" = --build ]; then
  mkdir -p "$2/bin"
  echo fixture-cli > "$2/bin/whisper-cli"
  echo fixture-library > "$2/bin/libwhisper.so"
elif [ "$1" = --find-package ]; then
  exit 1
fi
`);
    for (const name of ['npm', 'npx', 'cmake']) fs.chmodSync(path.join(mockBin, name), 0o755);
    const archiveRoot = path.join(root, 'tar-input');
    write(path.join(archiveRoot, 'ffmpeg-fixture', 'ffmpeg'), 'ffmpeg fixture');
    const archivePath = path.join(root, 'ffmpeg.tar.xz');
    execFileSync('tar', ['-cJf', archivePath, '-C', archiveRoot, 'ffmpeg-fixture']);
    archive = fs.readFileSync(archivePath);
    const manifest = {
      whisper,
      model: { ...expected, default: 'ggml-tiny.en.bin' },
      ffmpeg: { 'linux-amd64': { url: base + '/archive', sha256: '0'.repeat(64) }, 'linux-arm64': { url: base + '/archive', sha256: '0'.repeat(64) } },
    };
    const manifestPath = path.join(project, 'deps.json');
    const save = () => write(manifestPath, JSON.stringify(manifest));
    const log = path.join(root, 'packaging.log');
    const env = { PATH: mockBin + path.delimiter + process.env.PATH, FIXTURE_LOG: log };
    const run = (script, args = []) => shell(path.join(project, 'scripts', script), args, project, env);
    save();
    const badArchive = await run('build.sh', ['--target', 'linux', '--no-gpu']);
    assert.notEqual(badArchive.code, 0, badArchive.output);
    assert.match(badArchive.output, /SHA-256 mismatch/);
    assert(!fs.existsSync(path.join(project, 'bin/linux/ffmpeg')));
    assert(!fs.existsSync(log));
    for (const entry of Object.values(manifest.ffmpeg)) entry.sha256 = hash(archive);
    save();
    const success = await run('build.sh', ['--target', 'linux', '--no-gpu']);
    assert.equal(success.code, 0, success.output);
    assert.equal(fs.readFileSync(path.join(project, 'bin/linux/ffmpeg'), 'utf8'), 'ffmpeg fixture');
    assert.equal(fs.readFileSync(log, 'utf8'), 'packaged\n');
    // An old binary cannot be treated as current merely because the filename exists.
    fs.unlinkSync(path.join(project, 'bin/linux/cpu/.build-provenance.json'));
    for (const [script, args] of [['build.sh', ['--target', 'linux', '--no-gpu']], ['build.sh', ['--target', 'linux', '--skip-deps']], ['setup.sh', []]]) {
      const rejected = await run(script, args);
      assert.notEqual(rejected.code, 0, rejected.output);
      assert.match(rejected.output, /Unknown binary provenance/);
    }
    assert.equal(fs.readFileSync(log, 'utf8'), 'packaged\n');
  });
  console.log(`${count} build dependency tests passed`);
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});
