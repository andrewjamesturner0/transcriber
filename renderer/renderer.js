// Transcriber — local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

const btnSelect = document.getElementById('btn-select');
const btnTranscribe = document.getElementById('btn-transcribe');
const btnSave = document.getElementById('btn-save');
const btnCopy = document.getElementById('btn-copy');
const btnDownload = document.getElementById('btn-download');
const modelSelect = document.getElementById('model-select');

const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const outputSection = document.getElementById('output-section');
const estimateCurrentText = document.getElementById('estimate-current-text');
const estimateExpandBtn = document.getElementById('estimate-expand-btn');
const estimateAll = document.getElementById('estimate-all');
const estimateAllBody = document.getElementById('estimate-all-body');
const diarizeInfoEl = document.getElementById('diarize-info');
const elapsedTimerEl = document.getElementById('elapsed-timer');
const elapsedTimeEl = document.getElementById('elapsed-time');
const queueListEl = document.getElementById('queue-list');
const queueSummaryEl = document.getElementById('queue-summary');
const menuBtn = document.getElementById('menu-btn');
const menuDropdown = document.getElementById('menu-dropdown');
const antiCorruptionToggle = document.getElementById('anti-corruption-toggle');
const diarizeToggle = document.getElementById('diarize-toggle');
const diarizeOptions = document.getElementById('diarize-options');
const diarizeStatusText = document.getElementById('diarize-status-text');
const diarizeStatusDot = document.querySelector('#diarize-setup-status .menu-status-dot');
const hfTokenInput = document.getElementById('hf-token-input');
const diarizeSetupBlock = document.getElementById('diarize-setup-block');
const btnPrepareDiarization = document.getElementById('btn-prepare-diarization');
const hfTokenRow = document.getElementById('hf-token-row');
const alignmentStatusRow = document.getElementById('alignment-status');
const alignmentStatusDot = document.getElementById('alignment-status-dot');
const alignmentStatusText = document.getElementById('alignment-status-text');
let diarizeStatus = 'checking';
let alignmentStatus = 'checking';
const numSpeakersSelect = document.getElementById('num-speakers-select');
const gpuStatus = document.getElementById('gpu-status');
const gpuStatusDot = document.getElementById('gpu-status-dot');
const gpuStatusText = document.getElementById('gpu-status-text');
const btnCheckPython = document.getElementById('btn-check-python');
const btnCancel = document.getElementById('btn-cancel');
const backendDot = document.getElementById('backend-dot');
const backendLabel = document.getElementById('backend-label');

let models = [];
let pythonSetup = null;

function appendTextElement(parent, tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

// --- Queue state ---

const queue = createQueue();
let cancelController = null;

// --- Timer state ---

let timerInterval = null;
let timerStartTime = null;

// --- Model picker ---

async function loadModels() {
  models = await window.api.getModels();
  const currentValue = modelSelect.value;
  modelSelect.replaceChildren();
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.downloaded
      ? `${m.label}  (${m.size})`
      : `${m.label}  (${m.size}) - not downloaded`;
    if (!m.downloaded) opt.className = 'not-downloaded';
    modelSelect.appendChild(opt);
  }
  if (currentValue && models.find((m) => m.id === currentValue)) {
    modelSelect.value = currentValue;
  }
  onModelChange();
}

function onModelChange() {
  const m = models.find((m) => m.id === modelSelect.value);
  if (!m) return;
  btnDownload.hidden = m.downloaded;
  const s = queue.getSummary();
  const items = queue.getSnapshot();
  btnTranscribe.disabled = !m.downloaded || items.length === 0 || s.pending === 0;
  updateEstimateBanner();
}

modelSelect.addEventListener('change', onModelChange);

btnDownload.addEventListener('click', async () => {
  const modelId = modelSelect.value;
  btnDownload.disabled = true;
  setStatus('Starting download...', 'progress');
  try {
    await window.api.downloadModel(modelId);
    await loadModels();
    setStatus('Download complete!', 'success');
    setTimeout(() => setStatus(''), 3000);
  } catch (err) {
    setStatus('Download error: ' + err.message, 'error');
  } finally {
    btnDownload.disabled = false;
  }
});

