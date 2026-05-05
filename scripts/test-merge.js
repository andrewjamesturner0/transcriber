#!/usr/bin/env node
/**
 * Test 3: Transcript + diarization merge logic.
 *
 * Tests mergeTranscriptWithDiarization() with sample data -- no Python,
 * no models, no HF token needed. Runs instantly.
 *
 * Usage:
 *     node scripts/test-merge.js
 */

// --- Import from shared module ---

const {
  DEFAULTS,
  mergeDiarizeSegments,
  groupTokensToWords,
  assignWordsToSpeakers,
  smoothSpeakerAssignments,
  refineSpeakerBoundaries,
  mergeShortBlocks,
  mergeTranscriptWithDiarization,
} = require('../lib/diarize-merge');

// --- Helpers ---

function segsToJson(segs) {
  return {
    transcription: segs.map((s) => ({
      offsets: { from: Math.round(s.start * 1000), to: Math.round(s.end * 1000) },
      text: s.text,
    })),
  };
}

// --- Test runner ---

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name} -- ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// --- Segment-level (fallback) tests ---

console.log('Segment-level fallback tests\n');

test('basic two-speaker merge', () => {
  const whisperJson = segsToJson([
    { start: 0.0, end: 3.0, text: ' Hello, how are you?' },
    { start: 3.0, end: 6.0, text: ' I am fine, thanks.' },
    { start: 6.0, end: 9.0, text: ' Great to hear.' },
  ]);
  const diarize = [
    { start: 0.0, end: 3.5, speaker: 'SPEAKER_00' },
    { start: 3.5, end: 7.0, speaker: 'SPEAKER_01' },
    { start: 7.0, end: 9.0, speaker: 'SPEAKER_00' },
  ];
  const result = mergeTranscriptWithDiarization(whisperJson, diarize);
  assert(result.includes('[2 speakers detected]'), 'should detect 2 speakers');
  assert(result.includes('[Speaker 1] Hello, how are you?'), 'first segment speaker 1');
  assert(result.includes('[Speaker 2] I am fine, thanks.'), 'second segment speaker 2');
  assert(result.includes('[Speaker 1] Great to hear.'), 'third segment speaker 1');
});

test('consecutive same-speaker segments collapse', () => {
  const whisperJson = segsToJson([
    { start: 0.0, end: 2.0, text: ' Part one.' },
    { start: 2.0, end: 4.0, text: ' Part two.' },
    { start: 4.0, end: 6.0, text: ' Different speaker.' },
  ]);
  const diarize = [
    { start: 0.0, end: 4.5, speaker: 'SPEAKER_00' },
    { start: 4.5, end: 6.0, speaker: 'SPEAKER_01' },
  ];
  const result = mergeTranscriptWithDiarization(whisperJson, diarize);
  assert(result.includes('[Speaker 1] Part one. Part two.'), 'should collapse consecutive same-speaker');
  assert(result.includes('[Speaker 2] Different speaker.'), 'different speaker separate');
});

test('single speaker', () => {
  const whisperJson = segsToJson([
    { start: 0.0, end: 5.0, text: ' Just me talking.' },
  ]);
  const diarize = [
    { start: 0.0, end: 5.0, speaker: 'SPEAKER_00' },
  ];
  const result = mergeTranscriptWithDiarization(whisperJson, diarize);
  assert(result.includes('[1 speaker detected]'), 'singular "speaker"');
});

test('empty segments skipped', () => {
  const whisperJson = segsToJson([
    { start: 0.0, end: 2.0, text: ' Hello.' },
    { start: 2.0, end: 3.0, text: '  ' },
    { start: 3.0, end: 5.0, text: ' World.' },
  ]);
  const diarize = [
    { start: 0.0, end: 5.0, speaker: 'SPEAKER_00' },
  ];
  const result = mergeTranscriptWithDiarization(whisperJson, diarize);
  assert(!result.includes('[]'), 'no empty brackets');
  assert(result.includes('Hello. World.'), 'empty segment collapsed');
});

test('no diarize overlap gives Unknown', () => {
  const whisperJson = segsToJson([
    { start: 10.0, end: 15.0, text: ' Ghost text.' },
  ]);
  const diarize = [
    { start: 0.0, end: 5.0, speaker: 'SPEAKER_00' },
  ];
  const result = mergeTranscriptWithDiarization(whisperJson, diarize);
  assert(result.includes('[Unknown]'), 'should label as Unknown');
});

test('fallback when tokens array is missing', () => {
  const whisperJson = {
    transcription: [
      { offsets: { from: 0, to: 3000 }, text: ' Hello there.' },
      { offsets: { from: 3000, to: 6000 }, text: ' How are you?' },
    ],
  };
  const diarize = [
    { start: 0.0, end: 3.5, speaker: 'SPEAKER_00' },
    { start: 3.5, end: 6.0, speaker: 'SPEAKER_01' },
  ];
  const result = mergeTranscriptWithDiarization(whisperJson, diarize);
  assert(result.includes('[Speaker 1] Hello there.'), 'first segment speaker 1');
  assert(result.includes('[Speaker 2] How are you?'), 'second segment speaker 2');
});

