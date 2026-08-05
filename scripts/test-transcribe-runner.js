#!/usr/bin/env node

const { createTranscribeRunner } = require('../lib/transcribe-runner');
const { getCatalogueModel } = require('../lib/model-catalogue');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  FAIL: ${name} -- ${error.message}`);
    failed += 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function makeRunner(handler) {
  const calls = [];
  const workerClient = {
    transcribe: async (params) => {
      calls.push(params);
      return handler ? handler(params) : { text: 'hello', backend: params.backend };
    },
    shutdown: async () => {},
  };
  return { runner: createTranscribeRunner({ workerClient }), calls };
}

(async () => {
  await test('Parakeet maps catalogue timing and returns a normal result', async () => {
    const { runner, calls } = makeRunner(() => ({ text: 'hello', backend: 'cpu', language: 'en', words: [{ text: 'hello', t0Ms: 0, t1Ms: 1000 }] }));
    const result = await runner.transcribe({ modelSpec: getCatalogueModel('parakeet-tdt-ctc-110m'), modelPath: '/model.gguf', wavPath: '/audio.wav', options: { sourceLanguage: 'en', backend: 'cpu' }, onProgress: () => {} });
    assert(calls[0].options.timestamps === 'word');
    assert(result.result.engine === 'transcribe.cpp');
    assert(result.result.words.length === 1);
    assert(result.result.words[0].startMs === 0 && result.result.words[0].endMs === 1000);
    assert(!('t0Ms' in result.result.words[0]) && !('t1Ms' in result.result.words[0]));
  });

  await test('Moonshine omits transcript timestamps but preserves native performance timings', async () => {
    const { runner, calls } = makeRunner(() => ({
      text: 'hello',
      backend: 'cpu',
      language: '',
      segments: [{ text: 'hello', t0Ms: 0, t1Ms: 0 }],
      timings: { loadMs: 10, melMs: 2, encodeMs: 30, decodeMs: 40 },
    }));
    const result = await runner.transcribe({ modelSpec: getCatalogueModel('moonshine-tiny'), modelPath: '/model.gguf', wavPath: '/audio.wav', options: { backend: 'cpu' }, onProgress: () => {} });
    assert(calls[0].options.timestamps === 'none');
    assert(!('segments' in result.result) && !('words' in result.result));
    assert(!('detectedLanguage' in result.result));
    assert(result.result.timings.loadMs === 10 && result.result.timings.decodeMs === 40);
    assert(Object.getPrototypeOf(result.result.timings) === Object.prototype);
  });

  await test('worker cancellation errors propagate unchanged', async () => {
    const error = Object.assign(new Error('Cancelled'), { code: 'Aborted' });
    const { runner } = makeRunner(async () => { throw error; });
    let caught;
    try { await runner.transcribe({ modelSpec: getCatalogueModel('moonshine-tiny'), modelPath: '/model.gguf', wavPath: '/audio.wav', options: {}, onProgress: () => {} }); } catch (value) { caught = value; }
    assert(caught === error);
  });

  await test('deferred MOSS fails before calling the worker', async () => {
    const { runner, calls } = makeRunner();
    let error;
    try { await runner.transcribe({ modelSpec: getCatalogueModel('moss-transcribe-diarize'), modelPath: '/model.gguf', wavPath: '/audio.wav', options: {}, onProgress: () => {} }); } catch (caught) { error = caught; }
    assert(error && error.code === 'MODEL_DEFERRED');
    assert(calls.length === 0);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
