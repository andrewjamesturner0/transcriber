#!/usr/bin/env node
/**
 * Renderer smoke test — loads all renderer scripts in a minimal browser-like
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
    // Event listeners — just accept a callback
    onDownloadProgress: noop,
    onStatus: noop,
    onDiarizeStatus: noop,
    onUpdateAvailable: noop,
    onUpdateDownloaded: noop,

    // Init calls that fire at load time
    getModels: () => noopPromise([]),
    checkPythonSetup: () => noopPromise({ pythonFound: false }),
    getGpuStatus: () => noopPromise({ backend: 'cpu', detected: null, deviceName: null, setting: 'auto', available: ['cpu'] }),
    isDebugBuild: () => noopPromise(false),
    getVersion: () => noopPromise('0.0.0'),

    // Calls made by event handlers (not top-level but stubbed for completeness)
    selectFiles: () => noopPromise([]),
    transcribe: () => noopPromise(''),
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

  // queue.js must run first (sets window.createQueue)
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(RENDERER_DIR, 'queue.js'), 'utf-8'),
    sandbox,
    { filename: 'queue.js' },
  );

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
  const rendererSrc = fs.readFileSync(path.join(RENDERER_DIR, 'renderer.js'), 'utf-8');

  // Simulate loading both scripts
  const combined = `${queueSrc}\n${rendererSrc}`;
  vm.runInContext(combined, sandbox, { filename: 'renderer-combined.js' });

  // If we got here without throwing, both scripts parsed and top-level code ran.
  assert(true, 'combined scripts loaded without error');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