test('fallback when tokens array is present but no token has offsets', () => {
  const whisperJson = {
    transcription: [{
      offsets: { from: 0, to: 4000 },
      text: ' No timestamps here.',
      tokens: [
        { text: ' No', id: 1, p: 0.9, t_dtw: -1 },
        { text: ' timestamps', id: 2, p: 0.9, t_dtw: -1 },
        { text: ' here', id: 3, p: 0.9, t_dtw: -1 },
        { text: '.', id: 4, p: 0.9, t_dtw: -1 },
      ],
    }],
  };
  const diarize = [
    { start: 0.0, end: 4.0, speaker: 'SPEAKER_00' },
  ];
  const result = mergeTranscriptWithDiarization(whisperJson, diarize);
  assert(result.includes('[Speaker 1] No timestamps here.'), 'falls back to segment text');
});

// --- Word-level token tests ---

console.log('\nWord-level token tests\n');

test('word-level speaker assignment across a speaker boundary', () => {
  // Single segment whose tokens span a speaker change at 3.0s
  const whisperJson = {
    transcription: [{
      offsets: { from: 0, to: 6000 },
      text: ' Hello world goodbye now.',
      tokens: [
        { text: ' Hello',   offsets: { from: 0,    to: 1500 } },
        { text: ' world',   offsets: { from: 1500, to: 3000 } },
        { text: ' goodbye', offsets: { from: 3000, to: 4500 } },
        { text: ' now',     offsets: { from: 4500, to: 5800 } },
        { text: '.',        offsets: { from: 5800, to: 6000 } },
      ],
    }],
  };
  const diarize = [
    { start: 0.0, end: 3.0, speaker: 'SPEAKER_00' },
    { start: 3.0, end: 6.0, speaker: 'SPEAKER_01' },
  ];
  const result = mergeTranscriptWithDiarization(whisperJson, diarize);
  assert(result.includes('[Speaker 1] Hello world'), 'first two words are speaker 1');
  assert(result.includes('[Speaker 2] goodbye now.'), 'last words are speaker 2');
});

test('same speaker across multiple whisper segments collapses into one utterance', () => {
  const whisperJson = {
    transcription: [
      {
        offsets: { from: 0, to: 3000 },
        text: ' First segment.',
        tokens: [
          { text: ' First',   offsets: { from: 0,    to: 1200 } },
          { text: ' segment', offsets: { from: 1200, to: 2800 } },
          { text: '.',        offsets: { from: 2800, to: 3000 } },
        ],
      },
      {
        offsets: { from: 3000, to: 6000 },
        text: ' Second segment.',
        tokens: [
          { text: ' Second',  offsets: { from: 3000, to: 4500 } },
          { text: ' segment', offsets: { from: 4500, to: 5800 } },
          { text: '.',        offsets: { from: 5800, to: 6000 } },
        ],
      },
    ],
  };
  const diarize = [
    { start: 0.0, end: 6.0, speaker: 'SPEAKER_00' },
  ];
  const result = mergeTranscriptWithDiarization(whisperJson, diarize);
  assert(result.includes('[1 speaker detected]'), 'one speaker');
  assert(result.includes('First segment. Second segment.'), 'collapsed into one utterance');
});

test('first token of a segment with no leading space still starts a word', () => {
  const tokens = [
    { text: 'Hello', offsets: { from: 0, to: 500 } },
    { text: ' world', offsets: { from: 500, to: 1000 } },
  ];
  const words = groupTokensToWords(tokens);
  assert(words.length === 2, `expected 2 words, got ${words.length}`);
  assert(words[0].text === 'Hello', `expected "Hello", got "${words[0].text}"`);
  assert(words[1].text === 'world', `expected "world", got "${words[1].text}"`);
});

test('punctuation tokens attach to preceding word', () => {
  const tokens = [
    { text: ' Hello', offsets: { from: 0,    to: 500  } },
    { text: ',',      offsets: { from: 500,  to: 510  } },
    { text: ' world', offsets: { from: 510,  to: 1000 } },
    { text: '.',      offsets: { from: 1000, to: 1010 } },
  ];
  const words = groupTokensToWords(tokens);
  assert(words.length === 2, `expected 2 words, got ${words.length}`);
  assert(words[0].text === 'Hello,', `expected "Hello,", got "${words[0].text}"`);
  assert(words[1].text === 'world.', `expected "world.", got "${words[1].text}"`);
});

test("contraction tokens attach to preceding word", () => {
  const tokens = [
    { text: ' I',    offsets: { from: 0,   to: 200  } },
    { text: "'m",    offsets: { from: 200, to: 400  } },
    { text: ' fine', offsets: { from: 400, to: 800  } },
    { text: ".",     offsets: { from: 800, to: 900  } },
  ];
  const words = groupTokensToWords(tokens);
  assert(words.length === 2, `expected 2 words, got ${words.length}`);
  assert(words[0].text === "I'm", `expected "I'm", got "${words[0].text}"`);
  assert(words[1].text === 'fine.', `expected "fine.", got "${words[1].text}"`);
});

test('special tokens are skipped', () => {
  const tokens = [
    { text: '[_BEG_]', id: 50363 },
    { text: ' Hello', offsets: { from: 0,   to: 500 } },
    { text: '[_TT_5]', id: 50368 },
    { text: ' world', offsets: { from: 500, to: 1000 } },
  ];
  const words = groupTokensToWords(tokens);
  assert(words.length === 2, `expected 2 words, got ${words.length}`);
  assert(words[0].text === 'Hello', `expected "Hello", got "${words[0].text}"`);
});

