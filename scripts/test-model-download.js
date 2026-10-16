#!/usr/bin/env node
// Offline contract checks for model transfer and atomic publication.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const { spawnSync } = require('child_process');
const { createModelDownloader } = require('../lib/model-download');

function transport(routes) {
  const requests = [];
  const get = (url, callback) => {
    const request = new EventEmitter();
    request.destroyed = false;
    request.destroy = (error) => {
      if (request.destroyed) return;
      request.destroyed = true;
      if (error) process.nextTick(() => request.emit('error', error));
    };
    requests.push({ url, request });
    process.nextTick(() => {
      const route = routes[url];
      assert(route, `Unexpected URL: ${url}`);
      route(request, callback);
    });
    return request;
  };
  return { get, requests };
}

function body(text, headers = {}, statusCode = 200) {
  return (request, callback) => {
    const response = new PassThrough();
    response.statusCode = statusCode;
    response.headers = headers;
    callback(response);
    response.end(text);
  };
}

function stalled(request, callback) {
  const response = new PassThrough();
  response.statusCode = 200;
  response.headers = {};
  callback(response);
}

function reset(request, callback) {
  const response = new PassThrough();
  response.statusCode = 200;
  response.headers = { 'content-length': '100' };
  callback(response);
  response.write('partial');
  setImmediate(() => response.destroy(new Error('injected connection reset')));
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-download-test-'));
  let count = 0;
  async function check(name, fn) {
    const directory = path.join(root, String(++count));
    fs.mkdirSync(directory);
    await fn(path.join(directory, 'model.bin'), directory);
    assert.deepEqual(fs.readdirSync(directory).filter((entry) => entry.endsWith('.download')), [], `${name}: leaked staging file`);
    console.log(`PASS ${name}`);
  }
  function downloader(route, options = {}) {
    return createModelDownloader({ get: transport({ 'https://example.test/model': route }).get, ...options });
  }
  const url = 'https://example.test/model';
  try {
    await check('success, progress and private staging', async (destPath) => {
      const progress = [];
      let mode;
      const download = downloader(body('weights', { 'content-length': '7' }), {
        fs: { ...fs, openSync(...args) { const fd = fs.openSync(...args); mode = fs.fstatSync(fd).mode & 0o777; return fd; } },
      });
      assert.equal(await download({ url, destPath, onProgress: (value) => progress.push(value) }), true);
      assert.equal(fs.readFileSync(destPath, 'utf8'), 'weights');
      assert.equal(mode, 0o600);
      assert.deepEqual(progress.at(-1), { percent: 100, received: 7, total: 7 });
    });
    await check('unknown length', async (destPath) => {
      await downloader(body('weights'))({ url, destPath });
      assert.equal(fs.readFileSync(destPath, 'utf8'), 'weights');
    });
    await check('existing valid destination', async (destPath) => {
      fs.writeFileSync(destPath, 'existing');
      const download = createModelDownloader({ get() { throw new Error('should not fetch'); } });
      assert.equal(await download({ url, destPath }), true);
      assert.equal(fs.readFileSync(destPath, 'utf8'), 'existing');
    });
    await check('replace empty destination', async (destPath) => {
      fs.writeFileSync(destPath, '');
      await downloader(body('weights'))({ url, destPath });
      assert.equal(fs.readFileSync(destPath, 'utf8'), 'weights');
    });
    await check('relative and absolute redirects', async (destPath) => {
      const mock = transport({
        [url]: body('', { location: '/next' }, 302),
        'https://example.test/next': body('', { location: 'https://cdn.test/final' }, 307),
        'https://cdn.test/final': body('weights'),
      });
      await createModelDownloader({ get: mock.get })({ url, destPath });
      assert.equal(mock.requests.length, 3);
      assert.equal(fs.readFileSync(destPath, 'utf8'), 'weights');
    });
    for (const [name, route, pattern, options] of [
      ['HTTP failure', body('error', {}, 503), /HTTP 503/],
      ['missing redirect location', body('', {}, 302), /no location/],
      ['insecure redirect', body('', { location: 'http://example.test/no' }, 302), /HTTPS/],
      ['redirect limit', body('', { location: '/model' }, 302), /Too many/, { maxRedirects: 2 }],
      ['empty body', body(''), /empty/],
      ['short body', body('abc', { 'content-length': '4' }), /length/],
      ['long body', body('abcde', { 'content-length': '4' }), /length/],
      ['zero declared length', body('', { 'content-length': '0' }), /empty/],
      ['invalid declared length', body('abc', { 'content-length': '3x' }), /Content-Length/],
      ['request error', (request) => request.emit('error', new Error('request failed')), /request failed/],
      ['timeout before headers', () => {}, /timed out/, { timeoutMs: 15 }],
      ['response reset', reset, /connection reset/],
      ['response aborted', (request, callback) => {
        stalled(request, (response) => { callback(response); setImmediate(() => response.emit('aborted')); });
      }, /aborted/],
      ['premature close', (request, callback) => {
        stalled(request, (response) => { callback(response); setImmediate(() => response.destroy()); });
      }, /Premature close/],
      ['inactivity timeout', stalled, /timed out/, { timeoutMs: 15 }],
    ]) {
      await check(name, async (destPath) => {
        await assert.rejects(downloader(route, options)({ url, destPath }), pattern);
        assert(!fs.existsSync(destPath));
      });
    }
    await check('non-HTTPS initial URL', async (destPath) => {
      await assert.rejects(downloader(body('bad'))({ url: 'http://example.test/model', destPath }), /HTTPS/);
    });
    await check('transport throws', async (destPath) => {
      const download = createModelDownloader({ get() { throw new Error('transport failed'); } });
      await assert.rejects(download({ url, destPath }), /transport failed/);
    });
    await check('late redirect response error', async (destPath) => {
      const mock = transport({
        [url]: (request, callback) => {
          const response = new PassThrough();
          response.statusCode = 302;
          response.headers = { location: '/next' };
          callback(response);
          setImmediate(() => response.emit('error', new Error('discarded response reset')));
        },
        'https://example.test/next': body('weights'),
      });
      await createModelDownloader({ get: mock.get })({ url, destPath });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(fs.readFileSync(destPath, 'utf8'), 'weights');
    });
    await check('request failure after headers', async (destPath) => {
      const route = (request, callback) => {
        stalled(request, callback);
        setImmediate(() => request.emit('error', new Error('late request failure')));
      };
      await assert.rejects(downloader(route)({ url, destPath }), /late request failure/);
    });
    await check('pre-cancelled download', async (destPath) => {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(downloader(body('unused'))({ url, destPath, signal: controller.signal }), { name: 'AbortError' });
    });
    await check('cancellation destroys request', async (destPath) => {
      const controller = new AbortController();
      const mock = transport({ [url]: (request, callback) => {
        stalled(request, callback);
        setImmediate(() => controller.abort());
      } });
      await assert.rejects(createModelDownloader({ get: mock.get })({ url, destPath, signal: controller.signal }), { name: 'AbortError' });
      assert.equal(mock.requests[0].request.destroyed, true);
    });
    await check('disk error', async (destPath) => {
      const diskFs = { ...fs, createWriteStream(filePath, { fd }) {
        return new Writable({
          write(chunk, encoding, callback) { callback(new Error('disk full')); },
          destroy(error, callback) { fs.close(fd, (closeError) => callback(error || closeError)); },
        });
      } };
      await assert.rejects(downloader(body('weights'), { fs: diskFs })({ url, destPath }), /disk full/);
    });
    await check('staging creation error', async (destPath) => {
      const deniedFs = { ...fs, openSync() { throw new Error('permission denied'); } };
      await assert.rejects(downloader(body('weights'), { fs: deniedFs })({ url, destPath }), /permission denied/);
    });
    await check('file stream creation throws and closes descriptor', async (destPath) => {
      let descriptor;
      const brokenFs = {
        ...fs,
        openSync(...args) { descriptor = fs.openSync(...args); return descriptor; },
        createWriteStream() { throw new Error('stream failed'); },
      };
      await assert.rejects(downloader(body('weights'), { fs: brokenFs })({ url, destPath }), /stream failed/);
      assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
    });
    await check('rename failure preserves prior destination', async (destPath) => {
      fs.writeFileSync(destPath, '');
      const renameFs = { ...fs, renameSync() { throw new Error('rename denied'); } };
      await assert.rejects(downloader(body('weights'), { fs: renameFs })({ url, destPath }), /rename denied/);
      assert.equal(fs.readFileSync(destPath, 'utf8'), '');
    });
    await check('concurrent publication preserves valid destination', async (destPath) => {
      await downloader(body('incoming'))({ url, destPath, onProgress() { fs.writeFileSync(destPath, 'other installer'); } });
      assert.equal(fs.readFileSync(destPath, 'utf8'), 'other installer');
    });
    await check('failed transfer preserves concurrent valid destination', async (destPath) => {
      await assert.rejects(downloader(body('incoming', { 'content-length': '10' }))({
        url, destPath, onProgress() { fs.writeFileSync(destPath, 'other installer'); },
      }), /length/);
      assert.equal(fs.readFileSync(destPath, 'utf8'), 'other installer');
    });
    await check('progress callback failure', async (destPath) => {
      await assert.rejects(downloader(body('weights'))({ url, destPath, onProgress() { throw new Error('progress failed'); } }), /progress failed/);
    });
    await check('duplicate rejection and retry', async (destPath) => {
      const controller = new AbortController();
      let attempts = 0;
      const route = (request, callback) => { attempts += 1; (attempts === 1 ? stalled : body('retry'))(request, callback); };
      const download = downloader(route);
      const first = download({ url, destPath, signal: controller.signal });
      await assert.rejects(download({ url, destPath }), /Already downloading/);
      controller.abort();
      await assert.rejects(first, { name: 'AbortError' });
      assert.equal(await download({ url, destPath }), true);
      assert.equal(fs.readFileSync(destPath, 'utf8'), 'retry');
    });
    await check('independent destinations use unique staging files', async (destPath, directory) => {
      const stages = [];
      const observingFs = { ...fs, openSync(filePath, ...args) { stages.push(filePath); return fs.openSync(filePath, ...args); } };
      const download = downloader(body('weights'), { fs: observingFs });
      await Promise.all([download({ url, destPath }), download({ url, destPath: path.join(directory, 'second.bin') })]);
      assert.equal(new Set(stages).size, 2);
    });
    const child = spawnSync(process.execPath, [__filename, '--reset-child'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 0, child.stderr || child.stdout || child.error?.message);
    assert.match(child.stdout, /reset rejected safely/);
    console.log('PASS isolated response reset has no uncaught error');
    console.log(`All ${count + 1} model download checks passed.`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv.includes('--reset-child')) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-reset-child-'));
  createModelDownloader({ get: transport({ 'https://example.test/model': reset }).get })({
    url: 'https://example.test/model', destPath: path.join(directory, 'model.bin'),
  }).then(() => { throw new Error('reset unexpectedly succeeded'); }, (error) => {
    assert.match(error.message, /connection reset/);
    assert.deepEqual(fs.readdirSync(directory), []);
    setImmediate(() => { fs.rmSync(directory, { recursive: true }); console.log('reset rejected safely'); });
  }).catch((error) => { console.error(error); process.exitCode = 1; });
} else {
  run().catch((error) => { console.error(error); process.exitCode = 1; });
}
