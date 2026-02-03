const btnSelect = document.getElementById('btn-select');
const btnTranscribe = document.getElementById('btn-transcribe');
const btnSave = document.getElementById('btn-save');
const btnDownload = document.getElementById('btn-download');
const modelSelect = document.getElementById('model-select');
const fileNameEl = document.getElementById('file-name');
const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');

let selectedFile = null;
let models = [];

// --- Model picker ---

async function loadModels() {
  models = await window.api.getModels();
  const currentValue = modelSelect.value;
  modelSelect.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.downloaded
      ? `${m.label} (${m.size})`
      : `${m.label} (${m.size}) — not downloaded`;
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
  btnTranscribe.disabled = !m.downloaded || !selectedFile;
}

modelSelect.addEventListener('change', onModelChange);

btnDownload.addEventListener('click', async () => {
  const modelId = modelSelect.value;
  btnDownload.disabled = true;
  setStatus('Starting download...');
  try {
    await window.api.downloadModel(modelId);
    await loadModels();
    setStatus('Download complete!');
  } catch (err) {
    setStatus('Download error: ' + err.message);
  } finally {
    btnDownload.disabled = false;
  }
});

window.api.onDownloadProgress((data) => {
  setStatus(`Downloading model... ${data.percent}%`);
});

// --- File selection ---

btnSelect.addEventListener('click', async () => {
  const filePath = await window.api.selectFile();
  if (filePath) {
    selectedFile = filePath;
    fileNameEl.textContent = filePath.split(/[\\/]/).pop();
    transcriptEl.value = '';
    btnSave.disabled = true;
    onModelChange();
  }
});

// --- Transcription ---

btnTranscribe.addEventListener('click', async () => {
  if (!selectedFile) return;

  btnTranscribe.disabled = true;
  btnSelect.disabled = true;
  btnSave.disabled = true;
  transcriptEl.value = '';
  setStatus('Starting...');

  try {
    const text = await window.api.transcribe(selectedFile, modelSelect.value);
    transcriptEl.value = formatDiarizedOutput(text);
    btnSave.disabled = false;
    setStatus('');
  } catch (err) {
    setStatus('Error: ' + err.message);
  } finally {
    btnTranscribe.disabled = false;
    btnSelect.disabled = false;
  }
});

btnSave.addEventListener('click', async () => {
  const text = transcriptEl.value;
  if (!text) return;
  const saved = await window.api.saveTranscript(text);
  if (saved) setStatus('Saved!');
});

window.api.onStatus((msg) => setStatus(msg));

function setStatus(msg) {
  if (msg) {
    statusEl.hidden = false;
    const isProgress = msg.startsWith('Converting') || msg.startsWith('Transcribing')
      || msg.startsWith('Starting') || msg.startsWith('Downloading');
    statusEl.innerHTML = isProgress ? `<span class="spinner"></span>${msg}` : msg;
  } else {
    statusEl.hidden = true;
    statusEl.textContent = '';
  }
}

// --- Diarization formatting ---

function formatDiarizedOutput(text) {
  // Check if diarization markers are present
  if (!text.includes('[SPEAKER_TURN]')) {
    return text;
  }

  // Replace [SPEAKER_TURN] markers with visual separators
  // The marker indicates a speaker change, not a specific speaker identity
  return text
    .split('[SPEAKER_TURN]')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n--- Speaker Change ---\n\n');
}

// --- Init ---
loadModels();
