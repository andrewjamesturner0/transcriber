// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

const btnSelect = document.getElementById('btn-select');
const btnTranscribe = document.getElementById('btn-transcribe');
const btnSave = document.getElementById('btn-save');
const btnCopy = document.getElementById('btn-copy');
const btnDownload = document.getElementById('btn-download');
const modelSummaryTitle = document.getElementById('model-summary-title');
const modelSummaryDescription = document.getElementById('model-summary-description');
const modelSummaryStatus = document.getElementById('model-summary-status');
const modelSelectionStatus = document.getElementById('model-selection-status');
const btnModelDetails = document.getElementById('btn-model-details');
const btnModelChange = document.getElementById('btn-model-change');
const modelDialogOverlay = document.getElementById('model-dialog-overlay');
const modelDialog = document.getElementById('model-dialog');
const modelDialogTitle = document.getElementById('model-dialog-title');
const modelDialogIntro = document.getElementById('model-dialog-intro');
const modelDialogBack = document.getElementById('model-dialog-back');
const modelDialogClose = document.getElementById('model-dialog-close');
const modelDialogBody = document.getElementById('model-dialog-body');
const jobOptionsSummary = document.getElementById('job-options-summary');
const btnConfigureOptions = document.getElementById('btn-configure-options');
const jobOptionsControls = document.getElementById('job-options-controls');
const jobModeSelect = document.getElementById('job-mode-select');
const sourceLanguageSelect = document.getElementById('source-language-select');
const targetLanguageField = document.getElementById('target-language-field');
const targetLanguageSelect = document.getElementById('target-language-select');
const speakerLabelsToggle = document.getElementById('speaker-labels-toggle');
const btnAdvancedOptions = document.getElementById('btn-advanced-options');
const advancedOptions = document.getElementById('advanced-options');
const expectedSpeakersSelect = document.getElementById('expected-speakers-select');
const reduceRepeatedTextToggle = document.getElementById('reduce-repeated-text-toggle');
const jobOptionsStatus = document.getElementById('job-options-status');

const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const outputSection = document.getElementById('output-section');
const diarizeInfoEl = document.getElementById('diarize-info');
const elapsedTimerEl = document.getElementById('elapsed-timer');
const elapsedTimeEl = document.getElementById('elapsed-time');
const queueListEl = document.getElementById('queue-list');
const queueSummaryEl = document.getElementById('queue-summary');
const menuBtn = document.getElementById('menu-btn');
const menuDropdown = document.getElementById('menu-dropdown');
const processingDeviceSelect = document.getElementById('processing-device-select');
const processingDeviceNote = document.getElementById('processing-device-note');
const diarizeStatusText = document.getElementById('diarize-status-text');
const diarizeStatusDot = document.querySelector('#diarize-setup-status .menu-status-dot');
const hfTokenInput = document.getElementById('hf-token-input');
const gpuStatus = document.getElementById('gpu-status');
const gpuStatusDot = document.getElementById('gpu-status-dot');
const gpuStatusText = document.getElementById('gpu-status-text');
const btnCheckPython = document.getElementById('btn-check-python');
const btnCancel = document.getElementById('btn-cancel');

let models = [];
let pythonSetup = null;
let hfTokenConfigured = false;
let selectedModelId = 'small';
let selectedTaskId = 'general-purpose';
let modelDialogView = 'suggested';
let modelDetailsReturnView = 'suggested';
let modelDialogRestoreFocus = null;
let jobOptionsState = window.JobOptions.createJobOptionsState();
let jobOptionsView = null;
let jobOptionsRenderRevision = 0;
let jobOptionsRenderPending = false;
let transcriptionRunning = false;

// --- Queue state ---

const queue = createQueue();
let cancelController = null;

// --- Timer state ---

let timerInterval = null;
let timerStartTime = null;

// --- Model picker ---

async function loadModels() {
  models = await window.api.getModels();
  if (!models.some((model) => model.id === selectedModelId)) {
    selectedModelId = models[0]?.id || '';
    selectedTaskId = window.modelChooser.defaultTaskId(selectedModel()) || null;
  } else if (!window.modelChooser.TASKS.some((task) =>
    task.id === selectedTaskId && task.modelId === selectedModelId)) {
    selectedTaskId = window.modelChooser.defaultTaskId(selectedModel()) || null;
  }
  await onModelChange();
}

function selectedModel() {
  return models.find((model) => model.id === selectedModelId);
}