window.api.onDownloadProgress((data) => {
  setStatus(`Downloading model... ${data.percent}%`, 'progress');
});

// --- Time estimate banner ---

function estimateLabel(key) {
  if (!key) return '';
  if (key === 'large-turbo') return 'Large Turbo';
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function updateEstimateBanner() {
  const currentKey = window.timeEstimates.getEstimateKey(modelSelect.value);
  const est = currentKey ? window.timeEstimates.TIME_ESTIMATES[currentKey] : null;

  if (est) {
    estimateCurrentText.replaceChildren();
    appendTextElement(estimateCurrentText, 'span', 'estimate-model-name', estimateLabel(currentKey));
    estimateCurrentText.append(` model: ${est.example} for 45 min of audio \u2014 ${est.ratio} `);
    appendTextElement(estimateCurrentText, 'span', 'estimate-gpu-note', '(CPU, faster with GPU)');
  } else {
    estimateCurrentText.textContent = 'Select a model to see time estimates';
  }

  // Update expanded list
  estimateAllBody.replaceChildren();
  for (const [key, e] of Object.entries(window.timeEstimates.TIME_ESTIMATES)) {
    const active = key === currentKey ? ' estimate-active' : '';
    const row = appendTextElement(estimateAllBody, 'div', `estimate-row${active}`, '');
    const name = appendTextElement(row, 'span', '', `${estimateLabel(key)} `);
    appendTextElement(name, 'span', 'estimate-quality', e.quality);
    const time = appendTextElement(row, 'span', 'estimate-time', `${e.example} `);
    appendTextElement(time, 'span', 'estimate-ratio', e.ratio);
  }
  appendTextElement(estimateAllBody, 'div', 'estimate-gpu-footer', 'CPU estimates \u2014 faster with GPU acceleration');
}

estimateExpandBtn.addEventListener('click', () => {
  const isHidden = estimateAll.hidden;
  estimateAll.hidden = !isHidden;
  estimateExpandBtn.classList.toggle('expanded', isHidden);
});

// --- Elapsed timer ---

function startTimer() {
  stopTimer();
  timerStartTime = Date.now();
  elapsedTimerEl.hidden = false;
  elapsedTimeEl.textContent = '00:00';
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - timerStartTime) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');
    elapsedTimeEl.textContent = `${mins}:${secs}`;
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function hideTimer() {
  stopTimer();
  elapsedTimerEl.hidden = true;
}

// --- Queue management ---

function syncQueueUI() {
  const items = queue.getSnapshot();
  const s = queue.getSummary();

  if (items.length === 0) {
    queueListEl.replaceChildren();
    queueListEl.hidden = true;
    queueSummaryEl.replaceChildren();
    queueSummaryEl.hidden = true;
    return;
  }

  queueListEl.hidden = false;
  queueListEl.replaceChildren();

  for (const item of items) {
    const li = document.createElement('li');
    li.className = `queue-item ${item.status}`;
    const name = appendTextElement(li, 'span', 'queue-item-name', item.fileName);
    name.title = item.filePath;
    appendTextElement(li, 'span', `queue-item-status ${item.status}`, item.error || item.status);
    const remove = appendTextElement(li, 'button', 'queue-item-remove', '\u00d7');
    remove.dataset.id = item.id;
    remove.title = 'Remove';
    queueListEl.appendChild(li);
  }

  const isProcessing = queue.isRunning();
  queueSummaryEl.hidden = false;
  queueSummaryEl.replaceChildren();
  appendTextElement(queueSummaryEl, 'span', '', `${s.done} of ${s.total} completed${s.pending > 0 ? ` \u00b7 ${s.pending} remaining` : ''}`);
  appendTextElement(queueSummaryEl, 'button', 'btn-clear-queue', isProcessing ? 'Clear pending' : 'Clear all');
}

function addToQueue(filePaths) {
  const files = filePaths.map((fp) => ({ filePath: fp, fileName: fp.split(/[\\/]/).pop() }));
  queue.enqueue(files);
  syncQueueUI();
  onModelChange();
}

function removeFromQueue(id) {
  queue.remove(id);
  if (queue.getSnapshot().length === 0) hideTimer();
  syncQueueUI();
  onModelChange();
}

function resetOutput() {
  hideTimer();
  outputSection.hidden = true;
  transcriptEl.value = '';
  transcriptEl.hidden = false;
  const richEl = document.getElementById('transcript-rich');
  if (richEl) richEl.remove();
  diarizeInfoEl.hidden = true;
  btnSave.disabled = true;
}

function clearQueue() {
  if (queue.isRunning()) queue.clearPending();
  else {
    queue.clearAll();
    resetOutput();
  }
  syncQueueUI();
  onModelChange();
}

// Event delegation for queue item removal
queueListEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.queue-item-remove');
  if (btn) {
    e.stopPropagation();
    removeFromQueue(Number(btn.dataset.id));
  }
});

