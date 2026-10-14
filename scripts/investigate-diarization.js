#!/usr/bin/env node
'use strict';

// Reproductions for docs/diarization-investigation.md, 2026-10-14.
// These assertions describe existing defects, not the desired behaviour.
// Run: node scripts/investigate-diarization.js
// No audio, Python, model downloads, or credentials are required.
const assert = require('node:assert/strict');
const {
  groupTokensToWords,
  assignWordsToSpeakers,
  refineSpeakerBoundaries,
  mergeTranscriptWithDiarization,
} = require('../lib/diarize-merge');

function token(text, from, to, tDtw) {
  return { text: ' ' + text, offsets: { from, to }, ...(tDtw === undefined ? {} : { t_dtw: tDtw }) };
}

function transcript(tokens) {
  return { transcription: [{ text: tokens.map(t => t.text).join(''), tokens }] };
}

function demonstrate(name, fn) {
  fn();
  console.log('CONFIRMED: ' + name);
}

demonstrate('Changing valid DTW anchors has no effect on grouped word times', () => {
  assert.deepEqual(
    groupTokensToWords([token('Hello.', 0, 800, 10)]),
    groupTokensToWords([token('Hello.', 0, 800, 400)]),
  );
});

demonstrate('A correctly timed 600ms reply is reassigned by final block cleanup', () => {
  const json = transcript([
    token('Ready?', 0, 800),
    token('Yes.', 1000, 1500),
    token('Continue.', 2000, 2800),
  ]);
  const speakers = [
    { start: 0, end: 0.9, speaker: 'A' },
    { start: 1, end: 1.6, speaker: 'B' },
    { start: 2, end: 3, speaker: 'A' },
  ];
  const result = mergeTranscriptWithDiarization(json, speakers);
  assert.ok(result.includes('[Speaker 1] Ready? Yes.'));
  assert.ok(!result.includes('[Speaker 2]'));
  const preserved = mergeTranscriptWithDiarization(json, speakers, { shortBlockMaxWords: 0 });
  assert.ok(preserved.includes('[Speaker 2] Yes.'));
});

demonstrate('A correctly timed 200ms reply is erased before word assignment', () => {
  const json = transcript([
    token('Ready?', 0, 800),
    token('Yes.', 1000, 1150),
    token('Continue.', 1250, 2000),
  ]);
  const speakers = [
    { start: 0, end: 0.9, speaker: 'A' },
    { start: 1, end: 1.2, speaker: 'B' },
    { start: 1.2, end: 2.1, speaker: 'A' },
  ];
  const result = mergeTranscriptWithDiarization(json, speakers, { shortBlockMaxWords: 0 });
  assert.ok(result.startsWith('[1 speaker detected]'));
  const preserved = mergeTranscriptWithDiarization(json, speakers, {
    absorbShortSegSec: 0,
    shortBlockMaxWords: 0,
  });
  assert.ok(preserved.includes('[Speaker 2] Yes.'));
});

demonstrate('Nested overlap refinement assigns A-only speech after B has stopped to B', () => {
  const speakers = [
    { start: 0, end: 10, speaker: 'A' },
    { start: 2, end: 3, speaker: 'B' },
  ];
  const words = groupTokensToWords([token('Before.', 0, 500), token('After.', 4000, 4500)]);
  const assigned = assignWordsToSpeakers(words, speakers).map(word => ({
    ...word,
    wordMidSec: (word.startMs + word.endMs) / 2000,
  }));
  assert.equal(assigned[1].speaker, 'A');
  assert.equal(refineSpeakerBoundaries(assigned, speakers)[1].speaker, 'B');
});

demonstrate('Invalid DTW anchors do not trigger segment fallback while offsets exist', () => {
  const json = transcript([token('Hello.', 0, 800, -1), token('Goodbye.', 2000, 2800, -1)]);
  const speakers = [
    { start: 0, end: 1, speaker: 'A' },
    { start: 1, end: 3, speaker: 'B' },
  ];
  const result = mergeTranscriptWithDiarization(json, speakers);
  assert.ok(result.includes('[Speaker 1] Hello.'));
  assert.ok(result.includes('[Speaker 2] Goodbye.'));
});

demonstrate('Negative token times override valid segment times', () => {
  const speakers = [
    { start: 0, end: 1, speaker: 'A' },
    { start: 4, end: 5, speaker: 'B' },
  ];
  const segment = {
    text: ' Yes.',
    offsets: { from: 4000, to: 5000 },
    tokens: [token('Yes.', -10, -10)],
  };
  assert.ok(mergeTranscriptWithDiarization({ transcription: [segment] }, speakers)
    .includes('[Speaker 1] Yes.'));
  const { tokens, ...withoutTokens } = segment;
  assert.ok(mergeTranscriptWithDiarization({ transcription: [withoutTokens] }, speakers)
    .includes('[Speaker 2] Yes.'));
});

demonstrate('Smoothing overwrites Unknown despite the five-second distance limit', () => {
  const json = transcript([
    token('Before.', 100, 800),
    token('Unsupported.', 10000, 10500),
    token('After.', 20100, 20800),
  ]);
  const speakers = [
    { start: 0, end: 1, speaker: 'A' },
    { start: 20, end: 21, speaker: 'A' },
  ];
  assert.ok(!mergeTranscriptWithDiarization(json, speakers).includes('[Unknown]'));
  assert.ok(mergeTranscriptWithDiarization(json, speakers, {
    smoothingMaxRunLen: 0,
    shortBlockMaxWords: 0,
  }).includes('[Unknown] Unsupported.'));
});

console.log('7 existing behaviours reproduced. These are investigation results, not accuracy tests.');
