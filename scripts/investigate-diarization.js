#!/usr/bin/env node
'use strict';

// Reproductions for .agents/docs/diarization-investigation.md (local notes), 2026-10-14.
//
// This script used to assert the seven defects the investigation found.
// Those defects are fixed, and each case is now a regression test that
// asserts the desired behaviour. Run the regressions instead:
//
//   node scripts/test-transcript-timing.js
//   node scripts/test-merge.js            (section "Investigation regressions")
//   node scripts/test-whisper-runner.js   (DTW with --no-flash-attn)
//
// Running this script prints where each case now lives.

const CASES = [
  ['DTW silently disabled by flash attention', 'scripts/test-whisper-runner.js, scripts/test-whisper-dtw.js'],
  ['Valid DTW anchors had no effect on word times', 'test-merge.js "case 1", test-transcript-timing.js "different valid anchors"'],
  ['600 ms reply reassigned by short-block merging', 'test-merge.js "case 2"'],
  ['200 ms reply erased by segment absorption', 'test-merge.js "case 3"'],
  ['A-only speech after nested B overlap became B', 'test-merge.js "case 4"'],
  ['Invalid DTW anchors and offset fallback', 'test-merge.js "case 5"'],
  ['Negative token times overrode segment times', 'test-merge.js "case 6", test-transcript-timing.js "negative token offsets"'],
  ['Smoothing overwrote Unknown beyond the gap distance', 'test-merge.js "case 7"'],
];

for (const [name, where] of CASES) console.log(`FIXED: ${name}\n       -> ${where}`);
console.log('\nThese are now regression tests; this script asserts nothing.');
