#!/usr/bin/env node
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createModelStore } = require('../lib/model-store');
const models = require('../lib/models');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-store-'));
  const bundledDir = path.join(root, 'bundled');
  const writableDir = path.join(root, 'user');
  fs.mkdirSync(bundledDir);
  const bundledModel = path.join(bundledDir, models.getModel('tiny.en').fileName);
  fs.writeFileSync(bundledModel, 'bundled weights');
  try {
    let installs = 0;
    const store = createModelStore({
      bundledDir, writableDir,
      install: async ({ destPath, onProgress }) => {
        installs++;
        if (onProgress) onProgress({ percent: 100, received: 4, total: 4 });
        fs.writeFileSync(destPath, 'user weights');
      },
    });
    assert.equal(store.getModelPath('tiny.en'), bundledModel);
    assert.equal(await store.downloadModel('tiny.en'), true);
    assert.equal(installs, 0, 'bundled weights do not need another download');
    assert(!fs.existsSync(writableDir));
    assert(store.listModels().find((m) => m.id === 'tiny.en').downloaded);
    assert(!store.listModels().find((m) => m.id === 'base').downloaded);
    const progress = [];
    await store.downloadModel('base', { onProgress: (message) => progress.push(message) });
    assert.equal(installs, 1);
    assert.equal(progress[0].modelId, 'base');
    assert.equal(store.getModelPath('base'), path.join(writableDir, 'ggml-base.bin'));
    fs.writeFileSync(path.join(writableDir, 'ggml-tiny.en.bin'), 'preferred user weights');
    assert.equal(store.getModelPath('tiny.en'), path.join(writableDir, 'ggml-tiny.en.bin'));
    fs.writeFileSync(path.join(writableDir, 'ggml-tiny.en.bin'), '');
    assert.equal(store.getModelPath('tiny.en'), bundledModel, 'empty user model cannot mask a bundle');

    const readonly = createModelStore({ bundledDir });
    assert.equal(readonly.getModelPath('tiny.en'), bundledModel);
    await assert.rejects(readonly.downloadModel('base'), /read-only/);
    assert.equal(readonly.listModels().find((m) => m.id === 'base').downloaded, false);
    const elsewhere = createModelStore({ bundledDir: path.join(root, 'other') });
    assert.notEqual(elsewhere.getModelPath('tiny.en'), readonly.getModelPath('tiny.en'));
    assert(!elsewhere.listModels().some((m) => m.downloaded));

    const untouched = path.join(root, 'untouched');
    const invalid = createModelStore({ writableDir: untouched, install: () => assert.fail('installer called') });
    await assert.rejects(invalid.downloadModel('../invalid'), /Unknown model/);
    assert(!fs.existsSync(untouched));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(store.downloadModel('small', { signal: controller.signal }), /Cancelled/);

    let rejectInstall;
    const concurrent = createModelStore({
      writableDir, install: () => new Promise((resolve, reject) => { rejectInstall = reject; }),
    });
    const first = concurrent.downloadModel('small');
    await assert.rejects(concurrent.downloadModel('small'), /Already downloading/);
    rejectInstall(new Error('disk failure'));
    await assert.rejects(first, /disk failure/);
    let retried = false;
    const retry = concurrent.downloadModel('small').catch(() => { retried = true; });
    rejectInstall(new Error('retry reached installer'));
    await retry;
    assert(retried);
    console.log('PASS: model discovery, roots, installation, cancellation and isolation');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