test('tokens without offsets inherit prevEndMs', () => {
  const tokens = [
    { text: ' Good', offsets: { from: 0, to: 500 } },
    { text: 'bye',   /* no offsets */ },
  ];
  const words = groupTokensToWords(tokens);
  assert(words.length === 1, `expected 1 word, got ${words.length}`);
  assert(words[0].text === 'Goodbye', `expected "Goodbye", got "${words[0].text}"`);
  assert(words[0].endMs === 500, `expected endMs 500, got ${words[0].endMs}`);
});

test('first token with no offsets and no prevEndMs gives null timestamps', () => {
  const tokens = [
    { text: ' Hey', /* no offsets */ },
    { text: ' there', offsets: { from: 500, to: 1000 } },
  ];
  const words = groupTokensToWords(tokens);
  assert(words.length === 2, `expected 2 words, got ${words.length}`);
  assert(words[0].startMs === null, `expected null startMs, got ${words[0].startMs}`);
  assert(words[0].endMs === null, `expected null endMs, got ${words[0].endMs}`);
  assert(words[1].startMs === 500, `expected startMs 500, got ${words[1].startMs}`);
});

// --- Phase 5: mergeDiarizeSegments tests ---

console.log('\nmergeDiarizeSegments tests\n');

test('merges adjacent same-speaker segments with gap < 0.5s', () => {
  const segs = [
    { start: 0.0, end: 3.0, speaker: 'SPEAKER_00' },
    { start: 3.4, end: 6.0, speaker: 'SPEAKER_00' },
  ];
  const result = mergeDiarizeSegments(segs);
  assert(result.length === 1, `expected 1 segment, got ${result.length}`);
  assert(result[0].start === 0.0 && result[0].end === 6.0, 'merged segment spans full range');
});

test('does not merge adjacent segments from different speakers', () => {
  const segs = [
    { start: 0.0, end: 3.0, speaker: 'SPEAKER_00' },
    { start: 3.1, end: 6.0, speaker: 'SPEAKER_01' },
  ];
  const result = mergeDiarizeSegments(segs);
  assert(result.length === 2, `expected 2 segments, got ${result.length}`);
});

test('does not merge same-speaker segments with gap >= 0.5s', () => {
  const segs = [
    { start: 0.0, end: 3.0, speaker: 'SPEAKER_00' },
    { start: 3.6, end: 6.0, speaker: 'SPEAKER_00' },
  ];
  const result = mergeDiarizeSegments(segs);
  assert(result.length === 2, `expected 2 segments, got ${result.length}`);
});

test('absorbs short segment flanked by same-speaker segments', () => {
  const segs = [
    { start: 0.0,  end: 5.0,  speaker: 'SPEAKER_00' },
    { start: 4.8,  end: 5.1,  speaker: 'SPEAKER_01' },
    { start: 5.1,  end: 10.0, speaker: 'SPEAKER_00' },
  ];
  const result = mergeDiarizeSegments(segs);
  assert(result.length === 1, `expected 1 segment after absorbing short segment, got ${result.length}`);
  assert(result[0].speaker === 'SPEAKER_00', 'merged segment should be SPEAKER_00');
});

test('does not absorb short segment flanked by different speakers', () => {
  const segs = [
    { start: 0.0, end: 3.0, speaker: 'SPEAKER_00' },
    { start: 3.0, end: 3.2, speaker: 'SPEAKER_01' },
    { start: 3.2, end: 6.0, speaker: 'SPEAKER_02' },
  ];
  const result = mergeDiarizeSegments(segs);
  assert(result.length === 3, `expected 3 segments, got ${result.length}`);
});

// --- Phase 5: midpoint assignment tests ---

console.log('\nMidpoint assignment tests\n');

test('midpoint assigns word to segment containing its midpoint', () => {
  // Word spans 3.0-5.0s, midpoint 4.0s, clearly inside SPEAKER_01 (3.0-6.0).
  const words = [{ text: 'inside', startMs: 3000, endMs: 5000 }];
  const segs = [
    { start: 0.0, end: 3.0, speaker: 'SPEAKER_00' },
    { start: 3.0, end: 6.0, speaker: 'SPEAKER_01' },
  ];
  const result = assignWordsToSpeakers(words, segs);
  assert(result[0].speaker === 'SPEAKER_01', `expected SPEAKER_01, got ${result[0].speaker}`);
});

test('falls back to max overlap when midpoint in no segment', () => {
  // Word spans 4.5-6.5s, midpoint 5.5s. Only segment covers 0-5.0.
  // Midpoint 5.5 not in any segment; overlap with SPEAKER_00: 4.5-5.0 = 0.5s.
  const words = [{ text: 'partial', startMs: 4500, endMs: 6500 }];
  const segs = [
    { start: 0.0, end: 5.0, speaker: 'SPEAKER_00' },
  ];
  const result = assignWordsToSpeakers(words, segs);
  assert(result[0].speaker === 'SPEAKER_00', `expected SPEAKER_00 via overlap fallback, got ${result[0].speaker}`);
});

// --- Phase 5: smoothSpeakerAssignments tests ---

console.log('\nsmoothSpeakerAssignments tests\n');

test('corrects isolated single-word misassignment', () => {
  const labeled = [
    { speaker: 'SPEAKER_00', text: 'Hello' },
    { speaker: 'SPEAKER_01', text: 'there,' },
    { speaker: 'SPEAKER_00', text: 'world.' },
  ];
  const result = smoothSpeakerAssignments(labeled);
  assert(result[1].speaker === 'SPEAKER_00', `expected SPEAKER_00 after smoothing, got ${result[1].speaker}`);
});

