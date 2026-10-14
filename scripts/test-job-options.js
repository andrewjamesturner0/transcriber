#!/usr/bin/env node
/**
 * Tests for renderer/job-options.js (alignment switch state and per-job
 * options, design decision D4).
 *
 * Usage:
 *     node scripts/test-job-options.js
 */

const { alignmentControlState, buildJobOptions, ALIGNMENT_HELP } = require('../renderer/job-options');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS: ${name}`); passed++; } catch (e) { console.log(`  FAIL: ${name} -- ${e.message}`); failed++; }
}
function eq(a, b, label) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

console.log('Job option tests\n');

test('switch hidden while diarisation is off', () => {
  eq(alignmentControlState({ diarizationOn: false, alignmentStatus: 'ready' }), { visible: false, enabled: false, help: ALIGNMENT_HELP });
});

test('switch usable only when alignment is ready', () => {
  eq(alignmentControlState({ diarizationOn: true, alignmentStatus: 'ready' }).enabled, true);
  for (const s of ['model-not-prepared', 'alignment-missing', 'alignment-unsupported', 'python-missing', 'unknown', 'checking']) {
    const st = alignmentControlState({ diarizationOn: true, alignmentStatus: s });
    eq([st.visible, st.enabled], [true, false], s);
  }
});

test('disabled switch says why', () => {
  eq(alignmentControlState({ diarizationOn: true, alignmentStatus: 'model-not-prepared' }).help,
    'Not set up yet. Download the alignment model in Settings.');
  eq(alignmentControlState({ diarizationOn: true, alignmentStatus: 'alignment-missing' }).help,
    'Not installed. See the setup guide in Settings.');
});

test('plain jobs send no diarisation or alignment options', () => {
  eq(buildJobOptions({ antiCorruption: true, diarizationOn: false, alignChecked: true, alignmentStatus: 'ready' }),
    { antiCorruption: true });
});

test('diarised jobs default to Whisper timing', () => {
  eq(buildJobOptions({ antiCorruption: false, diarizationOn: true, numSpeakers: 'auto', alignChecked: false, alignmentStatus: 'ready' }),
    { antiCorruption: false, diarization: true, alignment: 'whisper' });
});

test('switch on and ready forwards forced alignment and speaker count', () => {
  eq(buildJobOptions({ antiCorruption: false, diarizationOn: true, numSpeakers: '4', alignChecked: true, alignmentStatus: 'ready' }),
    { antiCorruption: false, diarization: true, numSpeakers: 4, alignment: 'forced' });
});

test('a remembered "on" switch is ignored when alignment is not ready', () => {
  eq(buildJobOptions({ antiCorruption: false, diarizationOn: true, numSpeakers: 'auto', alignChecked: true, alignmentStatus: 'model-not-prepared' }).alignment,
    'whisper');
});

test('no token is ever part of the job options', () => {
  const o = buildJobOptions({ antiCorruption: false, diarizationOn: true, numSpeakers: 'auto', alignChecked: true, alignmentStatus: 'ready' });
  eq(Object.keys(o).includes('hfToken'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