async function onModelChange() {
  const m = selectedModel();
  if (!m) return;
  const task = window.modelChooser.TASKS.find((entry) =>
    entry.id === selectedTaskId && entry.modelId === m.id);
  modelSummaryTitle.textContent = `${task ? task.label : 'Model'} - ${m.displayName}`;
  modelSummaryDescription.textContent = m.practicalDescription;
  const materialStatus = !m.runtimeAvailable
    ? 'Unavailable in this release.'
    : (m.status === 'experimental' && m.knownIssues?.length ? m.knownIssues[0] : '');
  modelSummaryStatus.textContent = materialStatus;
  modelSummaryStatus.hidden = !materialStatus;
  btnDownload.hidden = m.downloaded || !m.runtimeAvailable;
  const gatedAccessMissing = m.gated && !hfTokenConfigured;
  btnDownload.textContent = gatedAccessMissing
    ? 'Set up Hugging Face access in Settings'
    : `Download ${m.size}`;
  btnDownload.disabled = transcriptionRunning || gatedAccessMissing;
  refreshTranscribeAvailability();
  await renderJobOptions();
  refreshTranscribeAvailability();
}

function refreshTranscribeAvailability() {
  const model = selectedModel();
  const summary = queue.getSummary();
  const speakerSetupMissing = model?.pyannoteValidated && jobOptionsView?.effective.speakerLabels
    && !pythonSetup?.pyannoteInstalled;
  const accessMissing = model?.gated && !hfTokenConfigured;
  const optionsUnavailable = jobOptionsRenderPending || !jobOptionsView?.valid
    || jobOptionsView?.modelId !== model?.id;
  btnTranscribe.disabled = transcriptionRunning || !model || !model.runtimeAvailable || !model.downloaded
    || summary.pending === 0 || optionsUnavailable || speakerSetupMissing || accessMissing;
}

function setRunControlsDisabled(running) {
  transcriptionRunning = running;
  btnModelChange.disabled = running;
  btnConfigureOptions.disabled = running;
  btnSelect.disabled = running;
  if (running) {
    btnDownload.disabled = true;
    btnAdvancedOptions.disabled = true;
    for (const control of [
      jobModeSelect,
      sourceLanguageSelect,
      targetLanguageSelect,
      speakerLabelsToggle,
      expectedSpeakersSelect,
      reduceRepeatedTextToggle,
    ]) control.disabled = true;
  } else {
    onModelChange();
  }
  refreshTranscribeAvailability();
}

function setReason(field, text) {
  const reason = document.getElementById(`${field}-reason`);
  reason.textContent = text || '';
  reason.hidden = !text;
  const toggleFields = new Set(['speaker-labels', 'reduce-repeated-text']);
  const control = document.getElementById(`${field}-${toggleFields.has(field) ? 'toggle' : 'select'}`);
  if (control) {
    if (text) control.setAttribute('aria-describedby', reason.id);
    else control.removeAttribute('aria-describedby');
  }
}

function replaceSelectChoices(select, choices, value) {
  while (select.firstChild) select.removeChild(select.firstChild);
  if (value == null) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a target language';
    placeholder.disabled = true;
    placeholder.selected = true;
    select.appendChild(placeholder);
  }
  for (const choice of choices) {
    const option = document.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    option.disabled = choice.enabled === false;
    select.appendChild(option);
  }
  if (value != null) select.value = value;
}

async function renderJobOptions() {
  const model = selectedModel();
  if (!model) return;
  const revision = ++jobOptionsRenderRevision;
  jobOptionsRenderPending = true;
  refreshTranscribeAvailability();
  let view;
  try {
    view = await window.api.deriveJobOptions({ modelId: model.id, state: jobOptionsState });
  } catch (error) {
    if (revision === jobOptionsRenderRevision) {
      jobOptionsRenderPending = false;
      refreshTranscribeAvailability();
    }
    throw error;
  }
  if (revision !== jobOptionsRenderRevision || selectedModelId !== model.id) return;
  jobOptionsView = view;
  jobOptionsRenderPending = false;
  const controls = jobOptionsView.controls;
  jobOptionsSummary.textContent = jobOptionsView.summary;
  jobOptionsControls.hidden = !jobOptionsView.optionsOpen;
  btnConfigureOptions.textContent = jobOptionsView.optionsOpen ? 'Done' : 'Configure';
  btnConfigureOptions.setAttribute('aria-expanded', String(jobOptionsView.optionsOpen));

  jobModeSelect.value = controls.jobMode.value;
  jobModeSelect.disabled = transcriptionRunning || !controls.jobMode.enabled;
  for (const option of jobModeSelect.options) {
    const choice = controls.jobMode.choices.find((entry) => entry.value === option.value);
    option.disabled = choice?.enabled === false;
  }
  setReason('job-mode', controls.jobMode.reason);

  replaceSelectChoices(sourceLanguageSelect, controls.sourceLanguage.choices, controls.sourceLanguage.value);
  sourceLanguageSelect.disabled = transcriptionRunning || !controls.sourceLanguage.enabled;
  setReason('source-language', controls.sourceLanguage.reason);

  targetLanguageField.hidden = !controls.targetLanguage.visible;
  replaceSelectChoices(targetLanguageSelect, controls.targetLanguage.choices, controls.targetLanguage.value);
  targetLanguageSelect.disabled = transcriptionRunning || !controls.targetLanguage.enabled;
  setReason('target-language', controls.targetLanguage.reason);

  let speakerReason = controls.speakerLabels.reason;
  let speakerEnabled = controls.speakerLabels.enabled;
  if (model.pyannoteValidated && !pythonSetup?.pyannoteInstalled) {
    speakerEnabled = false;
    speakerReason = 'Complete pyannote setup in Settings to use speaker labels with this model.';
  }
  speakerLabelsToggle.checked = controls.speakerLabels.value;
  speakerLabelsToggle.disabled = transcriptionRunning || !speakerEnabled;
  setReason('speaker-labels', speakerReason);

  advancedOptions.hidden = !jobOptionsView.advancedOpen;
  btnAdvancedOptions.setAttribute('aria-expanded', String(jobOptionsView.advancedOpen));
  btnAdvancedOptions.disabled = transcriptionRunning;
  expectedSpeakersSelect.value = controls.expectedSpeakers.value || '';
  expectedSpeakersSelect.disabled = transcriptionRunning
    || !controls.expectedSpeakers.enabled || !speakerEnabled;
  setReason('expected-speakers', controls.expectedSpeakers.reason || (!speakerEnabled ? speakerReason : null));

  reduceRepeatedTextToggle.checked = controls.reduceRepeatedText.value;
  reduceRepeatedTextToggle.disabled = transcriptionRunning || !controls.reduceRepeatedText.enabled;
  setReason('reduce-repeated-text', controls.reduceRepeatedText.reason || controls.reduceRepeatedText.help);
  refreshTranscribeAvailability();
}