test('corrects two consecutive misassigned words', () => {
  const labeled = [
    { speaker: 'SPEAKER_00', text: 'Hello' },
    { speaker: 'SPEAKER_01', text: 'there' },
    { speaker: 'SPEAKER_01', text: 'friend,' },
    { speaker: 'SPEAKER_00', text: 'world.' },
  ];
  const result = smoothSpeakerAssignments(labeled);
  assert(result[1].speaker === 'SPEAKER_00', `word[1] should be corrected to SPEAKER_00, got ${result[1].speaker}`);
  assert(result[2].speaker === 'SPEAKER_00', `word[2] should be corrected to SPEAKER_00, got ${result[2].speaker}`);
});

test('corrects three consecutive misassigned words (with override)', () => {
  // Default smoothingMaxRunLen is 2; override to 3 for this test
  const labeled = [
    { speaker: 'SPEAKER_00', text: 'A' },
    { speaker: 'SPEAKER_01', text: 'B' },
    { speaker: 'SPEAKER_01', text: 'C' },
    { speaker: 'SPEAKER_01', text: 'D' },
    { speaker: 'SPEAKER_00', text: 'E' },
  ];
  const result = smoothSpeakerAssignments(labeled, { smoothingMaxRunLen: 3 });
  assert(result[1].speaker === 'SPEAKER_00', `word[1] should be SPEAKER_00, got ${result[1].speaker}`);
  assert(result[2].speaker === 'SPEAKER_00', `word[2] should be SPEAKER_00, got ${result[2].speaker}`);
  assert(result[3].speaker === 'SPEAKER_00', `word[3] should be SPEAKER_00, got ${result[3].speaker}`);
});

test('does not correct four consecutive misassigned words (beyond tolerance)', () => {
  const labeled = [
    { speaker: 'SPEAKER_00', text: 'A' },
    { speaker: 'SPEAKER_01', text: 'B' },
    { speaker: 'SPEAKER_01', text: 'C' },
    { speaker: 'SPEAKER_01', text: 'D' },
    { speaker: 'SPEAKER_01', text: 'E' },
    { speaker: 'SPEAKER_00', text: 'F' },
  ];
  const result = smoothSpeakerAssignments(labeled);
  assert(result[1].speaker === 'SPEAKER_01', `word[1] should remain SPEAKER_01`);
  assert(result[4].speaker === 'SPEAKER_01', `word[4] should remain SPEAKER_01`);
});

// --- Post-collapse mergeShortBlocks tests ---

console.log('\nmergeShortBlocks tests\n');

test('merges short interleaving block of 1 word', () => {
  const blocks = [
    { speaker: 'Speaker 1', text: 'Hello world' },
    { speaker: 'Speaker 2', text: 'and' },
    { speaker: 'Speaker 1', text: 'goodbye everyone' },
  ];
  const result = mergeShortBlocks(blocks);
  assert(result.length === 2, `expected 2 blocks, got ${result.length}`);
  assert(result[0].text === 'Hello world and', 'merged short block into first');
});

test('merges short interleaving block up to 3 words', () => {
  const blocks = [
    { speaker: 'Speaker 1', text: 'Hello' },
    { speaker: 'Speaker 2', text: 'one two three' },
    { speaker: 'Speaker 1', text: 'world' },
  ];
  const result = mergeShortBlocks(blocks);
  assert(result.length === 2, `expected 2 blocks, got ${result.length}`);
});

test('does not merge interleaving block > 3 words', () => {
  const blocks = [
    { speaker: 'Speaker 1', text: 'Hello' },
    { speaker: 'Speaker 2', text: 'one two three four' },
    { speaker: 'Speaker 1', text: 'world' },
  ];
  const result = mergeShortBlocks(blocks);
  assert(result.length === 3, `expected 3 blocks, got ${result.length}`);
});

test('does not merge when flanking speakers differ', () => {
  const blocks = [
    { speaker: 'Speaker 1', text: 'Hello' },
    { speaker: 'Speaker 2', text: 'hi' },
    { speaker: 'Speaker 3', text: 'world' },
  ];
  const result = mergeShortBlocks(blocks);
  assert(result.length === 3, `expected 3 blocks, got ${result.length}`);
});

// --- End-to-end fragmentation test ---

test('end-to-end: same-speaker fragmentation corrected by smoothing + block merge', () => {
  // Simulates a plausible real-world scenario:
  // Speaker A talks from 0-5s, but pyannote and whisper disagree at 3s,
  // causing a single word to be misassigned to Speaker B.
  // Smoothing should fix the single word, and if not, mergeShortBlocks catches it.
  const whisperJson = {
    transcription: [{
      offsets: { from: 0, to: 5000 },
      text: ' Hello world how are you today.',
      tokens: [
        { text: ' Hello',  offsets: { from: 0,    to: 1000 } },
        { text: ' world',  offsets: { from: 1000, to: 1900 } },
        { text: ' how',    offsets: { from: 1900, to: 2500 } },
        { text: ' are',    offsets: { from: 2500, to: 3100 } },
        { text: ' you',    offsets: { from: 3100, to: 3700 } },
        { text: ' today',  offsets: { from: 3700, to: 4900 } },
        { text: '.',       offsets: { from: 4900, to: 5000 } },
      ],
    }],
  };
  // Pyannote correctly says one speaker, but has a tiny segmentation glitch
  const diarize = [
    { start: 0.0, end: 5.0, speaker: 'SPEAKER_00' },
  ];
  const result = mergeTranscriptWithDiarization(whisperJson, diarize);
  assert(result.includes('[1 speaker detected]'), 'should detect 1 speaker');
  assert(result.includes('Hello world how are you today.'), 'all words in one block');
  // Should be one continuous block: header line + 1 speaker block
  const speakerBlocks = result.split('\n').filter(l => l.startsWith('[Speaker'));
  assert(speakerBlocks.length === 1, `expected 1 speaker block, got ${speakerBlocks.length}: ${result}`);
});

