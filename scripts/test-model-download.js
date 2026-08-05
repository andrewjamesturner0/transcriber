#!/usr/bin/env node

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const {
  downloadModel,
  downloadToPath,
  isApprovedHuggingFaceHost,
} = require('../lib/models');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fakeRequest(routes, calls) {
  return (url, options, callback) => {
    const outgoing = new EventEmitter();
    calls.push({ url, headers: { ...(options.headers || {}) } });
    process.nextTick(() => {
      const route = routes[url];
      if (!route) {
        outgoing.emit('error', new Error(`Unexpected URL: ${url}`));
        return;
      }
      if (route.requestError) {
        outgoing.emit('error', new Error(route.requestError));
        return;
      }
      const response = new PassThrough();
      response.statusCode = route.status || 200;
      response.headers = { ...(route.headers || {}) };
      callback(response);
      if (route.interrupted) {
        response.write(route.body || 'partial');
        process.nextTick(() => {
          response.emit('aborted');
          response.destroy();
        });
        return;
      }
      response.end(route.body || '');
    });
    return outgoing;
  };
}

async function expectReject(promise, pattern) {
  let error = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert(error, 'expected promise to reject');
  assert.match(error.message, pattern);
  return error;
}

async function run() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-download-test-'));
  try {
    assert.strictEqual(isApprovedHuggingFaceHost('https://huggingface.co/model'), true);
    assert.strictEqual(isApprovedHuggingFaceHost('https://cdn-lfs.hf.co/file'), true);
    assert.strictEqual(isApprovedHuggingFaceHost('https://huggingface.co.evil.test/file'), false);
    assert.strictEqual(isApprovedHuggingFaceHost('http://huggingface.co/file'), false);

    const publicBody = Buffer.from('public model data');
    const publicDest = path.join(temp, 'public.bin');
    const publicCalls = [];
    let lastProgress = null;
    await downloadToPath({
      modelId: 'public',
      url: 'https://huggingface.co/public/model',
      destPath: publicDest,
      expectedSha256: sha256(publicBody),
      onProgress: (progress) => { lastProgress = progress; },
      request: fakeRequest({
        'https://huggingface.co/public/model': {
          body: publicBody,
          headers: { 'content-length': String(publicBody.length) },
        },
      }, publicCalls),
    });
    assert.deepStrictEqual(fs.readFileSync(publicDest), publicBody);
    assert.strictEqual(publicCalls[0].headers.Authorization, undefined);
    assert.strictEqual(lastProgress.percent, 100);

    const gatedBody = Buffer.from('gated model data');
    const gatedCalls = [];
    await downloadToPath({
      modelId: 'gated',
      url: 'https://huggingface.co/gated/model',
      destPath: path.join(temp, 'gated.bin'),
      expectedSha256: sha256(gatedBody),
      hfToken: 'hf_secret',
      request: fakeRequest({
        'https://huggingface.co/gated/model': {
          status: 302,
          headers: { location: 'https://cdn-lfs.hf.co/gated.bin' },
        },
        'https://cdn-lfs.hf.co/gated.bin': { body: gatedBody },
      }, gatedCalls),
    });
    assert(gatedCalls.every((call) => call.headers.Authorization === 'Bearer hf_secret'));

    const externalBody = Buffer.from('signed external data');
    const externalCalls = [];
    await downloadToPath({
      modelId: 'external',
      url: 'https://huggingface.co/gated/external',
      destPath: path.join(temp, 'external.bin'),
      expectedSha256: sha256(externalBody),
      hfToken: 'hf_secret',
      request: fakeRequest({
        'https://huggingface.co/gated/external': {
          status: 302,
          headers: { location: 'https://objects.example.test/model.bin' },
        },
        'https://objects.example.test/model.bin': { body: externalBody },
      }, externalCalls),
    });
    assert.strictEqual(externalCalls[0].headers.Authorization, 'Bearer hf_secret');
    assert.strictEqual(externalCalls[1].headers.Authorization, undefined);

    const mismatchDest = path.join(temp, 'mismatch.bin');
    const mismatch = await expectReject(downloadToPath({
      modelId: 'mismatch',
      url: 'https://huggingface.co/model/mismatch',
      destPath: mismatchDest,
      expectedSha256: sha256('expected'),
      request: fakeRequest({
        'https://huggingface.co/model/mismatch': { body: 'wrong' },
      }, []),
    }), /checksum mismatch/);
    assert.strictEqual(mismatch.code, 'CHECKSUM_MISMATCH');
    assert.strictEqual(fs.existsSync(mismatchDest), false);
    assert.strictEqual(fs.existsSync(mismatchDest + '.download'), false);

    const interruptedDest = path.join(temp, 'interrupted.bin');
    await expectReject(downloadToPath({
      modelId: 'interrupted',
      url: 'https://huggingface.co/model/interrupted',
      destPath: interruptedDest,
      expectedSha256: sha256('partial'),
      request: fakeRequest({
        'https://huggingface.co/model/interrupted': { body: 'partial', interrupted: true },
      }, []),
    }), /interrupted/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(fs.existsSync(interruptedDest), false);
    assert.strictEqual(fs.existsSync(interruptedDest + '.download'), false);

    const existingDest = path.join(temp, 'existing.bin');
    fs.writeFileSync(existingDest, 'already downloaded');
    await downloadModel('tiny.en', existingDest, null, { hfToken: 'must-not-be-used' });
    assert.strictEqual(fs.readFileSync(existingDest, 'utf8'), 'already downloaded');

    const unavailableDest = path.join(temp, 'moss.gguf');
    const unavailable = await expectReject(
      downloadModel('moss-transcribe-diarize', unavailableDest),
      /does not have an available local runtime/,
    );
    assert.strictEqual(unavailable.code, 'MODEL_UNAVAILABLE');
    assert.strictEqual(fs.existsSync(unavailableDest), false);

    console.log('model download tests passed');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
