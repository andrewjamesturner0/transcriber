#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const catalogue = require('../lib/model-catalogue');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'renderer', 'style.css'), 'utf8');
const chooserSource = fs.readFileSync(path.join(root, 'renderer', 'model-chooser.js'), 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(chooserSource, sandbox, { filename: 'model-chooser.js' });
const chooser = sandbox.window.modelChooser;
const models = catalogue.listPresentationModels();

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL: ${name} -- ${error.message}`);
    failed++;
  }
}

console.log('Model playground UI tests\n');

test('default model area is a quiet summary without a native select', () => {
  assert(html.includes('id="model-summary-title"'), 'model summary is missing');
  assert(html.includes('id="btn-model-details"'), 'Details action is missing');
  assert(html.includes('id="btn-model-change"'), 'Change action is missing');
  assert(!html.includes('id="model-select"'), 'native model select should be removed');
  assert(!html.includes('id="estimate-banner"'), 'estimate dashboard should be removed');
  assert(!html.includes('id="backend-badge"'), 'backend badge should be removed');
});

test('main flow order is Model, Job options, Audio Files, then Transcribe', () => {
  const positions = [
    html.indexOf('id="model-section-label"'),
    html.indexOf('id="job-options-label"'),
    html.indexOf('>Audio Files<'),
    html.indexOf('id="btn-transcribe"'),
  ];
  assert(positions.every((position) => position >= 0), 'a main flow section is missing');
  assert(positions.every((position, index) => index === 0 || position > positions[index - 1]), 'main flow order is wrong');
});

test('six task-first suggestions resolve to catalogue models', () => {
  const suggestions = chooser.suggestions(models);
  assert(suggestions.length === 6, `expected 6 suggestions, got ${suggestions.length}`);
  assert(new Set(suggestions.map((entry) => entry.model.id)).size === 5, 'Large v3 should serve translation and accuracy first');
});

test('translation suggestion uses Whisper Large v3', () => {
  const translation = chooser.suggestions(models).find((entry) => entry.task.id === 'translation');
  assert(translation, 'translation suggestion is missing');
  assert(translation.model.id === 'large-v3', `expected large-v3, got ${translation.model.id}`);
});

test('shared models retain distinct task roles and use catalogue defaults', () => {
  const large = models.find((model) => model.id === 'large-v3');
  assert(chooser.defaultTaskId(large) === 'accuracy-first', 'all-model choice should use the catalogue task');
  assert(chooser.taskLabel('translation') === 'Translation', 'translation role label is missing');
  assert(chooser.taskLabel('accuracy-first') === 'Accuracy first', 'accuracy role label is missing');
  assert(renderer.includes("let selectedTaskId = 'general-purpose';"), 'selected task state is missing');
  assert(renderer.includes('() => chooseModel(model, task.id)'), 'suggestion choice should preserve its task');
  assert(renderer.includes('options.taskId === selectedTaskId'), 'suggestion current state should use its task');
  assert(renderer.includes('entry.id === selectedTaskId && entry.modelId === m.id'), 'summary should use the selected task');
  assert(renderer.includes("const detailsTaskId = returnView === 'all'"), 'all-model details should derive a default task');
  assert(renderer.includes('model.id === selectedModelId ? selectedTaskId'), 'selected model details should preserve its task');
});

test('all 19 models are reachable and TinyDiarize stays absent', () => {
  const ordered = chooser.orderedModels(models);
  assert(ordered.length === 19, `expected 19 models, got ${ordered.length}`);
  assert(new Set(ordered.map((model) => model.id)).size === 19, 'models should not be duplicated');
  assert(!ordered.some((model) => model.id.includes('tdrz')), 'TinyDiarize must be absent');
});

test('full catalogue search covers names, uses and languages', () => {
  assert(chooser.filterModels(models, 'medical').some((model) => model.id === 'medasr'), 'medical search should find MedASR');
  assert(chooser.filterModels(models, 'zh').some((model) => model.id === 'moss-transcribe-diarize'), 'language search should find MOSS');
  assert(chooser.filterModels(models, 'moonshine').some((model) => model.id === 'moonshine-tiny'), 'name search should find Moonshine');
});

test('details layer contains the locked facts and a deferred MOSS action', () => {
  for (const label of ['Best for', 'Download size', 'Languages', 'Timing', 'Expected memory', 'Engine', 'Licence', 'Source']) {
    assert(renderer.includes(`['${label}'`), `${label} detail is missing`);
  }
  assert(renderer.includes("'Unavailable in this release'"), 'deferred model state is missing');
  assert(renderer.includes('model.knownIssues.join'), 'material warnings are missing');
});

test('dialog has modal semantics, transition focus, focus trap, Escape and focus restoration', () => {
  assert(html.includes('role="dialog"'), 'dialog role is missing');
  assert(html.includes('aria-modal="true"'), 'modal state is missing');
  assert(renderer.includes("event.key !== 'Tab'"), 'focus trap is missing');
  assert(renderer.includes('focusModelDialogControl('), 'view transitions should move focus to a stable control');
  assert(renderer.includes('!modelDialog.contains(document.activeElement)'), 'focus trap should recover focus from outside the dialog');
  assert(renderer.includes("event.key === 'Escape'"), 'Escape handling is missing');
  assert(renderer.includes('restore.focus()'), 'focus restoration is missing');
});

test('selection changes only through an explicit suggestion or Choose action', () => {
  const assignments = renderer.match(/selectedModelId = model\.id/g) || [];
  assert(assignments.length === 1, `expected one selection assignment, got ${assignments.length}`);
  assert(renderer.includes(": gatedAccessMissing ? 'Set up Hugging Face access in Settings' : 'Choose this model'"), 'details confirmation is missing');
});

test('job options disclose core controls before advanced controls', () => {
  const core = ['job-mode-select', 'source-language-select', 'target-language-select', 'speaker-labels-toggle'];
  const advanced = ['expected-speakers-select', 'reduce-repeated-text-toggle'];
  for (const id of [...core, ...advanced]) assert(html.includes(`id="${id}"`), `${id} is missing`);
  assert(html.indexOf('id="btn-advanced-options"') > html.indexOf('id="speaker-labels-toggle"'), 'advanced disclosure is too early');
  assert(html.indexOf('id="expected-speakers-select"') > html.indexOf('id="btn-advanced-options"'), 'advanced fields should follow disclosure');
});

test('Settings retains global setup and logs but excludes per-job controls', () => {
  const settingsMarkup = html.slice(html.indexOf('id="menu-dropdown"'), html.indexOf('</header>'));
  assert(settingsMarkup.includes('id="processing-device-select"'), 'global device preference should remain in Settings');
  assert(settingsMarkup.includes('id="diarize-options"'), 'pyannote setup should remain in Settings');
  assert(settingsMarkup.includes('id="hf-token-input"'), 'Hugging Face setup should remain in Settings');
  assert(settingsMarkup.includes('id="diarize-setup-status"'), 'pyannote setup status should remain in Settings');
  assert(settingsMarkup.includes('id="btn-open-log"'), 'Open Log File should remain in Settings');
  assert(settingsMarkup.includes('id="btn-open-log-folder"'), 'Open Log Folder should remain in Settings');
  assert(!settingsMarkup.includes('anti-corruption-toggle'), 'repetition control should not be in Settings');
  assert(!settingsMarkup.includes('diarize-toggle'), 'speaker label control should not be in Settings');
  assert(!settingsMarkup.includes('num-speakers-select'), 'speaker count should not be in Settings');
  assert(renderer.includes('window.api.deriveJobOptions'), 'renderer should use shared option derivation');
});

test('queue renders untrusted file data and failure reasons as text', () => {
  assert(renderer.includes("name.textContent = item.fileName"), 'queue should render file names as text');
  assert(renderer.includes("name.title = item.filePath"), 'queue should assign paths without HTML interpolation');
  assert(renderer.includes("itemStatus.textContent = item.error || item.status"), 'queue should show the per-file error as text');
  assert(!renderer.includes('item.error ? escapeHtml(item.error)'), 'queue failures should not use HTML interpolation');
});

test('run state is snapshotted once and model controls are locked', () => {
  assert(renderer.includes('const runModelId = selectedModelId;'), 'run model snapshot is missing');
  assert(renderer.includes('Object.freeze({ ...jobOptionsView.effective })'), 'run option snapshot is missing');
  assert(renderer.includes('modelId: runModelId'), 'transcription should use the model snapshot');
  assert(renderer.includes('options: runOptions'), 'transcription should use the option snapshot');
  assert(renderer.includes('btnModelChange.disabled = running'), 'model Change should lock during a run');
  assert(renderer.includes('btnConfigureOptions.disabled = running'), 'Configure should lock during a run');
  assert(renderer.includes('btnAdvancedOptions.disabled = true'), 'Advanced options should lock during a run');
  for (const control of [
    'jobModeSelect',
    'sourceLanguageSelect',
    'targetLanguageSelect',
    'speakerLabelsToggle',
    'expectedSpeakersSelect',
    'reduceRepeatedTextToggle',
  ]) {
    assert(renderer.includes(`${control}.disabled = transcriptionRunning`), `${control} should retain the run lock when rendered`);
  }
  assert(renderer.includes('} else {\n    onModelChange();'), 'completion should rederive capability states');
});

test('finishing a run consumes successes, keeps errors and gates empty output', () => {
  assert(renderer.includes('queue.finishRun(runResults)'), 'renderer should explicitly finish each queue run');
  assert(renderer.includes("item.status === 'done' && typeof item.result === 'string' && item.result.trim()"), 'output should require current non-empty text');
  assert(renderer.includes('outputSection.hidden = !hasOutput'), 'empty current runs should not expose output');
  assert(renderer.includes('btnSave.disabled = !hasOutput'), 'Save should require current output');
});

test('gated model actions require boolean HF setup state without exposing a token', () => {
  assert(renderer.includes('let hfTokenConfigured = false;'), 'defensive HF setup state is missing');
  assert(renderer.includes('model.gated && !hfTokenConfigured'), 'gated model action guard is missing');
  assert(renderer.includes("['Access', 'Accept access terms on Hugging Face', model.accessUrl]"), 'gated access link is missing');
  assert(!renderer.includes('settings.hfToken;'), 'renderer must not receive a saved token');
});

test('untrusted renderer values do not use HTML interpolation', () => {
  for (const value of ['item.fileName', 'item.filePath', 'item.error', 'msg', 'result.fileName', 'result.text', 'seg.text', 'lic.name', 'lic.description', 'lic.text']) {
    assert(!new RegExp(`innerHTML\\s*=.*\\$\\{[^}]*${value.replace('.', '\\.')}`).test(renderer), `${value} reaches innerHTML`);
  }
});

test('responsive, reduced-motion and focus contracts are present', () => {
  assert(styles.includes('@media (max-width: 560px)'), 'narrow layout is missing');
  assert(styles.includes('align-items: end'), 'narrow model sheet should be bottom aligned');
  assert(styles.includes('@media (prefers-reduced-motion: reduce)'), 'reduced motion is missing');
  assert(styles.includes(':focus-visible'), 'visible keyboard focus is missing');
  assert(styles.includes('[hidden] { display: none !important; }'), 'hidden states must override component display');
});

test('plain and speaker-labelled output keep one copy and save source', () => {
  assert(renderer.includes('transcriptEl.value = results.map'), 'rich output should keep a plain-text copy');
  assert((renderer.match(/const text = transcriptEl\.value;/g) || []).length === 2, 'copy and save should use the plain-text value');
  assert(renderer.includes("container.setAttribute('tabindex', '0')"), 'speaker-labelled output should be keyboard focusable');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