// --- Boundary refinement tests ---

console.log('\nrefineSpeakerBoundaries tests\n');

test('snaps boundary word to correct speaker via pyannote boundary', () => {
  // Two words: "hello" at 0-1s, "there" at 1-2s.
  // Pyannote boundary at 1.2s (speaker change).
  // Midpoint of "there" is 1.5s, past the boundary.
  // Midpoint of "hello" is 0.5s, before the boundary.
  // Without refinement, "there" could get prevSpeaker if timestamps drift.
  // With refinement, it snaps to the correct side of the pyannote boundary.
  const labeled = [
    { speaker: 'SPEAKER_00', text: 'Hello', wordMidSec: 0.5, isSegLevel: false },
    { speaker: 'SPEAKER_00', text: 'there', wordMidSec: 1.5, isSegLevel: false }, // misassigned (should be SPEAKER_01)
  ];
  const diarize = [
    { start: 0.0, end: 1.2, speaker: 'SPEAKER_00' },
    { start: 1.2, end: 3.0, speaker: 'SPEAKER_01' },
  ];
  const result = refineSpeakerBoundaries(labeled, diarize);
  assert(result[0].speaker === 'SPEAKER_00', 'first word stays SPEAKER_00');
  assert(result[1].speaker === 'SPEAKER_01', `second word should be SPEAKER_01, got ${result[1].speaker}`);
});

test('boundary refinement corrects drift at speaker change', () => {
  // Realistic scenario: words at a speaker change with DTW timestamp imprecision.
  // "world" (midpoint 2.75s) is assigned to SPEAKER_00 but should be SPEAKER_01
  // because pyannote says the speaker change is at 2.5s.
  const labeled = [
    { speaker: 'SPEAKER_00', text: 'Hello',  wordMidSec: 0.75,  isSegLevel: false },
    { speaker: 'SPEAKER_00', text: 'world',  wordMidSec: 2.75,  isSegLevel: false }, // drift
    { speaker: 'SPEAKER_01', text: 'goodbye', wordMidSec: 4.0,  isSegLevel: false },
  ];
  const diarize = [
    { start: 0.0, end: 2.5, speaker: 'SPEAKER_00' },
    { start: 2.5, end: 6.0, speaker: 'SPEAKER_01' },
  ];
  const result = refineSpeakerBoundaries(labeled, diarize);
  assert(result[1].speaker === 'SPEAKER_01', `drifted word should be SPEAKER_01, got ${result[1].speaker}`);
  assert(result[0].speaker === 'SPEAKER_00', 'first word stays SPEAKER_00');
  assert(result[2].speaker === 'SPEAKER_01', 'third word stays SPEAKER_01');
});

test('boundary refinement does not touch words far from boundary', () => {
  // Words at 10-11s are correctly assigned to SPEAKER_00 per pyannote (6.0-12.0).
  // The only boundary is at 3.0s (far away). Refinement should leave them alone.
  const labeled = [
    { speaker: 'SPEAKER_00', text: 'A', wordMidSec: 0.5,  isSegLevel: false },
    { speaker: 'SPEAKER_00', text: 'B', wordMidSec: 1.5,  isSegLevel: false },
    { speaker: 'SPEAKER_00', text: 'C', wordMidSec: 2.5,  isSegLevel: false },
    { speaker: 'SPEAKER_00', text: 'D', wordMidSec: 10.0, isSegLevel: false },
    { speaker: 'SPEAKER_00', text: 'E', wordMidSec: 11.0, isSegLevel: false },
  ];
  const diarize = [
    { start: 0.0, end: 3.0, speaker: 'SPEAKER_00' },
    { start: 3.0, end: 6.0, speaker: 'SPEAKER_01' },
    { start: 6.0, end: 12.0, speaker: 'SPEAKER_00' },
  ];
  const result = refineSpeakerBoundaries(labeled, diarize);
  // D/E at 10-11s are far from the 3.0s boundary.
  // The gap C→D is at (2.5+10)/2=6.25s, which is within 3s of the 6.0s boundary.
  // But since D/E are already SPEAKER_00 and the pyannote boundary at 6.0
  // says everything after 6.0 is SPEAKER_00, they should stay correct.
  assert(result[3].speaker === 'SPEAKER_00', 'word D should stay SPEAKER_00');
  assert(result[4].speaker === 'SPEAKER_00', 'word E should stay SPEAKER_00');
});

