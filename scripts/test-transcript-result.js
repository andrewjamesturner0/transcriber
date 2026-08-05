#!/usr/bin/env node

const {
  createTranscriptResult,
  normalizeWhisperJson,
  withTranscriptDetail,
} = require('../lib/transcript-result');
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

test('text-only results omit unavailable detail', () => {
  const result = createTranscriptResult({ text: 'hello', model: 'moonshine-tiny', engine: 'transcribe.cpp', backend: 'cpu' });
  assert(result.text === 'hello');
  assert(!('segments' in result));
  assert(!('words' in result));
  assert(!('truncated' in result));
});

test('optional detail is preserved when present', () => {
  const words = [{ text: 'hello', start: 0, end: 1 }];
  const result = createTranscriptResult({ text: 'hello', model: 'parakeet-tdt-ctc-110m', engine: 'transcribe.cpp', backend: 'vulkan', detectedLanguage: 'en', words, truncated: false });
  assert(result.words === words);
  assert(result.truncated === false);
  assert(result.detectedLanguage === 'en');
});

test('engine-neutral performance timings are preserved as a safe plain object', () => {
  const timings = { loadMs: 10.5, melMs: 2, encodeMs: 30, decodeMs: 40 };
  const result = createTranscriptResult({ text: 'hello', model: 'parakeet-tdt-ctc-110m', engine: 'transcribe.cpp', backend: 'cpu', timings });
  assert(JSON.stringify(result.timings) === JSON.stringify(timings));
  assert(result.timings !== timings, 'timings should be copied');
  assert(Object.getPrototypeOf(result.timings) === Object.prototype, 'timings should use the plain object prototype');
});

test('invalid timing records and arbitrary prototypes are rejected', () => {
  const invalidValues = [
    [],
    {},
    { loadMs: -1 },
    { loadMs: Number.NaN },
    { loadMs: '10' },
    { loadSeconds: 10 },
    Object.assign(Object.create({ inheritedMs: 1 }), { loadMs: 10 }),
  ];
  for (const timings of invalidValues) {
    let error;
    try {
      createTranscriptResult({ text: 'hello', model: 'example', engine: 'transcribe.cpp', backend: 'cpu', timings });
    } catch (caught) {
      error = caught;
    }
    assert(error && error.message.includes('timings'), `should reject timings: ${String(timings)}`);
  }
});

test('invalid result fields are rejected', () => {
  let error;
  try { createTranscriptResult({ text: 'hello', model: '', engine: 'whisper.cpp', backend: 'cpu' }); } catch (caught) { error = caught; }
  assert(error && error.message.includes('model'));
});

test('Whisper JSON normalizes only returned detail', () => {
  const detail = normalizeWhisperJson({
    result: { language: 'en' },
    transcription: [{ text: 'hello', offsets: { from: 10, to: 20 }, tokens: [{ text: 'hello', offsets: { from: 10, to: 20 } }] }],
  });
  assert(detail.detectedLanguage === 'en');
  assert(detail.segments[0].startMs === 10);
  assert(detail.tokens.length === 1);
  assert(detail.words[0].text === 'hello');
});

test('detail can be added without creating absent arrays', () => {
  const base = createTranscriptResult({ text: 'hello', model: 'tiny.en', engine: 'whisper.cpp', backend: 'cpu' });
  const result = withTranscriptDetail(base, { detectedLanguage: 'en' });
  assert(result.detectedLanguage === 'en');
  assert(!('segments' in result));
});

test('representative result fixtures preserve present fields and omit absent fields', () => {
  for (const fixture of contracts.results) {
    const result = createTranscriptResult(fixture.input);
    for (const field of fixture.present) assert(field in result, `${fixture.id}: missing ${field}`);
    for (const field of fixture.absent) assert(!(field in result), `${fixture.id}: should omit ${field}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
