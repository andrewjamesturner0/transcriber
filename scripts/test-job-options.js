#!/usr/bin/env node
/**
 * Tests for renderer/job-options.js (speaker labelling availability and
 * per-job options).
 *
 * Usage:
 *     node scripts/test-job-options.js
 */

const { speakerLabelState, buildJobOptions } = require('../renderer/job-options');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS: ${name}`); passed++; } catch (e) { console.log(`  FAIL: ${name} -- ${e.message}`); failed++; }
}
function eq(a, b, label) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

console.log('Job option tests\n');

test('switch usable only when the speaker and word alignment models are both ready', () => {
  eq(speakerLabelState({ diarizationStatus: 'ready', alignmentStatus: 'ready' }).ready, true);
  for (const [d, a] of [['ready', 'model-not-prepared'], ['model-not-prepared', 'ready'], ['ready', 'alignment-missing'],
    ['ready', 'checking'], ['ready', 'unknown'], ['pyannote-missing', 'unavailable']]) {
    eq(speakerLabelState({ diarizationStatus: d, alignmentStatus: a }).ready, false, `${d}/${a}`);
  }
});

test('one download covers whichever model is missing; token only for the speaker model', () => {
  eq(speakerLabelState({ diarizationStatus: 'model-not-prepared', alignmentStatus: 'model-not-prepared' }),
    { ready: false, canDownload: true, needsToken: true });
  eq(speakerLabelState({ diarizationStatus: 'ready', alignmentStatus: 'model-not-prepared' }),
    { ready: false, canDownload: true, needsToken: false });
  eq(speakerLabelState({ diarizationStatus: 'model-not-prepared', alignmentStatus: 'ready' }),
    { ready: false, canDownload: true, needsToken: true });
});

test('no download offered until the Python packages are installed', () => {
  for (const [d, a] of [['python-missing', 'unavailable'], ['pyannote-missing', 'unavailable'],
    ['model-not-prepared', 'alignment-missing'], ['ready', 'alignment-unsupported']]) {
    eq(speakerLabelState({ diarizationStatus: d, alignmentStatus: a }).canDownload, false, `${d}/${a}`);
  }
});

test('plain jobs send no speaker options', () => {
  eq(buildJobOptions({ antiCorruption: true, diarizationOn: false }), { antiCorruption: true });
});

test('labelled jobs always use word alignment, with the speaker count when given', () => {
  eq(buildJobOptions({ antiCorruption: false, diarizationOn: true, numSpeakers: 'auto' }),
    { antiCorruption: false, diarization: true, alignment: 'forced' });
  eq(buildJobOptions({ antiCorruption: false, diarizationOn: true, numSpeakers: '4' }),
    { antiCorruption: false, diarization: true, alignment: 'forced', numSpeakers: 4 });
});

test('no token is ever part of the job options', () => {
  const o = buildJobOptions({ antiCorruption: false, diarizationOn: true, numSpeakers: 'auto' });
  eq(Object.keys(o).includes('hfToken'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