async function updateJobOption(field, value) {
  jobOptionsState = window.JobOptions.updateJobOption(jobOptionsState, field, value);
  refreshTranscribeAvailability();
  await renderJobOptions();
  refreshTranscribeAvailability();
  if (jobOptionsView) jobOptionsStatus.textContent = `${field} updated. ${jobOptionsView.summary}`;
}

btnConfigureOptions.addEventListener('click', async () => {
  jobOptionsState = window.JobOptions.setOptionsOpen(jobOptionsState, !jobOptionsState.optionsOpen);
  await renderJobOptions();
});

btnAdvancedOptions.addEventListener('click', async () => {
  jobOptionsState = window.JobOptions.setAdvancedOpen(jobOptionsState, !jobOptionsState.advancedOpen);
  await renderJobOptions();
});

jobModeSelect.addEventListener('change', () => updateJobOption('jobMode', jobModeSelect.value));
sourceLanguageSelect.addEventListener('change', () => updateJobOption('sourceLanguage', sourceLanguageSelect.value));
targetLanguageSelect.addEventListener('change', () => updateJobOption('targetLanguage', targetLanguageSelect.value || null));
speakerLabelsToggle.addEventListener('change', () => updateJobOption('speakerLabels', speakerLabelsToggle.checked));
expectedSpeakersSelect.addEventListener('change', () => updateJobOption(
  'expectedSpeakers', expectedSpeakersSelect.value ? Number(expectedSpeakersSelect.value) : null,
));
reduceRepeatedTextToggle.addEventListener('change', () => updateJobOption('reduceRepeatedText', reduceRepeatedTextToggle.checked));

function clearModelDialogBody() {
  while (modelDialogBody.firstChild) modelDialogBody.removeChild(modelDialogBody.firstChild);
}

function focusModelDialogControl(control) {
  if (!modelDialogOverlay.hidden && control && !control.disabled && typeof control.focus === 'function') {
    control.focus();
  }
}

function modelRow(model, heading, description, onChoose, options = {}) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'model-choice-row';
  const isCurrent = options.taskId
    ? options.taskId === selectedTaskId
    : model.id === selectedModelId;
  if (isCurrent) row.setAttribute('aria-current', 'true');

  const copy = document.createElement('span');
  copy.className = 'model-choice-copy';
  const title = document.createElement('strong');
  title.textContent = heading;
  const detail = document.createElement('span');
  detail.textContent = description;
  copy.appendChild(title);
  copy.appendChild(detail);

  const meta = document.createElement('span');
  meta.className = 'model-choice-meta';
  const parts = [];
  if (options.showLanguage) parts.push((model.languages || []).join(', '));
  parts.push(model.size);
  if (model.status === 'experimental') parts.push('Experimental');
  if (!model.runtimeAvailable) parts.push('Unavailable');
  meta.textContent = parts.join(' - ');

  row.appendChild(copy);
  row.appendChild(meta);
  row.addEventListener('click', onChoose);
  return row;
}

