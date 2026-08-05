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
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      setAttribute() {},
      getAttribute() { return null; },
      addEventListener() {},
      removeEventListener() {},
      appendChild(c) { return c; },
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
    querySelector() { return null; },
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
    deriveJobOptions: () => noopPromise(null),
    getSettings: () => noopPromise({
      hfTokenConfigured: false,
      pyannote: { pythonFound: false },
      gpu: { backend: 'cpu', detected: null, deviceName: null, setting: 'auto', available: ['cpu'] },
    }),
    isDebugBuild: () => noopPromise(false),
    getVersion: () => noopPromise('0.0.0'),

    // Calls made by event handlers (not top-level but stubbed for completeness)
    selectFiles: () => noopPromise([]),
    transcribe: () => noopPromise({ text: '', model: 'tiny.en', engine: 'whisper.cpp', backend: 'cpu' }),
    downloadModel: () => noopPromise({ modelId: 'tiny.en', downloaded: true }),
    updateSettings: () => noopPromise({ hfTokenConfigured: true }),
    cancelTranscription: () => noopPromise(true),
    saveTranscript: () => noopPromise(false),
    openExternal: noopAsync,
    openLogFile: noopAsync,
    openLogFolder: noopAsync,
    installUpdate: noopAsync,
    registerDroppedFiles: () => noopPromise([]),
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

test('preload exposes object IPC contracts without raw path or settings access', () => {
  const calls = [];
  let exposed;
  const electron = {
    contextBridge: { exposeInMainWorld(name, api) { exposed = { name, api }; } },
    ipcRenderer: {
      invoke(channel, ...args) {
        calls.push({ channel, args });
        return Promise.resolve();
      },
      on() {},
    },
    webUtils: { getPathForFile(file) { return `/private/${file.name}`; } },
  };
  const sandbox = {
    require(name) {
      if (name === 'electron') return electron;
      throw new Error(`Unexpected preload require: ${name}`);
    },
    Array,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf-8'), sandbox, { filename: 'preload.js' });

  assert(exposed.name === 'api', 'preload should expose api');
  assert(!('getPathForFile' in exposed.api), 'raw path helper must not be exposed');
  assert(!('getLogPath' in exposed.api), 'raw log path helper must not be exposed');
  exposed.api.getModels();
  exposed.api.deriveJobOptions({ modelId: 'small', state: {} });
  exposed.api.downloadModel({ modelId: 'tiny.en' });
  exposed.api.transcribe({ fileId: 'file-1', modelId: 'tiny.en', options: {} });
  assert(calls[0].channel === 'get-models' && typeof calls[0].args[0] === 'object', 'get-models should receive an object');
  assert(calls[1].channel === 'derive-job-options' && calls[1].args[0].modelId === 'small', 'job options should use a narrow IPC contract');
  assert(calls[2].channel === 'download-model' && calls[2].args[0].modelId === 'tiny.en', 'download-model should receive an object');
  assert(calls[3].channel === 'transcribe' && calls[3].args[0].fileId === 'file-1', 'transcribe should receive an object');
});

test('presentation catalogue excludes download internals and keeps MOSS deferred', () => {
  const catalogue = require(path.join(ROOT, 'lib', 'model-catalogue'));
  const presented = catalogue.listPresentationModels();
  const moss = presented.find((model) => model.id === 'moss-transcribe-diarize');
  assert(presented.every((model) => !('sha256' in model)), 'checksums must not cross IPC');
  assert(presented.every((model) => !('repository' in model)), 'repositories must not cross IPC');
  assert(presented.every((model) => !('fileName' in model)), 'model file names must not cross IPC');
  assert(moss && moss.runtimeAvailable === false, 'MOSS should remain visible and unavailable');
});

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
    'model-chooser.js',
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
  const chooserSrc = fs.readFileSync(path.join(RENDERER_DIR, 'model-chooser.js'), 'utf-8');
  const optionsSrc = fs.readFileSync(path.join(RENDERER_DIR, 'job-options.js'), 'utf-8');
  const rendererSrc = fs.readFileSync(path.join(RENDERER_DIR, 'renderer.js'), 'utf-8');

  // Simulate loading all scripts
  const combined = `${queueSrc}\n${mediaSrc}\n${timeSrc}\n${formatSrc}\n${chooserSrc}\n${optionsSrc}\n${rendererSrc}`;
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
