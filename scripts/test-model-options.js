#!/usr/bin/env node

const paths = require('../lib/paths');
paths.initPaths({ isPackaged: false, resourcesPath: '/fake/app' });
const { validateJobOptions } = require('../lib/models');
const { getCatalogueModel } = require('../lib/model-catalogue');
const contracts = require('./fixtures/model-contracts.json');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  FAIL: ${name} -- ${error.message}`);
    failed += 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function codes(result) {
  return result.errors.map((error) => error.code);
}

test('Whisper multilingual accepts translation to English', () => {
  const result = validateJobOptions('small', { jobMode: 'translate', sourceLanguage: 'auto', targetLanguage: 'en' });
  assert(result.valid, JSON.stringify(result.errors));
});

test('Whisper multilingual accepts an explicit source language', () => {
  const result = validateJobOptions('small', { jobMode: 'translate', sourceLanguage: 'fr', targetLanguage: 'en' });
  assert(result.valid, JSON.stringify(result.errors));
});

test('English Whisper rejects translation', () => {
  const result = validateJobOptions('small.en', { jobMode: 'translate', sourceLanguage: 'en', targetLanguage: 'de' });
  assert(codes(result).includes('TRANSLATION_UNSUPPORTED'));
});

test('Moonshine rejects speaker labels and repetition control', () => {
  const result = validateJobOptions('moonshine-tiny', { speakerLabels: true, reduceRepeatedText: true });
  assert(codes(result).includes('SPEAKER_LABELS_UNSUPPORTED'));
  assert(codes(result).includes('REPETITION_CONTROL_UNSUPPORTED'));
});

test('Qwen rejects an explicit source language', () => {
  const result = validateJobOptions('qwen3-asr-0.6b', { sourceLanguage: 'en' });
  assert(codes(result).includes('SOURCE_LANGUAGE_AUTO_ONLY'));
});

test('Canary requires a source language and validates translation pairs', () => {
  const missing = validateJobOptions('canary-180m-flash', { sourceLanguage: 'auto' });
  assert(codes(missing).includes('SOURCE_LANGUAGE_REQUIRED'));
  const allowed = validateJobOptions('canary-180m-flash', { jobMode: 'translate', sourceLanguage: 'de', targetLanguage: 'en' });
  assert(allowed.valid, JSON.stringify(allowed.errors));
  const denied = validateJobOptions('canary-180m-flash', { jobMode: 'translate', sourceLanguage: 'de', targetLanguage: 'fr' });
  assert(codes(denied).includes('TRANSLATION_PAIR_UNSUPPORTED'));
});

test('MOSS requires its built-in speaker labels', () => {
  const result = validateJobOptions('moss-transcribe-diarize', { speakerLabels: false });
  assert(codes(result).includes('SPEAKER_LABELS_REQUIRED'));
});

test('expected speakers requires speaker labels', () => {
  const result = validateJobOptions('small', { expectedSpeakers: 2, speakerLabels: false });
  assert(codes(result).includes('EXPECTED_SPEAKERS_REQUIRES_LABELS'));
});

test('Reduce repeated text remains valid for retained Whisper', () => {
  const result = validateJobOptions('tiny.en', { reduceRepeatedText: true });
  assert(result.valid, JSON.stringify(result.errors));
});

test('catalogue capability data cannot be mutated to change later validation', () => {
  const model = getCatalogueModel('canary-180m-flash');
  const originalLanguage = model.languages[0];
  const originalTarget = model.translationPairs[0].target;
  assert(Reflect.set(model.languages, 0, 'xx') === false, 'languages mutation should fail');
  assert(Reflect.set(model.translationPairs[0], 'target', 'xx') === false, 'translation pair mutation should fail');
  assert(model.languages[0] === originalLanguage, 'language should remain unchanged');
  assert(model.translationPairs[0].target === originalTarget, 'translation pair should remain unchanged');

  const result = validateJobOptions('canary-180m-flash', {
    jobMode: 'translate',
    sourceLanguage: 'en',
    targetLanguage: 'de',
  });
  assert(result.valid, JSON.stringify(result.errors));
});

test('all 19 model option contracts match catalogue metadata', () => {
  assert(contracts.models.length === 19, `expected 19 contracts, got ${contracts.models.length}`);
  for (const expected of contracts.models) {
    const model = getCatalogueModel(expected.id);
    assert((model.translationPairs.length > 0) === expected.canTranslate, `${model.id}: translation mismatch`);
    assert(model.languageSelection === expected.languageMode, `${model.id}: language mode mismatch`);
    const speakerLabels = model.builtInSpeakers ? 'built-in' : model.pyannoteValidated ? 'pyannote' : 'unavailable';
    assert(speakerLabels === expected.speakerLabels, `${model.id}: speaker labels mismatch`);
    assert((model.pyannoteValidated === true) === expected.expectedSpeakers, `${model.id}: expected speakers mismatch`);
    assert(model.repetitionControl === expected.reduceRepeatedText, `${model.id}: repetition mismatch`);
    assert(model.gated === expected.gated, `${model.id}: gated mismatch`);
    assert(model.audioLimitSeconds === expected.audioLimitSeconds, `${model.id}: audio limit mismatch`);
  }
});

test('all model contracts produce stable unsupported option codes', () => {
  for (const expected of contracts.models) {
    const model = getCatalogueModel(expected.id);
    const sourceLanguage = expected.languageMode === 'fixed' ? model.languages[0]
      : expected.languageMode === 'required' ? model.languages[0] : 'auto';
    const base = validateJobOptions(expected.id, {
      sourceLanguage,
      speakerLabels: expected.speakerLabels === 'built-in',
    });
    assert(base.valid, `${expected.id}: base options should be valid: ${JSON.stringify(base.errors)}`);

    if (!expected.canTranslate) {
      const result = validateJobOptions(expected.id, { jobMode: 'translate', sourceLanguage, targetLanguage: 'en', speakerLabels: expected.speakerLabels === 'built-in' });
      assert(codes(result).includes('TRANSLATION_UNSUPPORTED'), `${expected.id}: missing translation code`);
    }
    if (!expected.reduceRepeatedText) {
      const result = validateJobOptions(expected.id, { sourceLanguage, reduceRepeatedText: true, speakerLabels: expected.speakerLabels === 'built-in' });
      assert(codes(result).includes('REPETITION_CONTROL_UNSUPPORTED'), `${expected.id}: missing repetition code`);
    }
    if (expected.speakerLabels === 'unavailable') {
      const result = validateJobOptions(expected.id, { sourceLanguage, speakerLabels: true });
      assert(codes(result).includes('SPEAKER_LABELS_UNSUPPORTED'), `${expected.id}: missing speaker code`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
