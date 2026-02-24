const btnSelect = document.getElementById('btn-select');
const btnTranscribe = document.getElementById('btn-transcribe');
const btnSave = document.getElementById('btn-save');
const btnCopy = document.getElementById('btn-copy');
const btnDownload = document.getElementById('btn-download');
const modelSelect = document.getElementById('model-select');
const fileNameEl = document.getElementById('file-name');
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

let models = [];

// --- Queue state ---

let queue = []; // { id, filePath, fileName, status: 'pending'|'processing'|'done'|'error', result, error }
let nextQueueId = 0;
let isProcessing = false;

// --- Timer state ---

let timerInterval = null;
let timerStartTime = null;

// --- Time estimates for tooltip ---

const TIME_ESTIMATES = {
  tiny:   { ratio: '6x faster than realtime',    example: '~8 min',   quality: 'Fastest' },
  base:   { ratio: '3x faster than realtime',    example: '~15 min',  quality: 'Fast' },
  small:  { ratio: '1.5x faster than realtime',  example: '~30 min',  quality: 'Balanced' },
  medium: { ratio: '2x slower than realtime',    example: '~90 min',  quality: 'Accurate' },
  large:  { ratio: '3x slower than realtime',    example: '~150 min', quality: 'Most accurate' },
};

const SUPPORTED_EXTENSIONS = new Set(['mp3', 'wav', 'flac', 'm4a', 'ogg', 'webm', 'wma', 'aac']);

// --- Model picker ---

async function loadModels() {
  models = await window.api.getModels();
  const currentValue = modelSelect.value;
  modelSelect.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.downloaded
      ? `${m.label}  (${m.size})`
      : `${m.label}  (${m.size}) — not downloaded`;
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
  const hasPendingFiles = queue.some((i) => i.status === 'pending');
  btnTranscribe.disabled = !m.downloaded || queue.length === 0 || !hasPendingFiles;
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

function getEstimateKey(modelId) {
  for (const key of ['tiny', 'base', 'small', 'medium', 'large']) {
    if (modelId.startsWith(key)) return key;
  }
  return null;
}

function updateEstimateBanner() {
  const selectedModelId = modelSelect.value;
  const currentKey = getEstimateKey(selectedModelId);
  const est = currentKey ? TIME_ESTIMATES[currentKey] : null;
  const label = currentKey ? currentKey.charAt(0).toUpperCase() + currentKey.slice(1) : '';

  if (est) {
    estimateCurrentText.innerHTML = `<span class="estimate-model-name">${label}</span> model: ${est.example} for 45 min of audio &mdash; ${est.ratio}`;
  } else {
    estimateCurrentText.textContent = 'Select a model to see time estimates';
  }

  // Update expanded list
  let html = '';
  for (const [key, e] of Object.entries(TIME_ESTIMATES)) {
    const active = key === currentKey ? ' estimate-active' : '';
    const keyLabel = key.charAt(0).toUpperCase() + key.slice(1);
    html += `<div class="estimate-row${active}"><span>${keyLabel} <span class="estimate-quality">${e.quality}</span></span><span class="estimate-time">${e.example} <span class="estimate-ratio">${e.ratio}</span></span></div>`;
  }
  estimateAllBody.innerHTML = html;
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

function addToQueue(filePaths) {
  for (const filePath of filePaths) {
    const fileName = filePath.split(/[\\/]/).pop();
    queue.push({
      id: nextQueueId++,
      filePath,
      fileName,
      status: 'pending',
      result: null,
      error: null,
    });
  }
  renderQueue();
  onModelChange();
}

function removeFromQueue(id) {
  queue = queue.filter((item) => item.id !== id || item.status !== 'pending');
  if (queue.length === 0) hideTimer();
  renderQueue();
  onModelChange();
}

function clearQueue() {
  if (isProcessing) {
    queue = queue.filter((item) => item.status === 'processing' || item.status === 'done');
  } else {
    queue = [];
    hideTimer();
    outputSection.hidden = true;
    transcriptEl.value = '';
    btnSave.disabled = true;
  }
  renderQueue();
  onModelChange();
}

function renderQueue() {
  if (queue.length === 0) {
    queueListEl.innerHTML = '';
    queueListEl.hidden = true;
    queueSummaryEl.innerHTML = '';
    queueSummaryEl.hidden = true;
    fileNameEl.hidden = true;
    return;
  }

  fileNameEl.hidden = true;
  queueListEl.hidden = false;
  queueListEl.innerHTML = '';

  for (const item of queue) {
    const li = document.createElement('li');
    li.className = `queue-item ${item.status}`;
    li.innerHTML = `
      <span class="queue-item-name" title="${item.filePath}">${item.fileName}</span>
      <span class="queue-item-status ${item.status}">${item.status}</span>
      <button class="queue-item-remove" data-id="${item.id}" title="Remove">&times;</button>
    `;
    queueListEl.appendChild(li);
  }

  const done = queue.filter((i) => i.status === 'done').length;
  const total = queue.length;
  const pending = queue.filter((i) => i.status === 'pending').length;
  queueSummaryEl.hidden = false;
  queueSummaryEl.innerHTML = `
    <span>${done} of ${total} completed${pending > 0 ? ` \u00b7 ${pending} remaining` : ''}</span>
    <button class="btn-clear-queue">${isProcessing ? 'Clear pending' : 'Clear all'}</button>
  `;
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

function isValidAudioFile(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

function handleDroppedFiles(files) {
  const validFiles = Array.from(files).filter((f) => isValidAudioFile(f.name));
  if (validFiles.length === 0) {
    setStatus('No supported audio files. Supported: MP3, WAV, FLAC, M4A, OGG, WebM, WMA, AAC', 'error');
    setTimeout(() => setStatus(''), 4000);
    return;
  }
  addToQueue(validFiles.map((f) => window.api.getPathForFile(f)));
}

btnSelect.addEventListener('dragenter', (e) => {
  e.preventDefault();
  e.stopPropagation();
  btnSelect.classList.add('drag-over');
});

btnSelect.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  btnSelect.classList.add('drag-over');
});

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
  const pendingItems = queue.filter((i) => i.status === 'pending');
  if (pendingItems.length === 0) return;

  isProcessing = true;
  btnTranscribe.disabled = true;
  btnSelect.disabled = true;
  btnSave.disabled = true;
  transcriptEl.value = '';
  outputSection.hidden = true;
  startTimer();

  const allResults = [];

  for (const item of pendingItems) {
    item.status = 'processing';
    renderQueue();
    setStatus(`Transcribing ${item.fileName}...`, 'progress');

    try {
      const text = await window.api.transcribe(item.filePath, modelSelect.value);
      item.status = 'done';
      item.result = text;
      allResults.push({ fileName: item.fileName, text: formatDiarizedOutput(text) });
    } catch (err) {
      item.status = 'error';
      item.error = err.message;
      allResults.push({ fileName: item.fileName, text: `[Error: ${err.message}]` });
    }
    renderQueue();
  }

  stopTimer();
  isProcessing = false;

  if (allResults.length === 1) {
    transcriptEl.value = allResults[0].text;
  } else {
    transcriptEl.value = allResults
      .map((r) => `=== ${r.fileName} ===\n\n${r.text}`)
      .join('\n\n\n');
  }

  // Show diarization info if speaker turns were detected
  const allRawText = queue.filter((i) => i.result).map((i) => i.result).join('');
  const turnCount = (allRawText.match(/\[SPEAKER_TURN\]/g) || []).length;
  if (turnCount > 0) {
    diarizeInfoEl.textContent = `${turnCount} speaker change${turnCount !== 1 ? 's' : ''} detected \u2014 speaker detection is experimental and may be inaccurate`;
    diarizeInfoEl.hidden = false;
  } else {
    diarizeInfoEl.hidden = true;
  }

  outputSection.hidden = false;
  btnSave.disabled = false;
  setStatus('');
  btnTranscribe.disabled = false;
  btnSelect.disabled = false;
  onModelChange();
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
    const orig = btnCopy.innerHTML;
    btnCopy.innerHTML = `<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Copied`;
    setTimeout(() => { btnCopy.innerHTML = orig; }, 2000);
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

    const isProgress = type === 'progress';
    statusEl.innerHTML = isProgress ? `<span class="spinner"></span>${msg}` : msg;
  } else {
    statusEl.hidden = true;
    statusEl.textContent = '';
  }
}