test('boundary refinement: end-to-end drift correction', () => {
  // Whisper tokens span a speaker change. Without refinement,
  // boundary words might drift. With refinement, the pyannote boundary
  // at 3.0s forces a clean split.
  const whisperJson = {
    transcription: [{
      offsets: { from: 0, to: 6000 },
      text: ' Hello world this is goodbye now.',
      tokens: [
        { text: ' Hello',   offsets: { from: 0,    to: 1200 } },
        { text: ' world',   offsets: { from: 1200, to: 2200 } },
        { text: ' this',    offsets: { from: 2200, to: 2800 } },
        { text: ' is',      offsets: { from: 2800, to: 3200 } }, // straddles boundary
        { text: ' goodbye', offsets: { from: 3200, to: 4600 } },
        { text: ' now',     offsets: { from: 4600, to: 5800 } },
        { text: '.',        offsets: { from: 5800, to: 6000 } },
      ],
    }],
  };
  const diarize = [
    { start: 0.0, end: 3.0, speaker: 'SPEAKER_00' },
    { start: 3.0, end: 6.0, speaker: 'SPEAKER_01' },
  ];
  const result = mergeTranscriptWithDiarization(whisperJson, diarize);
  // "is" has midpoint (2.8+3.2)/2 = 3.0s, right at the boundary.
  // Midpoint containment might assign it to either speaker depending on
  // floating-point, but boundary refinement should produce a clean split.
  assert(result.includes('[Speaker 1]'), 'has speaker 1');
  assert(result.includes('[Speaker 2]'), 'has speaker 2');
  const blocks = result.split('\n').filter(l => l.startsWith('[Speaker'));
  assert(blocks.length === 2, `expected 2 speaker blocks, got ${blocks.length}: ${result}`);
});

// --- Phase 2: config override test ---

console.log('\nConfig override tests\n');

test('mergeGapSec override changes merge behaviour', () => {
  // Two same-speaker segments with a 1.0s gap are normally separate
  const segs = [
    { start: 0.0, end: 3.0, speaker: 'SPEAKER_00' },
    { start: 4.0, end: 6.0, speaker: 'SPEAKER_00' },
  ];
  const defaultResult = mergeDiarizeSegments(segs);
  assert(defaultResult.length === 2, `default gap=0.5s should not merge 1.0s gap, got ${defaultResult.length}`);

  // With mergeGapSec=1.5, they should merge
  const overrideResult = mergeDiarizeSegments(segs, { ...DEFAULTS, mergeGapSec: 1.5 });
  assert(overrideResult.length === 1, `override gap=1.5s should merge, got ${overrideResult.length}`);
});

// --- Phase 4: 3-speaker boundary refinement tests ---

console.log('\n3-speaker boundary refinement tests\n');

test('3-speaker conversation A->B->C->A with correct labels', () => {
  // A speaks 0-3s, B speaks 3-6s, C speaks 6-9s, A speaks 9-12s
  const labeled = [
    { speaker: 'SPEAKER_00', text: 'A1', wordMidSec: 0.5,  isSegLevel: false },
    { speaker: 'SPEAKER_00', text: 'A2', wordMidSec: 1.5,  isSegLevel: false },
    { speaker: 'SPEAKER_00', text: 'A3', wordMidSec: 2.5,  isSegLevel: false },
    { speaker: 'SPEAKER_01', text: 'B1', wordMidSec: 3.5,  isSegLevel: false },
    { speaker: 'SPEAKER_01', text: 'B2', wordMidSec: 4.5,  isSegLevel: false },
    { speaker: 'SPEAKER_02', text: 'C1', wordMidSec: 6.5,  isSegLevel: false },
    { speaker: 'SPEAKER_02', text: 'C2', wordMidSec: 7.5,  isSegLevel: false },
    { speaker: 'SPEAKER_00', text: 'A4', wordMidSec: 9.5,  isSegLevel: false },
    { speaker: 'SPEAKER_00', text: 'A5', wordMidSec: 10.5, isSegLevel: false },
  ];
  const diarize = [
    { start: 0.0, end: 3.0,  speaker: 'SPEAKER_00' },
    { start: 3.0, end: 6.0,  speaker: 'SPEAKER_01' },
    { start: 6.0, end: 9.0,  speaker: 'SPEAKER_02' },
    { start: 9.0, end: 12.0,  speaker: 'SPEAKER_00' },
  ];
  const result = refineSpeakerBoundaries(labeled, diarize);
  // All labels should stay as they are — no drift to correct
  assert(result[3].speaker === 'SPEAKER_01', 'B1 should stay SPEAKER_01');
  assert(result[5].speaker === 'SPEAKER_02', 'C1 should stay SPEAKER_02');
  assert(result[7].speaker === 'SPEAKER_00', 'A4 should stay SPEAKER_00');
});

test('isolated third-speaker word at A->B boundary gets reassigned', () => {
  // A->B boundary at 3.0s. Word at index 1 is labelled C but is isolated
  // (no other C within 2s). Should be reassigned to A or B.
  const labeled = [
    { speaker: 'SPEAKER_00', text: 'A1', wordMidSec: 1.5, isSegLevel: false },
    { speaker: 'SPEAKER_02', text: 'X1', wordMidSec: 3.1, isSegLevel: false }, // isolated C
    { speaker: 'SPEAKER_01', text: 'B1', wordMidSec: 4.0, isSegLevel: false },
  ];
  const diarize = [
    { start: 0.0, end: 3.0, speaker: 'SPEAKER_00' },
    { start: 3.0, end: 6.0, speaker: 'SPEAKER_01' },
  ];
  const result = refineSpeakerBoundaries(labeled, diarize);
  // Isolated C word at index 1 should be reassigned
  assert(result[1].speaker !== 'SPEAKER_02', `isolated C should be reassigned, got ${result[1].speaker}`);
});

