#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  getCatalogueModel,
  validateJobOptions,
} = require('../lib/model-catalogue');
const {
  createJobOptionsState,
  setOptionsOpen,
  setAdvancedOpen,
  updateJobOption,
  deriveJobOptions,
  getAudioLimitMessageData,
} = require('../renderer/job-options');
const fixtures = require('./fixtures/model-options.json');

function openState(initial = {}) {
  return createJobOptionsState({ ...initial, optionsOpen: true, advancedOpen: true });
}

function view(modelId, state) {
  return deriveJobOptions(getCatalogueModel(modelId), state, validateJobOptions);
}

function testRepresentativeFixturesExist() {
  for (const modelId of fixtures.representativeModels) getCatalogueModel(modelId);
}

function testBrowserExport() {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/job-options.js'), 'utf8');
  const context = {};
  vm.runInNewContext(source, context);
  assert.strictEqual(typeof context.JobOptions.createJobOptionsState, 'function');
  assert.strictEqual(typeof context.JobOptions.deriveJobOptions, 'function');
}

function testEffectiveSummary() {
  const result = view('small', openState({
    jobMode: 'translate',
    sourceLanguage: 'auto',
    targetLanguage: 'en',
    speakerLabels: true,
    expectedSpeakers: 2,
    reduceRepeatedText: true,
  }));
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.summary,
    'Translate - Detect language - Target: en - Speaker labels - Expected speakers: 2 - Reduce repeated text');
  assert.deepStrictEqual(result.effective, {
    jobMode: 'translate',
    sourceLanguage: 'auto',
    targetLanguage: 'en',
    speakerLabels: true,
    expectedSpeakers: 2,
    reduceRepeatedText: true,
  });
}

function testUnsupportedControlsUseCatalogueReasons() {
  const result = view('moonshine-tiny', openState({
    jobMode: 'translate',
    sourceLanguage: 'auto',
    speakerLabels: true,
    expectedSpeakers: 3,
    reduceRepeatedText: true,
  }));
  assert.deepStrictEqual(result.effective, {
    jobMode: 'transcribe',
    sourceLanguage: 'en',
    targetLanguage: null,
    speakerLabels: false,
    expectedSpeakers: null,
    reduceRepeatedText: false,
  });
  assert.strictEqual(result.controls.jobMode.enabled, false);
  assert.strictEqual(result.controls.jobMode.reason, 'Moonshine Tiny does not support translation.');
  assert.strictEqual(result.controls.sourceLanguage.enabled, false);
  assert.strictEqual(result.controls.sourceLanguage.reason, 'Moonshine Tiny only supports en.');
  assert.strictEqual(result.controls.speakerLabels.enabled, false);
  assert.strictEqual(result.controls.speakerLabels.reason,
    'Moonshine Tiny has not been validated for speaker labels in Transcriber.');
  assert.strictEqual(result.controls.expectedSpeakers.enabled, false);
  assert.strictEqual(result.controls.expectedSpeakers.reason,
    'Expected speakers is available only when speaker labels are enabled.');
  assert.strictEqual(result.controls.reduceRepeatedText.enabled, false);
  assert.strictEqual(result.controls.reduceRepeatedText.reason,
    'Moonshine Tiny does not have a tested Reduce repeated text option.');
}

function testAutomaticLanguageIsFixedButVisible() {
  const result = view('qwen3-asr-0.6b', openState({ sourceLanguage: 'en' }));
  assert.strictEqual(result.effective.sourceLanguage, 'auto');
  assert.strictEqual(result.controls.sourceLanguage.visible, true);
  assert.strictEqual(result.controls.sourceLanguage.enabled, false);
  assert.strictEqual(result.controls.sourceLanguage.reason,
    'Qwen3-ASR 0.6B detects language automatically and does not accept a language choice.');
}

function testTargetLanguageIsConditional() {
  const collapsedTarget = view('canary-180m-flash', openState({
    jobMode: 'transcribe', sourceLanguage: 'en',
  }));
  assert.strictEqual(collapsedTarget.controls.targetLanguage.visible, false);

  const translated = view('canary-180m-flash', openState({
    jobMode: 'translate', sourceLanguage: 'en', targetLanguage: 'de',
  }));
  assert.strictEqual(translated.controls.targetLanguage.visible, true);
  assert.strictEqual(translated.controls.targetLanguage.enabled, true);
  assert.deepStrictEqual(translated.controls.targetLanguage.choices.map((choice) => choice.value), ['de', 'es', 'fr']);
  assert.strictEqual(translated.summary,
    'Translate - Source: en - Target: de');
}