// Event delegation for clear queue button
queueSummaryEl.addEventListener('click', (e) => {
  if (e.target.closest('.btn-clear-queue')) {
    clearQueue();
  }
});

// --- File selection (click) ---

btnSelect.addEventListener('click', async () => {
  const filePaths = await window.api.selectFiles();
  if (filePaths && filePaths.length > 0) {
    addToQueue(filePaths);
  }
});

// --- Drag and drop ---

function handleDroppedFiles(files) {
  const validFiles = Array.from(files).filter((f) => window.mediaExtensions.isValidMediaFile(f.name));
  if (validFiles.length === 0) {
    setStatus('No supported media files. Supported: MP3, WAV, FLAC, M4A, OGG, WebM, WMA, AAC, MP4, MOV, AVI, MKV', 'error');
    setTimeout(() => setStatus(''), 4000);
    return;
  }
  addToQueue(validFiles.map((f) => window.api.getPathForFile(f)));
}

function onDragEnterOver(e) {
  e.preventDefault();
  e.stopPropagation();
  btnSelect.classList.add('drag-over');
}
btnSelect.addEventListener('dragenter', onDragEnterOver);
btnSelect.addEventListener('dragover', onDragEnterOver);

btnSelect.addEventListener('dragleave', (e) => {
  e.preventDefault();
  e.stopPropagation();
  btnSelect.classList.remove('drag-over');
});

btnSelect.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  btnSelect.classList.remove('drag-over');
  if (e.dataTransfer.files.length > 0) {
    handleDroppedFiles(e.dataTransfer.files);
  }
});

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// --- Transcription (serial queue processing) ---