function chooseModel(model, taskId = window.modelChooser.defaultTaskId(model)) {
  if (!model.runtimeAvailable || (model.gated && !hfTokenConfigured)) return;
  selectedModelId = model.id;
  const task = window.modelChooser.TASKS.find((entry) =>
    entry.id === taskId && entry.modelId === model.id);
  selectedTaskId = task?.id || window.modelChooser.defaultTaskId(model) || null;
  const roleLabel = selectedTaskId ? window.modelChooser.taskLabel(selectedTaskId) : null;
  modelSelectionStatus.textContent = roleLabel
    ? `${roleLabel} - ${model.displayName} selected.`
    : `${model.displayName} selected.`;
  closeModelDialog();
  onModelChange();
}

function renderSuggestedModels() {
  modelDialogView = 'suggested';
  modelDialogTitle.textContent = 'What matters for this job?';
  modelDialogIntro.textContent = 'Choose a model for this job. You can change it later.';
  modelDialogBack.hidden = true;
  clearModelDialogBody();

  const list = document.createElement('div');
  list.className = 'model-choice-list';
  let firstChoice = null;
  for (const { task, model } of window.modelChooser.suggestions(models)) {
    const row = modelRow(
      model,
      `${task.label} - ${model.displayName}`,
      model.practicalDescription,
      () => chooseModel(model, task.id),
      { taskId: task.id },
    );
    if (!firstChoice) firstChoice = row;
    list.appendChild(row);
  }
  modelDialogBody.appendChild(list);

  const showAll = document.createElement('button');
  showAll.type = 'button';
  showAll.className = 'text-button show-all-models';
  showAll.textContent = `Show all ${models.length} models`;
  showAll.addEventListener('click', renderAllModels);
  modelDialogBody.appendChild(showAll);
  focusModelDialogControl(firstChoice || showAll);
}

function renderAllModels() {
  modelDialogView = 'all';
  modelDialogTitle.textContent = 'All models';
  modelDialogIntro.textContent = 'Open a model to check its limits and terms.';
  modelDialogBack.hidden = false;
  clearModelDialogBody();

  const label = document.createElement('label');
  label.className = 'model-search-label';
  label.htmlFor = 'model-search';
  label.textContent = 'Search models';
  const search = document.createElement('input');
  search.id = 'model-search';
  search.className = 'model-search';
  search.type = 'search';
  search.placeholder = 'Name, language or use';
  const list = document.createElement('div');
  list.className = 'model-choice-list model-all-list';

  function draw(query = '') {
    while (list.firstChild) list.removeChild(list.firstChild);
    const entries = window.modelChooser.filterModels(window.modelChooser.orderedModels(models), query);
    for (const model of entries) {
      list.appendChild(modelRow(
        model,
        model.displayName,
        model.practicalDescription,
        () => renderModelDetails(model, 'all'),
        { showLanguage: true },
      ));
    }
    if (entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'model-list-empty';
      empty.textContent = 'No models match that search.';
      list.appendChild(empty);
    }
  }
  search.addEventListener('input', () => draw(search.value));
  modelDialogBody.appendChild(label);
  modelDialogBody.appendChild(search);
  modelDialogBody.appendChild(list);
  draw();
  focusModelDialogControl(search);
}

function detailRow(term, value, link) {
  const termEl = document.createElement('dt');
  termEl.textContent = term;
  const valueEl = document.createElement('dd');
  if (link) {
    const anchor = document.createElement('a');
    anchor.href = '#';
    anchor.textContent = value;
    if (term === 'Access') anchor.className = 'model-access-link';
    anchor.addEventListener('click', (event) => {
      event.preventDefault();
      window.api.openExternal(link);
    });
    valueEl.appendChild(anchor);
  } else {
    valueEl.textContent = value;
  }
  return [termEl, valueEl];
}

