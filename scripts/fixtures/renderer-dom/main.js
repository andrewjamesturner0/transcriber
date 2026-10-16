// Isolated IPC fixtures with the production renderer and production preload.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const [resultPath, nonce] = process.argv.slice(2);
const root = path.resolve(__dirname, '../../..');
const hostile = '<img id="injected" src=x onerror="globalThis.__injected=true"> & " \' onclick="globalThis.__injected=true"';
const filePaths = [`/fixture/${hostile}.wav`, '/fixture/ordinary.wav'];
const checks = [];
const errors = [];
const requests = [];
let win;
let selectedFiles = filePaths;
let transcribe = async () => ({
  text: '[1 speaker detected]\n\n[Speaker 1] ' + hostile + '\n\n[Unknown] unassigned',
  transcript: { kind: 'speaker-labelled', blocks: [
    { speaker: 'Speaker 1', text: hostile }, { speaker: 'Unknown', text: 'unassigned' },
  ], warnings: [] },
});
const plain = (text) => ({ text, transcript: { kind: 'plain', blocks: [], warnings: [] } });
let releaseJob;
let cancelled = false;
const saved = [];


const fixtures = {
  'get-models': () => [{ id: 'tiny.en', label: 'Tiny English', size: '75 MB', downloaded: true }],
  'check-python': () => ({ pythonFound: true, diarizationStatus: 'ready', pyannoteVersion: '4.0.7', gpuAvailable: false }),
  'check-alignment': () => ({ alignmentStatus: 'ready' }),
  'get-gpu-status': () => ({ backend: 'cpu' }),
  'is-debug-build': () => false,
  'get-version': () => 'fixture',
  'select-files': () => selectedFiles,
  'transcribe': (...args) => transcribe(...args),
  'save-transcript': (text) => { saved.push(text); return true; },
  'cancel-transcription': () => { cancelled = true; if (releaseJob) releaseJob(plain('cancelled')); return true; },
  'download-model': () => { throw new Error(hostile); },
  'get-licenses': () => [{ name: hostile, license: hostile, description: hostile, url: `https://${hostile}`, text: hostile }],
};
for (const [channel, handler] of Object.entries(fixtures)) {
  ipcMain.handle(channel, (_event, ...args) => {
    requests.push(channel);
    return handler(...args);
  });
}

async function evaluate(fn, ...args) {
  return win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
}

async function check(name, fn, ...args) {
  assert.equal(await evaluate(fn, ...args), true, name);
  checks.push(name);
}