btnTranscribe.addEventListener('click', async () => {
  if (queue.isRunning() || queue.getSummary().pending === 0) return;
  resetOutput();
  btnTranscribe.disabled = true;
  btnCancel.hidden = false;
  btnSelect.disabled = true;
  startTimer();

  const controller = new AbortController();
  cancelController = controller;
  try {
    const run = await queue.processAll(async (item) => {
      setStatus('Transcribing ' + item.fileName + '...', 'progress');
      const options = window.jobOptions.buildJobOptions({
        antiCorruption: antiCorruptionToggle.checked,
        diarizationOn: diarizeToggle.checked,
        numSpeakers: numSpeakersSelect.value,
      });
      return window.api.transcribeResult(item.filePath, modelSelect.value, options);
    }, { signal: controller.signal, onChange: () => syncQueueUI() });

    const results = run.filter(({ status }) => status === 'done')
      .map(({ item }) => ({ fileName: item.fileName, ...item.result }));
    transcriptEl.value = window.transcriptFormat.formatBatchText(results);
    const segments = results.flatMap((result) => window.transcriptFormat.getTranscriptSegments(result));
    const labelled = results.some((result) => result.transcript.kind === 'speaker-labelled');
    if (labelled || results.some((result) => result.transcript.kind === 'tinydiarize')) {
      displayRichTranscript(results);
    }
    if (labelled) {
      const known = [...new Map(segments.filter((segment) => segment.speakerNum > 0)
        .map((segment) => [segment.speakerLabel, segment])).values()];
      const unknown = segments.some((segment) => segment.speakerLabel === 'Unknown');
      diarizeInfoEl.replaceChildren();
      for (const segment of known) {
        appendTextElement(diarizeInfoEl, 'span', 'diarize-info-dot speaker-' + segment.speakerNum + '-bg', '');
      }
      diarizeInfoEl.append(' ' + known.length + ' speaker' + (known.length !== 1 ? 's' : '') + ' detected' + (unknown ? '; some words have no assigned speaker' : ''));
      diarizeInfoEl.className = 'diarize-info diarize-info-speakers';
      diarizeInfoEl.hidden = false;
    } else {
      const turns = results.reduce((count, result) => count + window.transcriptFormat.countWhisperSpeakerTurns(result.text), 0);
      if (turns > 0) {
        diarizeInfoEl.textContent = turns + ' speaker change' + (turns !== 1 ? 's' : '') + ' detected - speaker detection is experimental and may be inaccurate';
        diarizeInfoEl.className = 'diarize-info';
        diarizeInfoEl.hidden = false;
      }
    }
    outputSection.hidden = results.length === 0;
    btnSave.disabled = !transcriptEl.value;
    const errors = run.filter(({ status }) => status === 'error').map(({ item }) => item.fileName + ': ' + item.error);
    const warnings = results.flatMap((result) => result.transcript.warnings.map((warning) => result.fileName + ': ' + warning));
    const messages = [...errors, ...warnings];
    setStatus(messages.join('\n'), messages.length ? 'error' : undefined);
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    stopTimer();
    cancelController = null;
    btnCancel.hidden = true;
    btnSelect.disabled = false;
    syncQueueUI();
    onModelChange();
  }
});

// --- Cancel ---

btnCancel.addEventListener('click', async () => {
  btnCancel.disabled = true;
  setStatus('Cancelling...', 'progress');
  if (cancelController) cancelController.abort();
  try {
    await window.api.cancelTranscription();
  } catch (_) {}
  btnCancel.disabled = false;
});

// --- Save ---

btnSave.addEventListener('click', async () => {
  const text = transcriptEl.value;
  if (!text) return;
  const saved = await window.api.saveTranscript(text);
  if (saved) {
    setStatus('Saved!', 'success');
    setTimeout(() => setStatus(''), 3000);
  }
});

// --- Copy ---

btnCopy.addEventListener('click', async () => {
  const text = transcriptEl.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const orig = Array.from(btnCopy.childNodes);
    btnCopy.innerHTML = `<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Copied`;
    setTimeout(() => { btnCopy.replaceChildren(...orig); }, 2000);
  } catch (_) {}
});

// --- Status ---

window.api.onStatus((msg) => setStatus(msg, 'progress'));

function setStatus(msg, type) {
  if (msg) {
    statusEl.hidden = false;
    statusEl.className = 'status';
    if (type === 'error') statusEl.classList.add('status-error');
    else if (type === 'success') statusEl.classList.add('status-success');

    statusEl.replaceChildren();
    if (type === 'progress') appendTextElement(statusEl, 'span', 'spinner', '');
    statusEl.append(msg);
  } else {
    statusEl.hidden = true;
    statusEl.textContent = '';
  }
}

// --- Rich transcript rendering ---

