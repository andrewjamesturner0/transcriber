#!/usr/bin/env node
/**
 * Tests for lib/models.js
 *
 * Covers: getModel lookup, getModelPath, getDownloadUrl, listModels download status.
 * Follows the same plain-node style as the other test-*.js files.
 *
 * Usage:
 *     node scripts/test-models.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// Initialize path resolver before requiring models (models calls paths.getResourcePath)
const paths = require('../lib/paths');
paths.initPaths({ isPackaged: false, resourcesPath: '/fake/app' });

const models = require('../lib/models');
const catalogue = require('../lib/model-catalogue');

// --- Helpers ---

let passed = 0;
let failed = 0;
const _queue = [];

function test(name, fn) {
  _queue.push({ name, fn });
}

async function runAll() {
  for (const { name, fn } of _queue) {
    try {
      await fn();
      console.log(`  PASS: ${name}`);
      passed++;
    } catch (e) {
      console.log(`  FAIL: ${name} -- ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// --- Tests ---

test('getModel returns spec for known model', () => {
  const m = models.getModel('tiny.en');
  assert(m.id === 'tiny.en', 'should have correct id');
  assert(m.fileName === 'ggml-tiny.en.bin', 'should have correct fileName');
  assert(m.label === 'Tiny (English)', 'should have correct label');
  assert(m.size === '75 MB', 'should have correct size');
});

test('getModel throws for unknown model', () => {
  try {
    models.getModel('nonexistent');
    assert(false, 'should have thrown');
  } catch (err) {
    assert(err.message === 'Unknown model: nonexistent', `expected 'Unknown model: nonexistent', got '${err.message}'`);
  }
});

test('getModel for every id in the list does not throw', () => {
  const all = models.listModels();
  for (const m of all) {
    const resolved = models.getModel(m.id);
    assert(resolved.id === m.id, `mismatch for ${m.id}`);
  }
});

test('getModelPath returns a path ending in the model fileName', () => {
  const p = models.getModelPath('tiny.en');
  assert(p.endsWith('ggml-tiny.en.bin'), `expected path ending in ggml-tiny.en.bin, got ${p}`);
  assert(p.includes('models'), 'path should include models directory');
});

test('getDownloadUrl uses the pinned repository and revision', () => {
  const url = models.getDownloadUrl('moonshine-tiny');
  assert(url.includes('handy-computer/moonshine-tiny-gguf'), `expected model repo, got ${url}`);
  assert(url.includes('f5c11906eba3f44cf305eed30feb9cbfb0b4b9d0'), 'url should include immutable revision');
  assert(url.includes('moonshine-tiny-Q8_0.gguf'), 'url should include fileName');
  assert(url.startsWith('https://huggingface.co/'), 'url should be HTTPS');
});

test('getDownloadUrl pins retained Whisper downloads', () => {
  const url = models.getDownloadUrl('tiny.en');
  assert(url.includes('ggerganov/whisper.cpp'), `expected default repo, got ${url}`);
  assert(url.includes('5359861c739e955e79d9a303bcbc70fb988958b1'), 'url should include immutable revision');
  assert(url.includes('ggml-tiny.en.bin'), 'url should include fileName');
});

test('listModels returns array with downloaded flags', () => {
  const all = models.listModels();
  assert(Array.isArray(all), 'should return an array');
  assert(all.length === 19, `expected 19 models, got ${all.length}`);

  for (const m of all) {
    assert(typeof m.id === 'string', 'each model should have id');
    assert(typeof m.fileName === 'string', 'each model should have fileName');
    assert(typeof m.label === 'string', 'each model should have label');
    assert(typeof m.size === 'string', 'each model should have size');
    assert(typeof m.downloaded === 'boolean', 'each model should have downloaded boolean');
    assert(/^[a-f0-9]{40}$/.test(m.revision), `${m.id} should have an immutable revision`);
    assert(/^[a-f0-9]{64}$/.test(m.sha256), `${m.id} should have a SHA-256`);
    assert(typeof m.engine === 'string', `${m.id} should have an engine`);
    assert(typeof m.licence === 'string', `${m.id} should have a licence`);
    assert(Array.isArray(m.backends), `${m.id} should have backends`);
  }
});

test('TinyDiarize is absent and the seven new-family models are present', () => {
  const ids = models.listModels().map((m) => m.id);
  assert(!ids.includes('small.en-tdrz'), 'TinyDiarize must be absent');
  for (const id of ['parakeet-tdt-ctc-110m', 'moonshine-tiny', 'nemotron-3.5-0.6b', 'qwen3-asr-0.6b', 'canary-180m-flash', 'medasr', 'moss-transcribe-diarize']) {
    assert(ids.includes(id), `expected ${id}`);
  }
});

test('non-tdrz model has dtwPreset', () => {
  const m = models.getModel('tiny.en');
  assert(m.dtwPreset === 'tiny.en', `expected 'tiny.en', got '${m.dtwPreset}'`);

  const turbo = models.getModel('large-v3-turbo');
  assert(turbo.dtwPreset === 'large.v3.turbo', `expected 'large.v3.turbo', got '${turbo.dtwPreset}'`);

  const q5 = models.getModel('large-v3-turbo-q5_0');
  assert(q5.dtwPreset === 'large.v3.turbo', `expected 'large.v3.turbo' for q5_0, got '${q5.dtwPreset}'`);

  const largeQ5 = models.getModel('large-v3-q5_0');
  assert(largeQ5.dtwPreset === 'large.v3', `expected 'large.v3', got '${largeQ5.dtwPreset}'`);
});

test('new-family recommendation state matches the validation gate', () => {
  for (const model of models.listModels().filter((entry) => entry.family !== 'whisper')) {
    assert(['candidate', 'experimental'].includes(model.status), `${model.id} must not be recommended before evidence passes`);
  }
});

test('presentation models omit download checksums and repository internals', () => {
  const model = models.listPresentationModels().find((entry) => entry.id === 'medasr');
  assert(model.sourceRevision, 'presentation record should retain a traceable source revision');
  assert(!('sha256' in model), 'presentation record should omit checksum');
  assert(!('repository' in model), 'presentation record should omit repository internals');
});

test('public catalogue records and nested capability data are deeply frozen', () => {
  const direct = catalogue.getCatalogueModel('canary-180m-flash');
  const listed = catalogue.listCatalogueModels().find((entry) => entry.id === direct.id);
  const presented = catalogue.listPresentationModels().find((entry) => entry.id === direct.id);
  const converted = catalogue.toPresentationModel(direct);

  for (const record of [direct, listed, presented, converted]) {
    assert(Object.isFrozen(record), 'catalogue record should be frozen');
    assert(Object.isFrozen(record.languages), 'languages should be frozen');
    assert(Object.isFrozen(record.backends), 'backends should be frozen');
    assert(Object.isFrozen(record.knownIssues), 'known issues should be frozen');
    assert(Object.isFrozen(record.translationPairs), 'translation pairs should be frozen');
    assert(Object.isFrozen(record.translationPairs[0]), 'translation pair records should be frozen');
  }
  assert(Object.isFrozen(catalogue.MODELS), 'canonical catalogue array should be frozen');
  assert(Object.isFrozen(catalogue.listCatalogueModels()), 'catalogue list should be frozen');
  assert(Object.isFrozen(catalogue.listPresentationModels()), 'presentation list should be frozen');
});

runAll();