async function waitFor(fn) {
  const deadline = Date.now() + 8000;
  while (!(await evaluate(fn))) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for renderer UI');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function run() {
  win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(root, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.on('preload-error', (_event, _preload, error) => errors.push(error.message));
  win.webContents.on('render-process-gone', (_event, detail) => errors.push(detail.reason));
  await win.loadFile(path.join(root, 'renderer/index.html'));
  await evaluate(() => {
    window.__policyViolations = [];
    window.addEventListener('securitypolicyviolation', (event) => window.__policyViolations.push(event.effectiveDirective));
    window.addEventListener('error', (event) => { window.__rendererError = event.message; });
    window.addEventListener('unhandledrejection', () => { window.__rendererError = 'Unhandled rejection'; });
  });
  await waitFor(() => document.getElementById('version-label').textContent === 'vfixture'
    && document.querySelectorAll('.estimate-row').length > 0
    && !document.getElementById('diarize-toggle').disabled);
  await check('production preload exposes IPC without Node globals', () => typeof window.api.selectFiles === 'function' && typeof require === 'undefined' && typeof process === 'undefined');
  assert.equal(win.webContents.getLastWebPreferences().contextIsolation, true);
  assert.equal(win.webContents.getLastWebPreferences().sandbox, true);
  checks.push('context isolation and sandbox remain enabled');
  await check('local stylesheet loads', () => getComputedStyle(document.querySelector('.app')).position === 'relative');
  await check('bundled font loads', async () => (await document.fonts.load('16px "DM Sans"')).length > 0);
  await check('decorative data image is allowed', () => getComputedStyle(document.querySelector('.bg-grain')).backgroundImage.startsWith('url("data:image/svg+xml,'));
  await check('local scripts populate model and estimates', () => document.getElementById('model-select').value === 'tiny.en' && document.querySelector('.estimate-model-name').textContent === 'Tiny');
  await evaluate(() => document.getElementById('btn-select').click());
  await waitFor(() => document.querySelectorAll('.queue-item').length === 2);
  await check('hostile filename is literal text', (text) => document.querySelector('.queue-item-name').textContent === `${text}.wav`, hostile);
  await check('hostile path stays a title property', (filePath) => document.querySelector('.queue-item-name').title === filePath, filePaths[0]);
  await check('queue contains only intended elements', () => document.querySelectorAll('.queue-item').length === 2 && !document.querySelector('#queue-list img, #queue-list [onclick], #queue-list [onerror]'));
  win.webContents.send('transcribe-status', hostile);
  await check('progress text stays literal with separate spinner', (text) => document.getElementById('status').textContent === text && document.querySelectorAll('#status > .spinner').length === 1 && document.getElementById('status').children.length === 1, hostile);
  win.webContents.send('diarize-status', { error: hostile });
  await check('speaker error stays literal without spinner', (text) => document.getElementById('status').textContent === `Speaker labelling error: ${text}` && document.getElementById('status').children.length === 0, hostile);
  win.webContents.send('diarize-status', { message: hostile, percent: 17 });
  await check('speaker progress stays literal', (text) => document.getElementById('status').textContent === `${text} (17%)`, hostile);
  win.webContents.send('download-progress', { percent: hostile });
  await check('download progress stays literal', (text) => document.getElementById('status').textContent === `Downloading model... ${text}%`, hostile);
  await evaluate(() => document.getElementById('btn-download').click());
  await waitFor(() => document.getElementById('status').classList.contains('status-error'));
  await check('IPC exception stays literal', (text) => document.getElementById('status').textContent.includes(text) && document.getElementById('status').children.length === 0, hostile);
  await evaluate(() => document.getElementById('btn-transcribe').click());
  await waitFor(() => !document.getElementById('output-section').hidden);
  await check('rich transcript text stays literal', (text) => [...document.querySelectorAll('.segment-text')].filter((el) => el.textContent === text).length === 2 && [...document.querySelectorAll('.segment-text')].filter((el) => el.textContent === 'unassigned').length === 2, hostile);
  await check('rich transcript filename stays literal', (text) => document.querySelector('.transcript-segment strong').textContent === `=== ${text}.wav ===`, hostile);
  await check('copy and save text stays in textarea value', (text) => document.getElementById('transcript').value.includes(text) && !document.getElementById('btn-save').disabled, hostile);
  await check('Unknown uses a neutral label and every word remains visible', () =>
    [...document.querySelectorAll('.speaker-label')].filter((el) => el.textContent === 'Unknown' && !/speaker-\d/.test(el.className)).length === 2);
  await check('finished results remain in the queue', () =>
    document.querySelectorAll('.queue-item.done').length === 2);
  await evaluate(() => document.getElementById('btn-save').click());
  await waitFor(() => document.getElementById('status').textContent === 'Saved!');
  assert.equal(saved[0], filePaths.map((file) => '=== ' + file.split('/').pop() + ' ===\n\n' +
    '[1 speaker detected]\n\n[Speaker 1] ' + hostile + '\n\n[Unknown] unassigned').join('\n\n\n'));
  checks.push('save receives exact canonical text with batch headings');

  selectedFiles = ['/fixture/next.wav'];
  transcribe = async () => plain('second batch only');
  await evaluate(() => document.getElementById('btn-select').click());
  await waitFor(() => document.querySelectorAll('.queue-item').length === 3);
  await evaluate(() => document.getElementById('btn-transcribe').click());
  await waitFor(() => document.getElementById('transcript').value === 'second batch only');
  await check('next batch excludes old results and resets rich output', () =>
    !document.getElementById('transcript-rich') && !document.getElementById('transcript').hidden &&
    document.querySelectorAll('.queue-item.done').length === 3 && document.getElementById('diarize-info').hidden);
  await evaluate(() => document.querySelector('.btn-clear-queue').click());
  await waitFor(() => document.querySelectorAll('.queue-item').length === 0);
  await check('idle clear removes all statuses and output', () =>
    document.getElementById('output-section').hidden && document.getElementById('transcript').value === '');

  selectedFiles = ['/fixture/failed.wav', '/fixture/good.wav'];
  transcribe = async (file) => {
    if (file.endsWith('failed.wav')) throw new Error(hostile.repeat(10));
    return plain('successful remainder');
  };
  await evaluate(() => document.getElementById('btn-select').click());
  await waitFor(() => document.querySelectorAll('.queue-item').length === 2);
  await evaluate(() => document.getElementById('btn-transcribe').click());
  await waitFor(() => document.querySelectorAll('.queue-item.error').length === 1 && !document.getElementById('btn-cancel').hidden === false);
  await check('failure stays visible and successful remainder is exported', (text) =>
    document.querySelector('.queue-item.error .queue-item-status').textContent.includes(text) &&
    document.getElementById('status').textContent.includes(text) &&
    document.getElementById('transcript').value === 'successful remainder', hostile);
  await check('long retained errors fit the existing queue layout', () => {
    const list = document.getElementById('queue-list');
    const status = document.getElementById('status');
    return list.scrollWidth <= list.clientWidth && status.scrollWidth <= status.clientWidth;
  });
  await evaluate(() => document.querySelector('.btn-clear-queue').click());

  selectedFiles = ['/mixed/plain.wav', '/mixed/tiny.wav', '/mixed/labelled.wav'];
  const tinyText = '[00:00:00.000 --> 00:00:01.000] Hello[SPEAKER_TURN]World';
  transcribe = async (file) => {
    if (file.endsWith('plain.wav')) return plain('Literal [Speaker 9] remains plain.');
    if (file.endsWith('tiny.wav')) return { text: tinyText, transcript: { kind: 'tinydiarize', blocks: [], warnings: [] } };
    return {
      text: '[0 speakers detected]\n\n[Unknown] All unassigned.',
      transcript: { kind: 'speaker-labelled', blocks: [{ speaker: 'Unknown', text: 'All unassigned.' }],
        warnings: ['Word alignment failed; using Whisper timing'] },
    };
  };
  await evaluate(() => document.getElementById('btn-select').click());
  await waitFor(() => document.querySelectorAll('.queue-item').length === 3);
  await evaluate(() => document.getElementById('btn-transcribe').click());
  await waitFor(() => document.getElementById('btn-cancel').hidden);
  await check('mixed plain and TinyDiarize display does not invent speaker labels', () =>
    document.querySelectorAll('.speaker-label').length === 1 &&
    document.querySelectorAll('.segment-text')[0].textContent === 'Literal [Speaker 9] remains plain.' &&
    document.querySelectorAll('.segment-text')[1].textContent === 'Hello\n\n--- Speaker Change ---\n\nWorld');
  await check('all-Unknown result preserves text and reports zero known speakers', () =>
    document.querySelector('.speaker-label').textContent === 'Unknown' &&
    document.querySelectorAll('.segment-text')[2].textContent === 'All unassigned.' &&
    document.getElementById('diarize-info').textContent.includes('0 speakers detected'));
  await check('fallback warnings remain visible after a completed batch', () =>
    document.getElementById('status').textContent.includes('labelled.wav: Word alignment failed; using Whisper timing'));
  const mixedExpected = '=== plain.wav ===\n\nLiteral [Speaker 9] remains plain.' +
    '\n\n\n=== tiny.wav ===\n\n' + tinyText + '\n\n\n=== labelled.wav ===\n\n[0 speakers detected]\n\n[Unknown] All unassigned.';
  await check('mixed copy source preserves exact canonical text', (expected) =>
    document.getElementById('transcript').value === expected, mixedExpected);
  await evaluate(() => document.querySelector('.btn-clear-queue').click());
  selectedFiles = ['/fixture/tiny.wav'];
  transcribe = async () => ({ text: tinyText, transcript: { kind: 'tinydiarize', blocks: [], warnings: [] } });
  await evaluate(() => document.getElementById('btn-select').click());
  await waitFor(() => document.querySelectorAll('.queue-item').length === 1);
  await evaluate(() => document.getElementById('btn-transcribe').click());
  await waitFor(() => document.getElementById('btn-cancel').hidden);
  await check('TinyDiarize alone has formatted display and canonical copy source', (canonical) =>
    document.querySelector('.segment-text').textContent === 'Hello\n\n--- Speaker Change ---\n\nWorld' &&
    document.getElementById('transcript').value === canonical && !document.querySelector('.speaker-label'), tinyText);
  await evaluate(() => document.querySelector('.btn-clear-queue').click());

  selectedFiles = ['/fixture/active.wav', '/fixture/removed.wav', '/fixture/cleared.wav'];
  let started = [];
  transcribe = (file) => {
    started.push(file);
    return new Promise((resolve) => { releaseJob = resolve; });
  };
  await evaluate(() => document.getElementById('btn-select').click());
  await waitFor(() => document.querySelectorAll('.queue-item').length === 3);
  await evaluate(() => document.getElementById('btn-transcribe').click());
  await waitFor(() => document.querySelectorAll('.queue-item.processing').length === 1);
  await evaluate(() => document.querySelectorAll('.queue-item-remove')[1].click());
  await evaluate(() => document.querySelector('.btn-clear-queue').click());
  await check('active clear removes only pending work', () => document.querySelectorAll('.queue-item').length === 1 &&
    document.querySelector('.queue-item').classList.contains('processing'));
  // A dropped file can be added while selection is disabled. It waits for the next run.
  await evaluate(() => addToQueue(['/fixture/deferred.wav']));
  releaseJob(plain('active result'));
  await waitFor(() => document.getElementById('btn-cancel').hidden);
  assert.deepEqual(started, ['/fixture/active.wav']);
  await check('new work is deferred and removed work never starts', () =>
    document.querySelectorAll('.queue-item.pending').length === 1 && document.getElementById('transcript').value === 'active result');

  releaseJob = null;
  await evaluate(() => document.getElementById('btn-transcribe').click());
  await waitFor(() => document.querySelectorAll('.queue-item.processing').length === 1);
  await evaluate(() => document.getElementById('btn-cancel').click());
  await waitFor(() => document.getElementById('btn-cancel').hidden);
  assert.equal(cancelled, true);
  await check('cancelled active work retains its reason and restores controls', () =>
    document.querySelector('.queue-item.error .queue-item-status').textContent === 'Cancelled' &&
    !document.getElementById('btn-select').disabled && document.getElementById('output-section').hidden);
  checks.push('cancel uses production preload IPC');

  await evaluate(() => document.getElementById('btn-licenses').click());
  await waitFor(() => !document.getElementById('license-overlay').hidden);
  await check('licence fields stay literal', (text) => ['.license-name', '.license-badge', '.license-description', '.license-url', '.license-full-text'].every((sel) => document.querySelector(sel).textContent === text), hostile);
  await evaluate(() => document.querySelector('.license-toggle').click());
  await check('licence details still open', () => !document.querySelector('.license-full-text').hidden);
  await check('hostile strings create no injected elements or handlers', () => !document.getElementById('injected') && !document.querySelector('[onerror], [onclick]') && !window.__injected);
  await check('ordinary UI causes no CSP violations or renderer errors', () => window.__policyViolations.length === 0 && !window.__rendererError);
  await evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__inlineRan = true';
    document.body.appendChild(script);
    const button = document.createElement('button');
    button.setAttribute('onclick', 'window.__handlerRan = true');
    document.body.appendChild(button);
    button.click();
  });
  await waitFor(() => window.__policyViolations.length >= 2);
  await check('CSP blocks inline scripts and handlers', () => !window.__inlineRan && !window.__handlerRan && window.__policyViolations.includes('script-src-elem') && window.__policyViolations.includes('script-src-attr'));
  assert.deepEqual(errors, [], 'No preload or renderer process failures');
  assert.ok(requests.includes('select-files') && requests.includes('transcribe'), 'Real preload IPC must be exercised');
  fs.writeFileSync(resultPath, JSON.stringify({ nonce, passed: true, checks, electron: process.versions.electron }));
  app.exit(0);
}

app.whenReady().then(run).catch((error) => {
  console.error(error.stack);
  app.exit(1);
});