function displayRichTranscript(results) {
  // Replace textarea with rich div for speaker-colored output
  const container = document.createElement('div');
  container.className = 'transcript-rich';
  container.id = 'transcript-rich';
  container.setAttribute('tabindex', '0');

  for (const result of results) {
    if (results.length > 1) {
      const fileHeader = document.createElement('div');
      fileHeader.className = 'transcript-segment';
      appendTextElement(fileHeader, 'strong', '', `=== ${result.fileName} ===`);
      container.appendChild(fileHeader);
    }

    const segments = window.transcriptFormat.getTranscriptSegments(result);
    for (const seg of segments) {
      const div = document.createElement('div');
      div.className = 'transcript-segment';
      if (seg.speakerLabel !== null) {
        const label = seg.speakerLabel === 'Unknown' ? 'Unknown' : 'Speaker ' + seg.speakerLabel;
        appendTextElement(div, 'span', seg.speakerNum ? 'speaker-label speaker-' + seg.speakerNum : 'speaker-label', label);
      }
      appendTextElement(div, 'span', 'segment-text', seg.text);
      container.appendChild(div);
    }
  }

  // Replace textarea (or previous rich div) with the new container
  const existing = document.getElementById('transcript-rich');
  if (existing) {
    existing.replaceWith(container);
  } else {
    transcriptEl.hidden = true;
    transcriptEl.parentNode.insertBefore(container, transcriptEl);
  }

  transcriptEl.value = window.transcriptFormat.formatBatchText(results);
}

// --- License modal ---

const btnLicenses = document.getElementById('btn-licenses');
const licenseOverlay = document.getElementById('license-overlay');
const btnCloseLicenses = document.getElementById('btn-close-licenses');
const licenseModalBody = document.getElementById('license-modal-body');

let cachedLicenses = null;

function getBadgeClass(license) {
  return /gpl|noncommercial|cc-by-nc|unclarified/i.test(license) ? 'license-badge-lgpl' : 'license-badge-mit';
}

function renderLicenses(licenses) {
  licenseModalBody.replaceChildren();
  licenses.forEach((lic, i) => {
    const section = appendTextElement(licenseModalBody, 'div', 'license-section', '');
    const header = appendTextElement(section, 'div', 'license-section-header', '');
    appendTextElement(header, 'span', 'license-name', lic.name);
    appendTextElement(header, 'span', `license-badge ${getBadgeClass(lic.license)}`, lic.license);
    appendTextElement(section, 'div', 'license-description', lic.description);
    appendTextElement(section, 'div', 'license-url', lic.url.replace('https://', ''));
    const toggle = appendTextElement(section, 'button', 'license-toggle', '');
    toggle.dataset.index = i;
    toggle.type = 'button';
    // This icon is fixed application markup; licence data is always text.
    toggle.innerHTML = '<svg viewBox="0 0 16 16" fill="none" width="10" height="10"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    toggle.append(' View licence details');
    const text = appendTextElement(section, 'div', 'license-full-text', lic.text);
    text.id = `license-text-${i}`;
    text.hidden = true;
  });
}

btnLicenses.addEventListener('click', async (e) => {
  e.preventDefault();
  if (!cachedLicenses) {
    try {
      cachedLicenses = await window.api.getLicenses();
    } catch (err) {
      return;
    }
  }
  renderLicenses(cachedLicenses);
  licenseOverlay.hidden = false;
});

function closeLicenseModal() {
  licenseOverlay.hidden = true;
}

btnCloseLicenses.addEventListener('click', closeLicenseModal);

licenseOverlay.addEventListener('click', (e) => {
  if (e.target === licenseOverlay) closeLicenseModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!licenseOverlay.hidden) closeLicenseModal();
    if (!menuDropdown.hidden) {
      menuDropdown.hidden = true;
      menuBtn.classList.remove('active');
    }
  }
});

licenseModalBody.addEventListener('click', (e) => {
  const toggle = e.target.closest('.license-toggle');
  if (!toggle) return;
  const idx = toggle.dataset.index;
  const textEl = document.getElementById(`license-text-${idx}`);
  const isHidden = textEl.hidden;
  textEl.hidden = !isHidden;
  toggle.classList.toggle('expanded', isHidden);
});

// --- Sponsor link ---

document.getElementById('btn-sponsor').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://github.com/sponsors/andrewjamesturner0');
});

// --- Speaker labelling setup ---
//
// One switch, no partial mode: a labelled job always runs pyannote and word
// alignment, so the switch needs both models. One button downloads whichever
// is missing; the Hugging Face token is only asked for when the speaker
// model is the missing one.