function renderModelDetails(model, returnView = modelDialogView) {
  modelDialogView = 'details';
  modelDetailsReturnView = returnView;
  modelDialogTitle.textContent = model.displayName;
  modelDialogIntro.textContent = model.practicalDescription;
  modelDialogBack.hidden = false;
  clearModelDialogBody();

  const details = document.createElement('dl');
  details.className = 'model-details-list';
  const languageMode = {
    fixed: 'fixed language',
    'select-or-auto': 'choose or detect automatically',
    'auto-only': 'automatic detection only',
    required: 'a language choice is required',
  }[model.languageSelection] || model.languageSelection;
  const rows = [
    ['Best for', model.practicalDescription],
    ['Download size', model.size],
    ['Languages', `${(model.languages || []).join(', ')} - ${languageMode}`],
    ['Timing', model.timestampLevel === 'none' ? 'No timing output' : `${model.timestampLevel} timing`],
    ['Expected memory', model.memoryGuidance],
    ['Engine', model.engine],
    ['Licence', model.licence, model.licenceUrl],
    ['Source', model.attribution, model.sourceUrl],
  ];
  if (model.gated) {
    rows.push(['Access', 'Accept access terms on Hugging Face', model.accessUrl]);
  }
  for (const [term, value, link] of rows) {
    for (const node of detailRow(term, value, link)) details.appendChild(node);
  }
  modelDialogBody.appendChild(details);

  if (model.knownIssues?.length) {
    const warning = document.createElement('p');
    warning.className = 'model-details-warning';
    warning.textContent = model.knownIssues.join(' ');
    modelDialogBody.appendChild(warning);
  }

  const gatedAccessMissing = model.gated && !hfTokenConfigured;
  if (gatedAccessMissing) {
    const requirement = document.createElement('p');
    requirement.className = 'model-details-warning';
    requirement.textContent = 'Accept the model access terms and save a Hugging Face token in Settings before choosing or downloading MedASR.';
    modelDialogBody.appendChild(requirement);
  }

  const choose = document.createElement('button');
  choose.type = 'button';
  choose.className = 'btn btn-primary model-details-choose';
  choose.disabled = !model.runtimeAvailable || gatedAccessMissing;
  choose.textContent = !model.runtimeAvailable
    ? 'Unavailable in this release'
    : gatedAccessMissing ? 'Set up Hugging Face access in Settings' : 'Choose this model';
  const detailsTaskId = returnView === 'all'
    ? window.modelChooser.defaultTaskId(model)
    : (model.id === selectedModelId ? selectedTaskId : window.modelChooser.defaultTaskId(model));
  choose.addEventListener('click', () => chooseModel(model, detailsTaskId));
  modelDialogBody.appendChild(choose);
  const accessLink = modelDialogBody.querySelector('.model-access-link');
  focusModelDialogControl(choose.disabled ? (accessLink || modelDialogBack) : choose);
}

function openModelDialog(view, trigger) {
  modelDialogRestoreFocus = trigger || document.activeElement;
  modelDialogOverlay.hidden = false;
  if (view === 'details') renderModelDetails(selectedModel(), 'suggested');
  else renderSuggestedModels();
}

function closeModelDialog() {
  if (modelDialogOverlay.hidden) return;
  modelDialogOverlay.hidden = true;
  const restore = modelDialogRestoreFocus;
  modelDialogRestoreFocus = null;
  if (restore?.focus) restore.focus();
}

btnModelChange.addEventListener('click', () => openModelDialog('suggested', btnModelChange));
btnModelDetails.addEventListener('click', () => openModelDialog('details', btnModelDetails));
modelDialogClose.addEventListener('click', closeModelDialog);
modelDialogBack.addEventListener('click', () => {
  if (modelDialogView === 'details' && modelDetailsReturnView === 'all') renderAllModels();
  else renderSuggestedModels();
});
modelDialogOverlay.addEventListener('click', (event) => {
  if (event.target === modelDialogOverlay) closeModelDialog();
});
modelDialog.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeModelDialog();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...modelDialog.querySelectorAll('button:not([hidden]):not([disabled]), input:not([disabled]), a[href]')];
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!modelDialog.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

btnDownload.addEventListener('click', async () => {
  const model = selectedModel();
  if (!model || (model.gated && !hfTokenConfigured)) return;
  const modelId = selectedModelId;
  btnDownload.disabled = true;
  setStatus('Starting download...', 'progress');
  try {
    await window.api.downloadModel({ modelId });
    await loadModels();
    setStatus('Download complete!', 'success');
    setTimeout(() => setStatus(''), 3000);
  } catch (err) {
    setStatus('Download error: ' + err.message, 'error');
  } finally {
    const currentModel = selectedModel();
    btnDownload.disabled = transcriptionRunning || (currentModel?.gated && !hfTokenConfigured);
  }
});