// --- Diarization formatting ---

function formatDiarizedOutput(text) {
  if (!text.includes('[SPEAKER_TURN]')) {
    return text;
  }
  // Strip whisper timestamp lines like "[00:00:00.000 --> 00:05:00.000]  "
  text = text.replace(/\[\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\]\s*/g, '');

  return text
    .split('[SPEAKER_TURN]')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n--- Speaker Change ---\n\n');
}

// --- License modal ---

const btnLicenses = document.getElementById('btn-licenses');
const licenseOverlay = document.getElementById('license-overlay');
const btnCloseLicenses = document.getElementById('btn-close-licenses');
const licenseModalBody = document.getElementById('license-modal-body');

let cachedLicenses = null;

function getBadgeClass(license) {
  return license.toLowerCase().includes('lgpl') ? 'license-badge-lgpl' : 'license-badge-mit';
}

function buildLicenseHTML(licenses) {
  return licenses.map((lic, i) => `
    <div class="license-section">
      <div class="license-section-header">
        <span class="license-name">${lic.name}</span>
        <span class="license-badge ${getBadgeClass(lic.license)}">${lic.license}</span>
      </div>
      <div class="license-description">${lic.description}</div>
      <div class="license-url">${lic.url.replace('https://', '')}</div>
      <button class="license-toggle" data-index="${i}" type="button">
        <svg viewBox="0 0 16 16" fill="none" width="10" height="10">
          <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        View license text
      </button>
      <div class="license-full-text" id="license-text-${i}" hidden>${lic.text}</div>
    </div>
  `).join('');
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
  licenseModalBody.innerHTML = buildLicenseHTML(cachedLicenses);
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
  if (e.key === 'Escape' && !licenseOverlay.hidden) closeLicenseModal();
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

// --- Init ---
loadModels();