async function checkPythonSetup() {
  btnCheckPython.classList.add('checking');
  diarizeStatusText.textContent = 'Checking...';
  diarizeStatusDot.className = 'menu-status-dot menu-status-dot-unknown';

  try {
    pythonSetup = await window.api.checkPythonSetup();
  } catch (_) {
    pythonSetup = { pythonFound: false };
  }

  const status = pythonSetup.diarizationStatus || (pythonSetup.pythonFound ? 'unknown' : 'python-missing');
  diarizeStatus = status;
  const speakerReady = status === 'ready';
  diarizeStatusText.textContent = diarizeStatusMessage(status, pythonSetup);
  diarizeStatusDot.className = `menu-status-dot ${speakerReady ? 'menu-status-dot-ready' : 'menu-status-dot-error'}`;
  gpuStatus.hidden = !speakerReady;
  if (speakerReady) {
    if (pythonSetup.gpuAvailable) {
      gpuStatusDot.className = 'menu-status-dot menu-status-dot-ready';
      gpuStatusText.textContent = 'CUDA detected';
    } else {
      gpuStatusDot.className = 'menu-status-dot menu-status-dot-error';
      gpuStatusText.textContent = 'CUDA not detected';
    }
  }

  // align.py runs in the same Python, so it is only worth checking once
  // pyannote's packages are in place.
  if (status === 'ready' || status === 'model-not-prepared') {
    alignmentStatus = 'checking';
    let info;
    try {
      info = await window.api.checkAlignment();
    } catch (_) {
      info = { alignmentStatus: 'unknown' };
    }
    alignmentStatus = info.alignmentStatus;
    alignmentStatusRow.hidden = false;
    alignmentStatusText.textContent = alignmentStatusMessage(alignmentStatus);
    alignmentStatusDot.className = `menu-status-dot ${alignmentStatus === 'ready' ? 'menu-status-dot-ready' : 'menu-status-dot-error'}`;
  } else {
    alignmentStatus = 'unavailable';
    alignmentStatusRow.hidden = true;
  }

  btnCheckPython.classList.remove('checking');
  refreshSpeakerLabelControls();
}

/** Enable the switch and show the download step from both setup checks. */
function refreshSpeakerLabelControls() {
  const state = window.jobOptions.speakerLabelState({ diarizationStatus: diarizeStatus, alignmentStatus });
  diarizeToggle.disabled = !state.ready;
  if (!state.ready) diarizeToggle.checked = false;
  diarizeOptions.hidden = !(state.ready && diarizeToggle.checked);
  diarizeSetupBlock.hidden = !state.canDownload;
  // The token is only needed to download the speaker model, so it only shows then.
  hfTokenRow.hidden = !state.needsToken;
}

/** Short status line for the pyannote part of the setup. */
function diarizeStatusMessage(status, info) {
  switch (status) {
    case 'ready': return `pyannote ${info.pyannoteVersion} and speaker model ready`;
    case 'python-missing': return 'Python 3.10+ not found';
    case 'python-unsupported': return `Python ${info.pythonVersion} is too old (3.10+ needed)`;
    case 'pyannote-missing': return 'pyannote not installed';
    case 'pyannote-unsupported': return `pyannote ${info.pyannoteVersion} not supported (4.x needed)`;
    case 'model-not-prepared': return 'Speaker model not downloaded';
    default: return 'Setup could not be checked';
  }
}

/** Short status line for the word alignment part of the setup. */
function alignmentStatusMessage(status) {
  switch (status) {
    case 'ready': return 'Word alignment model ready';
    case 'model-not-prepared': return 'Word alignment model not downloaded';
    case 'alignment-missing': return 'Word alignment packages not installed';
    case 'alignment-unsupported': return 'Word alignment needs newer packages';
    default: return 'Word alignment could not be checked';
  }
}