window.api.onDownloadProgress((data) => {
  setStatus(`Downloading model... ${data.percent}%`, 'progress');
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

function clearElement(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
}

function syncQueueUI() {
  const items = queue.getItems();
  const s = queue.getSummary();

  if (items.length === 0) {
    clearElement(queueListEl);
    queueListEl.hidden = true;
    clearElement(queueSummaryEl);
    queueSummaryEl.hidden = true;
    return;
  }

  queueListEl.hidden = false;
  clearElement(queueListEl);

  for (const item of items) {
    const li = document.createElement('li');
    const safeStatus = ['pending', 'processing', 'done', 'error'].includes(item.status) ? item.status : 'error';
    li.className = `queue-item ${safeStatus}`;

    const name = document.createElement('span');
    name.className = 'queue-item-name';
    name.title = item.filePath;
    name.textContent = item.fileName;

    const itemStatus = document.createElement('span');
    itemStatus.className = `queue-item-status ${safeStatus}`;
    itemStatus.textContent = item.error || item.status;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'queue-item-remove';
    remove.dataset.id = String(item.id);
    remove.title = 'Remove';
    remove.textContent = 'x';

    li.appendChild(name);
    li.appendChild(itemStatus);
    li.appendChild(remove);
    queueListEl.appendChild(li);
  }

  const isProcessing = queue.getActiveItem() !== null;
  queueSummaryEl.hidden = false;
  clearElement(queueSummaryEl);
  const summary = document.createElement('span');
  summary.textContent = `${s.done} of ${s.total} completed${s.pending > 0 ? ` - ${s.pending} remaining` : ''}`;
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'btn-clear-queue';
  clear.textContent = isProcessing ? 'Clear pending' : 'Clear all';
  queueSummaryEl.appendChild(summary);
  queueSummaryEl.appendChild(clear);
}

function addToQueue(fileRefs) {
  const files = fileRefs.map((file) => ({ filePath: file.id, fileName: file.name }));
  queue.enqueue(files);
  syncQueueUI();
  onModelChange();
}

function removeFromQueue(id) {
  queue.remove(id);
  if (queue.getItems().length === 0) hideTimer();
  syncQueueUI();
  onModelChange();
}

function clearQueue() {
  const isProcessing = queue.getActiveItem() !== null;
  queue.clear();
  if (!isProcessing) {
    hideTimer();
    outputSection.hidden = true;
    transcriptEl.value = '';
    transcriptEl.hidden = false;
    const richEl = document.getElementById('transcript-rich');
    if (richEl) richEl.remove();
    btnSave.disabled = true;
    btnCopy.disabled = true;
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

async function handleDroppedFiles(files) {
  const validFiles = Array.from(files).filter((f) => window.mediaExtensions.isValidMediaFile(f.name));
  if (validFiles.length === 0) {
    setStatus('No supported media files. Supported: MP3, WAV, FLAC, M4A, OGG, WebM, WMA, AAC, MP4, MOV, AVI, MKV', 'error');
    setTimeout(() => setStatus(''), 4000);
    return;
  }
  const fileRefs = await window.api.registerDroppedFiles(validFiles);
  addToQueue(fileRefs);
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

function prepareTranscriptionRun() {
  setRunControlsDisabled(true);
  btnCancel.hidden = false;
  btnSave.disabled = true;
  btnCopy.disabled = true;
  transcriptEl.value = '';
  transcriptEl.hidden = false;
  const existingRich = document.getElementById('transcript-rich');
  if (existingRich) existingRich.remove();
  outputSection.hidden = true;
  startTimer();
}

async function transcribeQueueItem(item, runModelId, runOptions) {
  setStatus(`Transcribing ${item.fileName}...`, 'progress');
  const result = await window.api.transcribe({
    fileId: item.filePath,
    modelId: runModelId,
    options: runOptions,
  });
  const text = result.text;
  item.hasSpeakers = window.transcriptFormat.isPyannoteDiarized(text);
  return text;
}

function collectRunOutput(runResults) {
  // Only this run can contribute output. Successful items are consumed once;
  // current failures remain in the queue with their messages.
  const completedItems = queue.finishRun(runResults);
  const doneItems = completedItems.filter((item) => item.status === 'done' && typeof item.result === 'string' && item.result.trim());
  const outputItems = doneItems.map((item) => ({
    rawText: item.result,
    result: {
      fileName: item.fileName,
      text: window.transcriptFormat.formatDiarizedOutput(item.result),
      hasSpeakers: item.hasSpeakers || false,
    },
  })).filter((item) => typeof item.result.text === 'string' && item.result.text.trim());
  return {
    results: outputItems.map((item) => item.result),
    rawText: outputItems.map((item) => item.rawText).join(''),
  };
}

function renderPlainRunOutput(results, rawText) {
  transcriptEl.value = results.length === 1
    ? results[0].text
    : results.map((result) => `=== ${result.fileName} ===\n\n${result.text}`).join('\n\n\n');

  const turnCount = window.transcriptFormat.countWhisperSpeakerTurns(rawText);
  if (turnCount > 0) {
    diarizeInfoEl.textContent = `${turnCount} speaker change${turnCount !== 1 ? 's' : ''} detected - speaker detection is experimental and may be inaccurate`;
    diarizeInfoEl.className = 'diarize-info';
    diarizeInfoEl.hidden = false;
  } else {
    diarizeInfoEl.hidden = true;
  }
}

function renderRunOutput(results, rawText) {
  const hasOutput = results.length > 0;
  if (results.some((result) => result.hasSpeakers)) {
    displayRichTranscript(results);
    const { count, labels } = window.transcriptFormat.countPyannoteSpeakers(rawText);
    renderDiarizeSpeakerInfo(count, labels);
  } else if (hasOutput) {
    renderPlainRunOutput(results, rawText);
  } else {
    transcriptEl.value = '';
    transcriptEl.hidden = false;
    diarizeInfoEl.hidden = true;
  }

  outputSection.hidden = !hasOutput;
  btnSave.disabled = !hasOutput;
  btnCopy.disabled = !hasOutput;
  setStatus('');
}

btnTranscribe.addEventListener('click', async () => {
  if (transcriptionRunning || queue.getSummary().pending === 0 || jobOptionsRenderPending
    || !jobOptionsView || jobOptionsView.modelId !== selectedModelId || !jobOptionsView.valid) return;

  const runModelId = selectedModelId;
  const runOptions = Object.freeze({ ...jobOptionsView.effective });

  prepareTranscriptionRun();

  const controller = new AbortController();
  cancelController = controller;

  try {
    const runResults = await queue.processAll(
      (item) => transcribeQueueItem(item, runModelId, runOptions),
      {
        signal: controller.signal,
        onChange: () => syncQueueUI(),
      },
    );
    const output = collectRunOutput(runResults);
    syncQueueUI();
    renderRunOutput(output.results, output.rawText);
  } finally {
    stopTimer();
    cancelController = null;
    btnCancel.hidden = true;
    setRunControlsDisabled(false);
  }
});

function renderDiarizeSpeakerInfo(count, labels) {
  clearElement(diarizeInfoEl);
  for (let index = 0; index < labels.length; index += 1) {
    const dot = document.createElement('span');
    dot.className = `diarize-info-dot speaker-${Math.min(index + 1, 8)}-bg`;
    diarizeInfoEl.appendChild(dot);
  }
  const summary = document.createElement('span');
  summary.textContent = `${count} speaker${count !== 1 ? 's' : ''} detected`;
  diarizeInfoEl.appendChild(summary);
  diarizeInfoEl.className = 'diarize-info diarize-info-speakers';
  diarizeInfoEl.hidden = false;
}

// --- Cancel ---

btnCancel.addEventListener('click', async () => {
  btnCancel.disabled = true;
  setStatus('Cancelling...', 'progress');
  try {
    await window.api.cancelTranscription();
  } catch (_) {}
  if (cancelController) cancelController.abort();
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
    clearElement(statusEl);
    if (isProgress) {
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      statusEl.appendChild(spinner);
      const message = document.createElement('span');
      message.textContent = msg;
      statusEl.appendChild(message);
    } else {
      statusEl.textContent = msg;
    }
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
      const heading = document.createElement('strong');
      heading.textContent = `=== ${result.fileName} ===`;
      fileHeader.appendChild(heading);
      container.appendChild(fileHeader);
    }

    if (!result.hasSpeakers) {
      const seg = document.createElement('div');
      seg.className = 'transcript-segment';
      const text = document.createElement('span');
      text.className = 'segment-text';
      text.textContent = result.text;
      seg.appendChild(text);
      container.appendChild(seg);
      continue;
    }

    // Parse pyannote-formatted text using the pure function from transcript-format.js
    const segments = window.transcriptFormat.parseRichTranscript(result.text);
    for (const seg of segments) {
      const div = document.createElement('div');
      div.className = 'transcript-segment';
      const speakerNumber = Number.isInteger(Number(seg.speakerNum))
        ? Math.max(1, Math.min(Number(seg.speakerNum), 8))
        : 1;
      const label = document.createElement('span');
      label.className = `speaker-label speaker-${speakerNumber}`;
      label.textContent = `Speaker ${seg.speakerLabel}`;
      const text = document.createElement('span');
      text.className = 'segment-text';
      text.textContent = seg.text;
      div.appendChild(label);
      div.appendChild(text);
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

  // Keep textarea in sync for copy/save (plain text version)
  transcriptEl.value = results.map((r) => {
    if (results.length > 1) return `=== ${r.fileName} ===\n\n${r.text}`;
    return r.text;
  }).join('\n\n\n');
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

function renderLicenses(licenses) {
  clearElement(licenseModalBody);
  licenses.forEach((lic, index) => {
    const section = document.createElement('div');
    section.className = 'license-section';

    const header = document.createElement('div');
    header.className = 'license-section-header';
    const name = document.createElement('span');
    name.className = 'license-name';
    name.textContent = lic.name;
    const badge = document.createElement('span');
    badge.className = `license-badge ${getBadgeClass(lic.license)}`;
    badge.textContent = lic.license;
    header.appendChild(name);
    header.appendChild(badge);

    const description = document.createElement('div');
    description.className = 'license-description';
    description.textContent = lic.description;
    const url = document.createElement('div');
    url.className = 'license-url';
    url.textContent = String(lic.url || '').replace('https://', '');

    const toggle = document.createElement('button');
    toggle.className = 'license-toggle';
    toggle.dataset.index = String(index);
    toggle.type = 'button';
    toggle.innerHTML = '<svg viewBox="0 0 16 16" fill="none" width="10" height="10"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> View license text';

    const fullText = document.createElement('div');
    fullText.className = 'license-full-text';
    fullText.id = `license-text-${index}`;
    fullText.hidden = true;
    fullText.textContent = lic.text;

    section.appendChild(header);
    section.appendChild(description);
    section.appendChild(url);
    section.appendChild(toggle);
    section.appendChild(fullText);
    licenseModalBody.appendChild(section);
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

// --- Diarization setup ---

async function checkPythonSetup() {
  btnCheckPython.classList.add('checking');
  diarizeStatusText.textContent = 'Checking...';
  diarizeStatusDot.className = 'menu-status-dot menu-status-dot-unknown';

  try {
    const settings = await window.api.getSettings({ refreshPyannote: true });
    pythonSetup = settings?.pyannote || { pythonFound: false };
    if (typeof settings?.hfTokenConfigured === 'boolean') {
      hfTokenConfigured = settings.hfTokenConfigured;
    }
    if (hfTokenConfigured && !hfTokenInput.value) {
      hfTokenInput.placeholder = 'Saved token configured';
    }
  } catch (_) {
    pythonSetup = { pythonFound: false };
  }

  btnCheckPython.classList.remove('checking');

  if (!pythonSetup.pythonFound) {
    diarizeStatusText.textContent = 'Python 3.9+ not found';
    diarizeStatusDot.className = 'menu-status-dot menu-status-dot-error';
    gpuStatus.hidden = true;
  } else if (!pythonSetup.pyannoteInstalled) {
    diarizeStatusText.textContent = 'pyannote not detected';
    diarizeStatusDot.className = 'menu-status-dot menu-status-dot-error';
    gpuStatus.hidden = true;
  } else {
    diarizeStatusText.textContent = `pyannote ${pythonSetup.pyannoteVersion} detected`;
    diarizeStatusDot.className = 'menu-status-dot menu-status-dot-ready';
    gpuStatus.hidden = false;
    if (pythonSetup.gpuAvailable) {
      gpuStatusDot.className = 'menu-status-dot menu-status-dot-ready';
      gpuStatusText.textContent = 'CUDA detected';
    } else {
      gpuStatusDot.className = 'menu-status-dot menu-status-dot-error';
      gpuStatusText.textContent = 'CUDA not detected';
    }
  }
  if (models.length) {
    onModelChange();
  }
}

btnCheckPython.addEventListener('click', checkPythonSetup);

document.getElementById('btn-diarize-setup-guide').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://github.com/andrewjamesturner0/transcriber#speaker-diarization-advanced');
});

// Persist the HF token in the main-process settings file. Never read it back.
const legacyHfToken = localStorage.getItem('hf-token') || '';
hfTokenInput.value = '';
if (legacyHfToken) {
  window.api.updateSettings({ hfToken: legacyHfToken });
  localStorage.removeItem('hf-token');
}
hfTokenInput.addEventListener('input', () => {
  window.api.updateSettings({ hfToken: hfTokenInput.value }).then((settings) => {
    if (typeof settings?.hfTokenConfigured === 'boolean') {
      hfTokenConfigured = settings.hfTokenConfigured;
      if (models.length) onModelChange();
    }
  }).catch(() => {});
});

// Listen for diarization progress
window.api.onDiarizeStatus((data) => {
  if (data.error) {
    setStatus(`Diarization error: ${data.error}`, 'error');
  } else if (data.message) {
    const pct = data.percent != null ? ` (${data.percent}%)` : '';
    setStatus(`${data.message}${pct}`, 'progress');
  }
});

async function loadProcessingDevice() {
  try {
    const settings = await window.api.getSettings({});
    processingDeviceSelect.value = settings.gpu.setting || 'auto';
    processingDeviceNote.textContent = settings.gpu.backend === 'vulkan'
      ? `Using ${settings.gpu.deviceName || 'Vulkan GPU'}`
      : 'Using CPU';
  } catch (_) {
    processingDeviceSelect.value = 'auto';
    processingDeviceNote.textContent = 'Device status unavailable';
  }
}

processingDeviceSelect.addEventListener('change', async () => {
  processingDeviceSelect.disabled = true;
  try {
    await window.api.updateSettings({ gpuPreference: processingDeviceSelect.value });
    await loadProcessingDevice();
  } catch (error) {
    setStatus(`Could not change processing device: ${error.message}`, 'error');
  } finally {
    processingDeviceSelect.disabled = false;
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

// --- Init ---
loadModels();
checkPythonSetup();
loadProcessingDevice();
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
  link.textContent = 'Update ready - click to restart';
  link.onclick = (e) => {
    e.preventDefault();
    window.api.installUpdate();
  };
});
