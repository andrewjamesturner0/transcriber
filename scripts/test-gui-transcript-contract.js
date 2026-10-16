#!/usr/bin/env node
// Pure GUI formatting contract exercised with real speaker assignment output.
const assert = require('node:assert/strict');
const { assignSpeakers } = require('../lib/diarize-merge');
const { getTranscriptSegments, parseRichTranscript, formatBatchText } = require('../renderer/transcript-format');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL: ${name} -- ${err.message}`);
    failed++;
  }
}

function recognisedWords() {
  const tokens = [
    ['Before.', 0, 100],
    ['Hello.', 6000, 6300],
    ['Yes.', 6400, 6500],
    ['Thanks.', 6600, 6800],
    ['After.', 14000, 14100],
  ].map(([text, from, to]) => ({ text: ' ' + text, offsets: { from, to } }));
  return { transcription: [{
    text: tokens.map((token) => token.text).join(''),
    offsets: { from: 0, to: 14100 },
    tokens,
  }] };
}

function labelledResult(assignment, extra = {}) {
  const { text, ...attribution } = assignment;
  return {
    text,
    transcript: {
      version: 1,
      kind: 'speaker-labelled',
      blocks: assignment.blocks,
      speakers: assignment.speakers,
      attribution,
      alignment: null,
      warnings: [],
      ...extra,
    },
  };
}

const timeline = [
  { start: 6, end: 6.35, speaker: 'first' },
  { start: 6.35, end: 6.55, speaker: 'second' },
  { start: 6.55, end: 7, speaker: 'first' },
];

test('mixed Unknown and short reply blocks retain every recognised word', () => {
  const assignment = assignSpeakers(recognisedWords(), timeline);
  const result = labelledResult(assignment);
  const segments = getTranscriptSegments(result);
  assert.deepEqual(segments, [
    { speakerNum: 0, speakerLabel: 'Unknown', text: 'Before.' },
    { speakerNum: 1, speakerLabel: '1', text: 'Hello.' },
    { speakerNum: 2, speakerLabel: '2', text: 'Yes.' },
    { speakerNum: 1, speakerLabel: '1', text: 'Thanks.' },
    { speakerNum: 0, speakerLabel: 'Unknown', text: 'After.' },
  ]);
  assert.equal(segments.map((segment) => segment.text).join(' '), assignment.words.map((word) => word.text).join(' '));
  assert.deepEqual(parseRichTranscript(result.text), segments);
  assert.equal(formatBatchText([{ fileName: 'one.wav', text: result.text }]), assignment.text);
});

test('all-Unknown assignment remains visible with a neutral label', () => {
  const assignment = assignSpeakers(recognisedWords(), []);
  const segments = getTranscriptSegments(labelledResult(assignment));
  assert.equal(assignment.speakerCount, 0);
  assert.deepEqual(segments, [{
    speakerNum: 0, speakerLabel: 'Unknown', text: 'Before. Hello. Yes. Thanks. After.',
  }]);
  assert.deepEqual(parseRichTranscript(assignment.text), segments);
});

test('formatting leaves assignment timing and overlap evidence untouched', () => {
  const assignment = assignSpeakers(recognisedWords(), {
    regular: [...timeline, { start: 6, end: 7, speaker: 'second' }],
    exclusive: timeline,
  });
  const result = labelledResult(assignment);
  const before = JSON.stringify(result);
  getTranscriptSegments(result);
  assert.equal(JSON.stringify(result), before);
  assert.equal(result.transcript.attribution.timeline, 'exclusive');
  assert(result.transcript.attribution.words.some((word) => word.evidence.overlapSpeakers.length === 2));
  assert(result.transcript.attribution.words.every((word) => word.timingSource));
});

test('alignment failure preserves real labelled blocks and explicit warning', () => {
  const result = labelledResult(assignSpeakers(recognisedWords(), timeline), {
    alignment: { status: 'failed', message: 'Alignment model unavailable' },
    warnings: ['Word alignment failed; using Whisper timing'],
  });
  const segments = getTranscriptSegments(result);
  assert.equal(segments.length, 5);
  assert.equal(segments[2].text, 'Yes.');
  assert.equal(result.transcript.alignment.status, 'failed');
  assert.equal(result.transcript.warnings.length, 1);
});

test('diarisation fallback renders canonical plain text without speaker guesses', () => {
  const result = {
    text: 'Literal [Speaker 1] text survives.',
    transcript: {
      version: 1, kind: 'plain', blocks: [], speakers: [], attribution: null,
      alignment: { status: 'completed' },
      warnings: ['Speaker labelling failed; using plain transcript'],
    },
  };
  assert.deepEqual(getTranscriptSegments(result), [{
    speakerNum: 0, speakerLabel: null, text: result.text,
  }]);
  assert.equal(result.transcript.alignment.status, 'completed');
  assert.equal(formatBatchText([{ fileName: 'fallback.wav', text: result.text }]), result.text);
});

test('plain and TinyDiarize use text display without invented speaker blocks', () => {
  for (const kind of ['plain', 'tinydiarize']) {
    const result = {
      text: kind === 'plain' ? 'Plain words.' : '[00:00:00.000 --> 00:00:01.000] Hello[SPEAKER_TURN]World',
      transcript: { version: 1, kind, blocks: [], speakers: [], attribution: null, alignment: null, warnings: [] },
    };
    assert.deepEqual(getTranscriptSegments(result), [{
      speakerNum: 0, speakerLabel: null,
      text: kind === 'plain' ? 'Plain words.' : 'Hello\n\n--- Speaker Change ---\n\nWorld',
    }]);
    assert.equal(result.transcript.blocks.length, 0);
    assert.equal(formatBatchText([{ fileName: 'one.wav', text: result.text }]), result.text);
  }
});

test('batch export keeps exact headings and newlines across structured variants', () => {
  const labelled = labelledResult(assignSpeakers(recognisedWords(), timeline));
  const inputs = [
    { fileName: 'labelled.wav', text: labelled.text },
    { fileName: 'plain.wav', text: 'Plain words.\n' },
    { fileName: 'tiny.wav', text: 'Hello[SPEAKER_TURN]World' },
  ];
  assert.equal(formatBatchText([]), '');
  assert.equal(formatBatchText(inputs.slice(0, 1)), labelled.text);
  assert.equal(formatBatchText(inputs),
    '=== labelled.wav ===\n\n' + labelled.text +
    '\n\n\n=== plain.wav ===\n\nPlain words.\n' +
    '\n\n\n=== tiny.wav ===\n\nHello[SPEAKER_TURN]World');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
