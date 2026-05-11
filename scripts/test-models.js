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

test('getDownloadUrl uses hfRepo when present', () => {
  const url = models.getDownloadUrl('small.en-tdrz');
  assert(url.includes('akashmjn/tinydiarize-whisper.cpp'), `expected custom repo, got ${url}`);
  assert(url.includes('ggml-small.en-tdrz.bin'), 'url should include fileName');
  assert(url.startsWith('https://huggingface.co/'), 'url should be HTTPS');
});

test('getDownloadUrl uses default repo when hfRepo absent', () => {
  const url = models.getDownloadUrl('tiny.en');
  assert(url.includes('ggerganov/whisper.cpp'), `expected default repo, got ${url}`);
  assert(url.includes('ggml-tiny.en.bin'), 'url should include fileName');
});

test('listModels returns array with downloaded flags', () => {
  const all = models.listModels();
  assert(Array.isArray(all), 'should return an array');
  assert(all.length === 13, `expected 13 models, got ${all.length}`);

  for (const m of all) {
    assert(typeof m.id === 'string', 'each model should have id');
    assert(typeof m.fileName === 'string', 'each model should have fileName');
    assert(typeof m.label === 'string', 'each model should have label');
    assert(typeof m.size === 'string', 'each model should have size');
    assert(typeof m.downloaded === 'boolean', 'each model should have downloaded boolean');
  }
});

test('tdrz model has tdrz flag and no dtwPreset', () => {
  const m = models.getModel('small.en-tdrz');
  assert(m.tdrz === true, 'tdrz model should have tdrz: true');
  assert(!('dtwPreset' in m), 'tdrz model should not have dtwPreset');
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

runAll();