function testMultilingualModelsOfferExplicitLanguageHints() {
  const result = view('small', openState());
  const values = result.controls.sourceLanguage.choices.map((choice) => choice.value);
  assert(values.includes('auto'));
  assert(values.includes('en'));
  assert(values.includes('zh'));
}

function testMossRequiresBuiltInLabels() {
  const result = view('moss-transcribe-diarize', openState({ speakerLabels: false }));
  assert.strictEqual(result.effective.speakerLabels, true);
  assert.strictEqual(result.controls.speakerLabels.value, true);
  assert.strictEqual(result.controls.speakerLabels.enabled, false);
  assert.strictEqual(result.controls.speakerLabels.required, true);
  assert.strictEqual(result.controls.speakerLabels.reason,
    'MOSS Transcribe-Diarize always generates speaker labels.');
  assert.strictEqual(result.controls.expectedSpeakers.enabled, false);
  assert.strictEqual(result.controls.expectedSpeakers.reason,
    'MOSS Transcribe-Diarize does not accept an expected speaker count.');
  assert.match(result.summary, /Speaker labels/);
}

function testMedasrLimitMessageData() {
  const model = getCatalogueModel('medasr');
  const durations = fixtures.medasrDurations;
  assert.strictEqual(getAudioLimitMessageData(model, durations.accepted), null);
  const data = getAudioLimitMessageData(model, durations.rejected);
  assert.deepStrictEqual(data, {
    code: 'AUDIO_DURATION_LIMIT_EXCEEDED',
    modelId: 'medasr',
    modelName: 'MedASR',
    limitSeconds: 400,
    durationSeconds: 401,
    limitLabel: durations.limitLabel,
    durationLabel: durations.rejectedLabel,
    message: 'MedASR supports recordings up to 6 minutes 40 seconds. This file is 6 minutes 41 seconds.',
  });
  assert.strictEqual(getAudioLimitMessageData(getCatalogueModel('small'), 999999), null);
}

function testDisclosureStateDoesNotDependOnModel() {
  let state = createJobOptionsState();
  state = setOptionsOpen(state, true);
  state = setAdvancedOpen(state, true);
  state = updateJobOption(state, 'speakerLabels', true);

  const whisper = view('small', state);
  const moonshine = view('moonshine-tiny', state);
  const moss = view('moss-transcribe-diarize', state);
  for (const result of [whisper, moonshine, moss]) {
    assert.strictEqual(result.optionsOpen, true);
    assert.strictEqual(result.advancedOpen, true);
    assert.strictEqual(result.controls.jobMode.visible, true);
    assert.strictEqual(result.controls.reduceRepeatedText.visible, true);
  }
  assert.strictEqual(state.requested.speakerLabels, true);
  assert.strictEqual(whisper.effective.speakerLabels, true);
  assert.strictEqual(moonshine.effective.speakerLabels, false);
  assert.strictEqual(moss.effective.speakerLabels, true);
}

function testCapabilityStatesCanBeRestoredAfterRunLock() {
  const unsupported = view('moonshine-tiny', openState());
  const supported = view('small', openState({ speakerLabels: true }));
  assert.strictEqual(unsupported.controls.jobMode.enabled, false);
  assert.strictEqual(unsupported.controls.sourceLanguage.enabled, false);
  assert.strictEqual(unsupported.controls.speakerLabels.enabled, false);
  assert.strictEqual(unsupported.controls.reduceRepeatedText.enabled, false);
  assert.strictEqual(supported.controls.jobMode.enabled, true);
  assert.strictEqual(supported.controls.sourceLanguage.enabled, true);
  assert.strictEqual(supported.controls.speakerLabels.enabled, true);
  assert.strictEqual(supported.controls.expectedSpeakers.enabled, true);
  assert.strictEqual(supported.controls.reduceRepeatedText.enabled, true);
}

testRepresentativeFixturesExist();
testBrowserExport();
testEffectiveSummary();
testUnsupportedControlsUseCatalogueReasons();
testAutomaticLanguageIsFixedButVisible();
testTargetLanguageIsConditional();
testMultilingualModelsOfferExplicitLanguageHints();
testMossRequiresBuiltInLabels();
testMedasrLimitMessageData();
testDisclosureStateDoesNotDependOnModel();
testCapabilityStatesCanBeRestoredAfterRunLock();

console.log('job-options tests passed');