test('third-speaker word near other same-third-speaker words survives', () => {
  // A->B boundary at 3.0s. Word at index 1 is labelled C and has another
  // C word 0.5s away. Both should survive — genuine 3-way conversation.
  const labeled = [
    { speaker: 'SPEAKER_00', text: 'A1', wordMidSec: 1.5, isSegLevel: false },
    { speaker: 'SPEAKER_02', text: 'C1', wordMidSec: 2.9, isSegLevel: false },
    { speaker: 'SPEAKER_02', text: 'C2', wordMidSec: 3.3, isSegLevel: false },
    { speaker: 'SPEAKER_01', text: 'B1', wordMidSec: 4.0, isSegLevel: false },
  ];
  const diarize = [
    { start: 0.0, end: 3.0, speaker: 'SPEAKER_00' },
    { start: 3.0, end: 6.0, speaker: 'SPEAKER_01' },
  ];
  const result = refineSpeakerBoundaries(labeled, diarize);
  // Both C words should survive — they form a cluster near the boundary
  assert(result[1].speaker === 'SPEAKER_02', `C1 should survive, got ${result[1].speaker}`);
  assert(result[2].speaker === 'SPEAKER_02', `C2 should survive, got ${result[2].speaker}`);
});

test('rapid back-and-forth with distinct turn markers at each utterance', () => {
  // A speaks 0-2s, B speaks 2-3s, A speaks 3-5s, B speaks 5-7s.
  // With broad boundary snap windows, close boundaries can cause
  // over-correction. But we should see at least 2 distinct speaker
  // turns and no data loss.
  const whisperJson = {
    transcription: [{
      offsets: { from: 0, to: 7000 },
      text: ' Hello there yes indeed goodbye now.',
      tokens: [
        { text: ' Hello',   offsets: { from: 0,    to: 800  } },
        { text: ' there',   offsets: { from: 800,  to: 1800 } },
        { text: ' yes',     offsets: { from: 2000, to: 2700 } },
        { text: ' indeed',  offsets: { from: 3000, to: 4700 } },
        { text: ' goodbye', offsets: { from: 5000, to: 5800 } },
        { text: ' now',     offsets: { from: 5800, to: 6900 } },
        { text: '.',        offsets: { from: 6900, to: 7000 } },
      ],
    }],
  };
  const diarize = [
    { start: 0.0, end: 2.0, speaker: 'SPEAKER_00' },
    { start: 2.0, end: 3.0, speaker: 'SPEAKER_01' },
    { start: 3.0, end: 5.0, speaker: 'SPEAKER_00' },
    { start: 5.0, end: 7.0, speaker: 'SPEAKER_01' },
  ];
  const result = mergeTranscriptWithDiarization(whisperJson, diarize);
  assert(result.includes('[2 speakers detected]'), 'should detect 2 speakers');
  // Both speakers appear, and all words are present
  assert(result.includes('[Speaker 1]'), 'should have Speaker 1');
  assert(result.includes('[Speaker 2]'), 'should have Speaker 2');
  assert(result.includes('Hello'), 'all words present');
  assert(result.includes('goodbye'), 'all words present');
});

// --- Phase 5: duration-aware short-block merge tests ---

console.log('\nDuration-aware mergeShortBlocks tests\n');

test('3-word block lasting 0.8s is merged (short duration)', () => {
  const blocks = [
    { speaker: 'Speaker 1', text: 'Hello world', startSec: 0.0, endSec: 1.0 },
    { speaker: 'Speaker 2', text: 'one two three', startSec: 1.1, endSec: 1.9 },
    { speaker: 'Speaker 1', text: 'goodbye', startSec: 2.0, endSec: 2.5 },
  ];
  const result = mergeShortBlocks(blocks);
  assert(result.length === 2, `expected 2 blocks (0.8s merged), got ${result.length}`);
});

test('3-word block lasting 4.0s is NOT merged (long duration)', () => {
  const blocks = [
    { speaker: 'Speaker 1', text: 'Hello world', startSec: 0.0, endSec: 1.0 },
    { speaker: 'Speaker 2', text: 'one two three', startSec: 1.1, endSec: 5.1 },
    { speaker: 'Speaker 1', text: 'goodbye', startSec: 5.2, endSec: 6.0 },
  ];
  const result = mergeShortBlocks(blocks);
  assert(result.length === 3, `expected 3 blocks (4s duration kept), got ${result.length}`);
});

test('block with no timing info falls back to word-count-only behaviour', () => {
  // No startSec/endSec — should use word count only (3 words -> merge)
  const blocks = [
    { speaker: 'Speaker 1', text: 'Hello world' },
    { speaker: 'Speaker 2', text: 'one two three' },
    { speaker: 'Speaker 1', text: 'goodbye' },
  ];
  const result = mergeShortBlocks(blocks);
  assert(result.length === 2, `expected 2 blocks (no timing fallback), got ${result.length}`);
});

test('4-word block lasting 0.5s is NOT merged (too many words)', () => {
  const blocks = [
    { speaker: 'Speaker 1', text: 'Hello world', startSec: 0.0, endSec: 1.0 },
    { speaker: 'Speaker 2', text: 'one two three four', startSec: 1.1, endSec: 1.6 },
    { speaker: 'Speaker 1', text: 'goodbye', startSec: 1.7, endSec: 2.0 },
  ];
  const result = mergeShortBlocks(blocks);
  assert(result.length === 3, '4-word block should not merge regardless of duration');
});

// --- End-to-end with overlapping input ---

console.log('\nEnd-to-end overlapping test\n');