btnPrepareDiarization.addEventListener('click', async () => {
  const { needsToken } = window.jobOptions.speakerLabelState({ diarizationStatus: diarizeStatus, alignmentStatus });
  const token = hfTokenInput.value.trim();
  if (needsToken && !token) {
    diarizeStatusText.textContent = 'Enter a Hugging Face token first';
    return;
  }
  btnPrepareDiarization.disabled = true;
  btnPrepareDiarization.classList.add('checking');
  setStatus('Downloading speaker models...', 'progress');
  try {
    // --alignment prepares the speaker model too, unless it is already there.
    await window.api.prepareDiarization(token || undefined, { alignment: true });
    hfTokenInput.value = '';
    // Replace the last progress line, which still shows a spinner.
    setStatus('Speaker models ready', 'success');
    setTimeout(() => setStatus(''), 3000);
  } catch (err) {
    const msg = String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    setStatus(`Speaker model download failed: ${msg}`, 'error');
  }
  btnPrepareDiarization.disabled = false;
  btnPrepareDiarization.classList.remove('checking');
  await checkPythonSetup();
});

btnCheckPython.addEventListener('click', checkPythonSetup);

document.getElementById('btn-diarize-setup-guide').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://github.com/andrewjamesturner0/transcriber/blob/master/docs/diarization-setup.md');
});

diarizeToggle.addEventListener('change', () => {
  diarizeOptions.hidden = !diarizeToggle.checked;
});

// Older versions saved a separate alignment switch; it no longer exists.
try { localStorage.removeItem('align-words'); } catch (_) {}

// The token is only needed for the one-off model download, so it is not
// stored. Remove any token an older version saved.
try { localStorage.removeItem('hf-token'); } catch (_) {}

// Listen for diarization progress
window.api.onDiarizeStatus((data) => {
  if (data.error) {
    setStatus(`Speaker labelling error: ${data.error}`, 'error');
  } else if (data.message) {
    const pct = data.percent != null ? ` (${data.percent}%)` : '';
    setStatus(`${data.message}${pct}`, 'progress');
  }
});

// --- Debug panel (only shown in debug builds) ---

window.api.isDebugBuild().then((isDebug) => {
  if (isDebug) {
    document.getElementById('debug-panel').hidden = false;
  }
});

document.getElementById('btn-open-log').addEventListener('click', () => {
  window.api.openLogFile();
});

document.getElementById('btn-open-log-folder').addEventListener('click', () => {
  window.api.openLogFolder();
});

// --- Hamburger menu ---

menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const isHidden = menuDropdown.hidden;
  menuDropdown.hidden = !isHidden;
  menuBtn.classList.toggle('active', isHidden);
});

document.addEventListener('click', (e) => {
  if (!menuDropdown.hidden && !menuDropdown.contains(e.target) && e.target !== menuBtn) {
    menuDropdown.hidden = true;
    menuBtn.classList.remove('active');
  }
});

// --- Whisper GPU acceleration ---

async function updateGpuStatus() {
  try {
    const status = await window.api.getGpuStatus();
    if (status.backend === 'vulkan') {
      backendDot.className = 'backend-dot backend-dot-gpu';
      backendLabel.textContent = 'GPU acceleration available';
    } else {
      backendDot.className = 'backend-dot backend-dot-cpu';
      backendLabel.textContent = 'Using CPU';
    }
  } catch (_) {
    backendDot.className = 'backend-dot backend-dot-cpu';
    backendLabel.textContent = 'CPU';
  }
}

// --- Init ---
loadModels();
checkPythonSetup();
updateGpuStatus();
window.api.getVersion().then((v) => {
  document.getElementById('version-label').textContent = `v${v}`;
});

// --- Auto-update ---

window.api.onUpdateAvailable((info) => {
  const link = document.getElementById('update-link');
  link.textContent = `Downloading v${info.version}...`;
  link.hidden = false;
});

window.api.onUpdateDownloaded(() => {
  const link = document.getElementById('update-link');
  link.textContent = 'Update ready \u2014 click to restart';
  link.onclick = (e) => {
    e.preventDefault();
    window.api.installUpdate();
  };
});
