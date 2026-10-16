#!/usr/bin/env node
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMain } = require('./fixtures/main-harness');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-main-'));
  let checks = 0;
  try {
    const gpu = deferred();
    const received = [];
    let disposed = 0;
    const caps = {
      detect() {}, detectGpu: () => gpu.promise, getActiveBackend: () => 'cpu',
      dispose: async () => { disposed++; }, getPythonInfo: async () => ({}),
    };
    const job = deferred();
    const result = { text: 'canonical', transcript: { kind: 'speaker-labelled', blocks: [{ speaker: 'Unknown', text: 'canonical' }], warnings: [] } };
    const setup = deferred();
    const download = deferred();
    const signals = {};
    const main = loadMain({
      directory, capabilities: caps,
      runner: { runTranscription: async (params) => { signals.transcription = params.signal; received.push(params); return job.promise; } },
      setup: { prepare: async (params) => { signals.setup = params.signal; return setup.promise; } },
      install: async (params) => {
        signals.download = params.signal;
        await download.promise;
        if (params.signal.aborted) throw new Error('Cancelled');
        fs.writeFileSync(params.destPath, 'fixture');
      },
    });
    await tick();
    const sender = { isDestroyed: () => false, send: (...args) => received.push(args) };
    const first = main.invoke('transcribe', { sender }, 'one', 'tiny.en', {}, 'structured-v1');
    await assert.rejects(main.invoke('transcribe', { sender }, 'two', 'tiny.en', {}), /Already running/);
    assert.equal(received.length, 0, 'reservation must precede GPU detection');
    checks++;
    gpu.resolve();
    await tick();
    received[0].onProgress('safe');
    assert.equal(received[1][0], 'transcribe-status');
    sender.isDestroyed = () => true;
    received[0].onProgress('window gone');
    assert.equal(received.length, 2);
    job.resolve(result);
    assert.equal(await first, result);
    assert.equal(await main.invoke('transcribe', { sender }, 'legacy', 'tiny.en', {}), 'canonical');
    checks += 2;
    const store = main.events.find((item) => item.runnerStore).runnerStore;
    assert.equal(path.dirname(store.getModelPath('base')), path.join(directory, 'models'));
    const bundledTiny = main.invoke('get-models');
    assert.ok((await bundledTiny).length > 0);
    checks++;

    // Reserve all operation kinds, then ensure repeated quit closes admission and waits.
    const work = deferred();
    // Use a fresh main so the completed transcription stub does not hide waiting work.
    const main2 = loadMain({
      directory, capabilities: caps,
      runner: { runTranscription: async ({ signal }) => {
        signals.transcription = signal;
        await work.promise;
        throw new Error('Cancelled');
      } },
      setup: { prepare: async ({ signal }) => { signals.setup = signal; await setup.promise; return {}; } },
      install: async ({ signal }) => { signals.download = signal; await download.promise; throw new Error('Cancelled'); },
    });
    await tick();
    const active = main2.invoke('transcribe', { sender }, 'active', 'tiny.en', {});
    const preparing = main2.invoke('prepare-diarization', { sender }, 'private-token', {});
    await assert.rejects(main2.invoke('prepare-diarization', { sender }, '', {}), /Already running/);
    const downloading = main2.invoke('download-model', { sender }, 'base');
    await assert.rejects(main2.invoke('download-model', { sender }, 'base'), /Already running/);
    await tick();
    main2.app.quit();
    main2.app.quit();
    await assert.rejects(main2.invoke('transcribe', { sender }, 'late', 'tiny.en', {}), /closing/);
    assert.ok(signals.transcription.aborted && signals.setup.aborted && signals.download.aborted);
    assert.ok(!main2.events.includes('quit'), 'must wait for cleanup');
    work.resolve(); setup.resolve(); download.resolve();
    await Promise.allSettled([active, preparing, downloading]);
    await tick(); await tick();
    const deadline = Date.now() + 2000;
    while (!main2.events.includes('quit') && Date.now() < deadline) await tick();
    assert.deepEqual(main2.events.filter((item) => item === 'quit'), ['quit']);
    assert.equal(disposed, 1);
    main2.windows[0].destroy();
    main2.updater.emit('update-available', { version: '2.0.0' });
    main2.updater.emit('update-downloaded', { version: '2.0.0' });
    checks++;
    assert.ok(fs.readFileSync(path.join(directory, 'logs/transcriber.log'), 'utf8').includes('Application started'));
    checks += 4;

    let flushed = false;
    const main3 = loadMain({
      directory, capabilities: caps,
      runner: { runTranscription: async () => result },
      logger: { write() {}, flush: async () => {}, close: async () => { flushed = true; throw new Error('disk unavailable'); } },
    });
    await tick();
    await main3.invoke('install-update');
    assert.equal(flushed, true);
    assert.equal(main3.events.filter((item) => item === 'install').length, 1);
    checks++;
    console.log('Main lifecycle: ' + checks + ' integration checks passed');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
