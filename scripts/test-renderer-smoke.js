#!/usr/bin/env node
/**
 * Renderer smoke test - loads all renderer scripts in a minimal browser-like
 * context and verifies they parse and execute without errors.
 *
 * Catches: require()-in-renderer bugs, syntax errors, missing globals,
 * and other silent failures that only manifest in the browser.
 *
 * Usage:
 *     node scripts/test-renderer-smoke.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const RENDERER_DIR = path.join(ROOT, 'renderer');

// --- Helpers ---

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name} -- ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// --- Build minimal browser-like context ---

function noop() {}
function noopAsync() { return Promise.resolve(); }
function noopPromise(val) { return Promise.resolve(val); }

function makeBrowserGlobals() {
  return {
    localStorage: { getItem() { return ''; }, setItem() {}, removeItem() {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  };
}

function makeBrowserContext() {
  const els = new Map();

  function makeEl(tag, id) {
    const el = {
      tagName: tag.toUpperCase(),
      id: id || '',
      className: '',
      innerHTML: '',
      textContent: '',
      value: '',
      hidden: false,
      disabled: false,
      checked: false,
      href: '',
      style: {},
      classList: (() => {
        const set = new Set();
        return { add(c) { set.add(c); }, remove(c) { set.delete(c); }, toggle(c, on) { if (on === undefined ? !set.has(c) : on) set.add(c); else set.delete(c); }, contains(c) { return set.has(c); } };
      })(),
      setAttribute() {},
      getAttribute() { return null; },
      _listeners: {},
      addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
      removeEventListener() {},
      appendChild(c) { return c; },
      append() {},
      replaceChildren() {},
      replaceWith(el) {},
      querySelector() { return null; },
      closest() { return null; },
      contains() { return false; },
      parentNode: null,
      dataset: {},
    };
    if (id) els.set(id, el);
    return el;
  }

  const document = {
    createElement(tag) { return makeEl(tag); },
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeEl('div', id));
      return els.get(id);
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector(sel) {
      const key = `selector:${sel}`;
      if (!els.has(key)) els.set(key, makeEl('span'));
      return els.get(key);
    },
  };

  // Stub the preload API (window.api) so renderer.js top-level code
  // doesn't throw on the event-listener registrations or init calls.
  const api = {
    // Event listeners - just accept a callback
    onDownloadProgress: noop,
    onStatus: noop,
    onDiarizeStatus: noop,
    onUpdateAvailable: noop,
    onUpdateDownloaded: noop,

    // Init calls that fire at load time
    getModels: () => noopPromise([]),
    checkPythonSetup: () => noopPromise({ pythonFound: false }),
    checkAlignment: () => noopPromise({ alignmentStatus: 'ready' }),
    prepareDiarization: () => noopPromise({ status: 'ready' }),
    getGpuStatus: () => noopPromise({ backend: 'cpu', detected: null, deviceName: null, setting: 'auto', available: ['cpu'] }),
    isDebugBuild: () => noopPromise(false),
    getVersion: () => noopPromise('0.0.0'),

    // Calls made by event handlers (not top-level but stubbed for completeness)
    selectFiles: () => noopPromise([]),
    transcribe: () => noopPromise(''),
    transcribeResult: () => noopPromise({ text: '', transcript: { kind: 'plain', warnings: [] } }),
    downloadModel: () => noopPromise(true),
    cancelTranscription: () => noopPromise(true),
    saveTranscript: () => noopPromise(false),
    openExternal: noopAsync,
    openLogFile: noopAsync,
    openLogFolder: noopAsync,
    installUpdate: noopAsync,
    getPathForFile: (f) => '',
    getLicenses: () => noopPromise([]),
  };

  const window = {
    document,
    api,
    addEventListener() {},
    removeEventListener() {},
    navigator: { clipboard: { writeText() { return Promise.resolve(); } } },
    localStorage: { getItem() { return ''; }, setItem() {}, removeItem() {} },
    setTimeout() { return 0; },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
    location: { href: '' },
    history: {},
  };

  return { window, document };
}

// --- Tests ---

console.log('Renderer smoke tests\n');

test('queue.js parses without errors', () => {
  const ctx = makeBrowserContext();
  const globals = makeBrowserGlobals();
  const sandbox = { window: ctx.window, document: ctx.document, console, ...globals };

  vm.createContext(sandbox);

  const src = fs.readFileSync(path.join(RENDERER_DIR, 'queue.js'), 'utf-8');
  vm.runInContext(src, sandbox, { filename: 'queue.js' });

  assert(typeof sandbox.window.createQueue === 'function', 'createQueue should be on window');
});

test('renderer.js parses without errors', () => {
  const ctx = makeBrowserContext();
  const globals = makeBrowserGlobals();
  const sandbox = { window: ctx.window, document: ctx.document, console, ...globals };

  vm.createContext(sandbox);

  // Load all renderer modules in dependency order
  const modules = [
    'queue.js',
    'media-extensions.js',
    'time-estimates.js',
    'transcript-format.js',
    'job-options.js',
  ];
  for (const mod of modules) {
    vm.runInContext(
      fs.readFileSync(path.join(RENDERER_DIR, mod), 'utf-8'),
      sandbox,
      { filename: mod },
    );
  }

  const src = fs.readFileSync(path.join(RENDERER_DIR, 'renderer.js'), 'utf-8');
  vm.runInContext(src, sandbox, { filename: 'renderer.js' });

  // Key DOM elements should be captured (not undefined)
  const btnTranscribe = sandbox.document.getElementById('btn-transcribe');
  assert(typeof btnTranscribe !== 'undefined', 'btnTranscribe should exist');
});

test('queue.js + renderer.js together parse without errors', () => {
  const ctx = makeBrowserContext();
  const globals = makeBrowserGlobals();
  const sandbox = { window: ctx.window, document: ctx.document, console, ...globals };

  vm.createContext(sandbox);

  const queueSrc = fs.readFileSync(path.join(RENDERER_DIR, 'queue.js'), 'utf-8');
  const mediaSrc = fs.readFileSync(path.join(RENDERER_DIR, 'media-extensions.js'), 'utf-8');
  const timeSrc = fs.readFileSync(path.join(RENDERER_DIR, 'time-estimates.js'), 'utf-8');
  const formatSrc = fs.readFileSync(path.join(RENDERER_DIR, 'transcript-format.js'), 'utf-8');
  const jobSrc = fs.readFileSync(path.join(RENDERER_DIR, 'job-options.js'), 'utf-8');
  const rendererSrc = fs.readFileSync(path.join(RENDERER_DIR, 'renderer.js'), 'utf-8');

  // Simulate loading all scripts
  const combined = `${queueSrc}\n${mediaSrc}\n${timeSrc}\n${formatSrc}\n${jobSrc}\n${rendererSrc}`;
  vm.runInContext(combined, sandbox, { filename: 'renderer-combined.js' });

  // If we got here without throwing, all scripts parsed and top-level code ran.
  assert(true, 'combined scripts loaded without error');
});

test('media-extensions.js accepts .dss files', () => {
  const ctx = makeBrowserContext();
  const globals = makeBrowserGlobals();
  const sandbox = { window: ctx.window, document: ctx.document, console, ...globals };

  vm.createContext(sandbox);

  const mediaSrc = fs.readFileSync(path.join(RENDERER_DIR, 'media-extensions.js'), 'utf-8');
  vm.runInContext(mediaSrc, sandbox, { filename: 'media-extensions.js' });

  assert(sandbox.window.mediaExtensions.isValidMediaFile('recording.dss') === true, '.dss should be valid');
  assert(sandbox.window.mediaExtensions.isValidMediaFile('recording.ds2') === false, '.ds2 should not be valid');
});

// --- Setup-state flow (speaker labelling: diarisation + word alignment) ---

async function loadRenderer(apiOverrides) {
  const ctx = makeBrowserContext();
  Object.assign(ctx.window.api, apiOverrides);
  const sandbox = { window: ctx.window, document: ctx.document, console, ...makeBrowserGlobals() };
  vm.createContext(sandbox);
  for (const mod of ['queue.js', 'media-extensions.js', 'time-estimates.js', 'transcript-format.js', 'job-options.js', 'renderer.js']) {
    vm.runInContext(fs.readFileSync(path.join(RENDERER_DIR, mod), 'utf-8'), sandbox, { filename: mod });
  }
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  const el = (id) => sandbox.document.getElementById(id);
  const fire = (id, type) => (el(id)._listeners[type] || []).forEach((fn) => fn({ preventDefault() {} }));
  return { el, fire, sandbox };
}

const READY_PY = { pythonFound: true, pythonVersion: '3.12.3', diarizationStatus: 'ready', pyannoteVersion: '4.0.7', gpuAvailable: true };

const asyncTests = [
  ['nothing downloaded yet: one download block with the token, switch disabled', async () => {
    const { el } = await loadRenderer({
      checkPythonSetup: () => Promise.resolve({ ...READY_PY, diarizationStatus: 'model-not-prepared' }),
      checkAlignment: () => Promise.resolve({ alignmentStatus: 'model-not-prepared' }),
    });
    assert(el('diarize-setup-block').hidden === false, 'download block visible');
    assert(el('hf-token-row').hidden === false, 'token asked for');
    assert(el('diarize-toggle').disabled === true, 'switch disabled');
    assert(el('diarize-status-text').textContent === 'Speaker model not downloaded', el('diarize-status-text').textContent);
    assert(el('alignment-status-text').textContent === 'Word alignment model not downloaded', el('alignment-status-text').textContent);
  }],
  ['both models ready: switch usable, no download block', async () => {
    const { el, fire } = await loadRenderer({
      checkPythonSetup: () => Promise.resolve(READY_PY),
      checkAlignment: () => Promise.resolve({ alignmentStatus: 'ready' }),
    });
    assert(el('diarize-setup-block').hidden === true, 'no download block when ready');
    assert(el('alignment-status-text').textContent === 'Word alignment model ready', el('alignment-status-text').textContent);
    assert(el('diarize-toggle').disabled === false, 'usable');
    el('diarize-toggle').checked = true;
    fire('diarize-toggle', 'change');
    assert(el('diarize-options').hidden === false, 'speaker count shown once on');
  }],
  ['speaker model ready but alignment model missing: switch disabled, download without a token', async () => {
    const { el } = await loadRenderer({
      checkPythonSetup: () => Promise.resolve(READY_PY),
      checkAlignment: () => Promise.resolve({ alignmentStatus: 'model-not-prepared' }),
    });
    assert(el('diarize-toggle').disabled === true, 'no labelling without alignment');
    assert(el('diarize-setup-block').hidden === false, 'download offered');
    assert(el('hf-token-row').hidden === true, 'no token needed');
  }],
  ['alignment packages missing or too old: plain status, switch disabled, no download', async () => {
    for (const [status, text] of [['alignment-missing', 'Word alignment packages not installed'],
      ['alignment-unsupported', 'Word alignment needs newer packages']]) {
      const { el } = await loadRenderer({
        checkPythonSetup: () => Promise.resolve(READY_PY),
        checkAlignment: () => Promise.resolve({ alignmentStatus: status, whisperxVersion: null }),
      });
      assert(el('alignment-status-text').textContent === text, el('alignment-status-text').textContent);
      assert(!/whisperx|null/i.test(el('alignment-status-text').textContent), 'no stale package name');
      assert(el('diarize-toggle').disabled === true, 'disabled');
      assert(el('diarize-setup-block').hidden === true, 'no download button: packages come first');
    }
  }],
  ['download button prepares both models in one call and re-checks', async () => {
    const calls = [];
    let status = 'model-not-prepared';
    const { el, fire } = await loadRenderer({
      checkPythonSetup: () => Promise.resolve(READY_PY),
      checkAlignment: () => Promise.resolve({ alignmentStatus: status }),
      prepareDiarization: (token, opts) => { calls.push(opts); status = 'ready'; return Promise.resolve({ status: 'ready' }); },
    });
    fire('btn-prepare-diarization', 'click');
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    assert(calls.length === 1 && calls[0].alignment === true, JSON.stringify(calls));
    assert(el('alignment-status-text').textContent === 'Word alignment model ready', el('alignment-status-text').textContent);
    assert(el('diarize-toggle').disabled === false, 'usable after download');
  }],
];

(async () => {
  for (const [name, fn] of asyncTests) {
    try { await fn(); console.log(`  PASS: ${name}`); passed++; } catch (e) { console.log(`  FAIL: ${name} -- ${e.message}`); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
