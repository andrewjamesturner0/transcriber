const btnSelect = document.getElementById('btn-select');
const btnTranscribe = document.getElementById('btn-transcribe');
const btnSave = document.getElementById('btn-save');
const fileNameEl = document.getElementById('file-name');
const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');

let selectedFile = null;

btnSelect.addEventListener('click', async () => {
  const filePath = await window.api.selectFile();
  if (filePath) {
    selectedFile = filePath;
    fileNameEl.textContent = filePath.split(/[\\/]/).pop();
    btnTranscribe.disabled = false;
    transcriptEl.value = '';
    btnSave.disabled = true;
  }
});

btnTranscribe.addEventListener('click', async () => {
  if (!selectedFile) return;

  btnTranscribe.disabled = true;
  btnSelect.disabled = true;
  btnSave.disabled = true;
  transcriptEl.value = '';
  setStatus('Starting...');

  try {
    const text = await window.api.transcribe(selectedFile);
    transcriptEl.value = text;
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
    const isProgress = msg.startsWith('Converting') || msg.startsWith('Transcribing') || msg.startsWith('Starting');
    statusEl.innerHTML = isProgress ? `<span class="spinner"></span>${msg}` : msg;
  } else {
    statusEl.hidden = true;
    statusEl.textContent = '';
  }
}