test('overlapping segments in end-to-end pipeline', () => {
  const whisperJson = {
    transcription: [{
      offsets: { from: 0, to: 8000 },
      text: ' Hello world this is a test now.',
      tokens: [
        { text: ' Hello', offsets: { from: 0,    to: 1500 } },
        { text: ' world', offsets: { from: 1500, to: 3000 } },
        { text: ' this',  offsets: { from: 3000, to: 4000 } },
        { text: ' is',    offsets: { from: 4000, to: 4500 } },
        { text: ' a',     offsets: { from: 4500, to: 5000 } },
        { text: ' test',  offsets: { from: 5000, to: 6000 } },
        { text: ' now',   offsets: { from: 6000, to: 7800 } },
        { text: '.',      offsets: { from: 7800, to: 8000 } },
      ],
    }],
  };
  // Overlapping diarization: both speakers claim 3-5s
  const diarize = [
    { start: 0.0, end: 5.0, speaker: 'SPEAKER_00' },
    { start: 3.0, end: 8.0, speaker: 'SPEAKER_01' },
  ];
  const result = mergeTranscriptWithDiarization(whisperJson, diarize);
  assert(result.includes('[2 speakers detected]'), 'should detect 2 speakers');
  // Pipeline should not crash or produce garbled output
  assert(result.includes('[Speaker'), 'should contain speaker labels');
});

// --- nearestSegMaxDistSec threshold tests ---

test('nearest-segment fallback assigns word within 5s of a segment', () => {
  // Word at 6.5s, nearest segment ends at 5.0s — distance 1.5s, within default 5s limit.
  const words = [{ text: 'hello', startMs: 6000, endMs: 7000 }];
  const segs = [{ start: 0.0, end: 5.0, speaker: 'SPEAKER_00' }];
  const result = assignWordsToSpeakers(words, segs);
  assert(result[0].speaker === 'SPEAKER_00', `expected SPEAKER_00, got ${result[0].speaker}`);
});

test('nearest-segment fallback withholds assignment when word is >= 5s from all segments', () => {
  // Word at 12.0s, nearest segment ends at 5.0s — distance 7.0s, beyond default 5s limit.
  const words = [{ text: 'hello', startMs: 12000, endMs: 13000 }];
  const segs = [{ start: 0.0, end: 5.0, speaker: 'SPEAKER_00' }];
  const result = assignWordsToSpeakers(words, segs);
  assert(result[0].speaker === null, `expected null speaker, got ${result[0].speaker}`);
});

test('nearestSegMaxDistSec override is respected', () => {
  // Same word at 12.0s, but override raises the threshold to 10s — should now assign.
  const words = [{ text: 'hello', startMs: 12000, endMs: 13000 }];
  const segs = [{ start: 0.0, end: 5.0, speaker: 'SPEAKER_00' }];
  const result = assignWordsToSpeakers(words, segs, { ...DEFAULTS, nearestSegMaxDistSec: 10.0 });
  assert(result[0].speaker === 'SPEAKER_00', `expected SPEAKER_00, got ${result[0].speaker}`);
});

// --- _nearBoundary prevents smoothing tests ---

test('smoothing does not change a _nearBoundary-flagged word flanked by same speaker', () => {
  // A A [B flagged _nearBoundary] A — smoothing must not flip B back to A.
  const words = [
    { speaker: 'SPEAKER_00', text: 'w1', isSegLevel: false, _nearBoundary: false },
    { speaker: 'SPEAKER_00', text: 'w2', isSegLevel: false, _nearBoundary: false },
    { speaker: 'SPEAKER_01', text: 'w3', isSegLevel: false, _nearBoundary: true },
    { speaker: 'SPEAKER_00', text: 'w4', isSegLevel: false, _nearBoundary: false },
  ];
  const result = smoothSpeakerAssignments(words);
  assert(result[2].speaker === 'SPEAKER_01', `_nearBoundary word should not be smoothed, got ${result[2].speaker}`);
});

// --- isSegLevel exclusion in smoothing tests ---

test('smoothing does not absorb a run containing an isSegLevel entry', () => {
  // A [seg-level B] A — the seg-level entry should not be corrected to A.
  const words = [
    { speaker: 'SPEAKER_00', text: 'w1', isSegLevel: false, _nearBoundary: false },
    { speaker: 'SPEAKER_01', text: 'whole segment', isSegLevel: true,  _nearBoundary: false },
    { speaker: 'SPEAKER_00', text: 'w3', isSegLevel: false, _nearBoundary: false },
  ];
  const result = smoothSpeakerAssignments(words);
  assert(result[1].speaker === 'SPEAKER_01', `isSegLevel entry should not be smoothed, got ${result[1].speaker}`);
});

test('smoothing does not use an isSegLevel entry as the flanking anchor', () => {
  // [seg-level A] B A — the seg-level A should not serve as left anchor, so B stays B.
  const words = [
    { speaker: 'SPEAKER_00', text: 'seg', isSegLevel: true,  _nearBoundary: false },
    { speaker: 'SPEAKER_01', text: 'w2', isSegLevel: false, _nearBoundary: false },
    { speaker: 'SPEAKER_00', text: 'w3', isSegLevel: false, _nearBoundary: false },
  ];
  const result = smoothSpeakerAssignments(words);
  // left is isSegLevel so the left anchor check fires and smoothing skips; w2 must stay SPEAKER_01
  assert(result[1].speaker === 'SPEAKER_01', `isSegLevel left anchor must be skipped, got ${result[1].speaker}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
