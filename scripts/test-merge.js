#!/usr/bin/env node
/**
 * Transcript + diarisation merge regressions.
 *
 * Tests assignSpeakers() / mergeTranscriptWithDiarization() with sample
 * data -- no Python, no models, no HF token needed. Runs instantly.
 *
 * Retired 2026-10-14 (design decision D1): tests that required segment
 * absorption, boundary snapping, smoothing and short-block merging. Those
 * stages rewrote correctly supported words (investigation cases 3, 4 and 7
 * in docs/diarization-investigation.md), so they were removed rather than
 * tuned. Word grouping tests moved to scripts/test-transcript-timing.js.
 *
 * Usage:
 *     node scripts/test-merge.js
 */

const {
  DEFAULTS,
  normaliseSpeakerTimeline,
  assignSpeakers,
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

/** One segment whose tokens are [text, fromMs, toMs, tDtw?] tuples. */
function tokensJson(tokens) {
  const toks = tokens.map(([text, from, to, tDtw]) => ({
    text: ' ' + text,
    offsets: { from, to },
    ...(tDtw === undefined ? {} : { t_dtw: tDtw }),
  }));
  return {
    transcription: [{
      offsets: { from: tokens[0][1], to: tokens[tokens.length - 1][2] },
      text: toks.map((t) => t.text).join(''),
      tokens: toks,
    }],
  };
}

/** Formatted transcript -> [[label, text], ...] in order. */
function blocksOf(text) {
  return text.split('\n\n').slice(1).filter(Boolean).map((b) => {
    const m = /^\[([^\]]+)\] (.*)$/s.exec(b);
    return [m[1], m[2]];
  });
}

function sameBlocks(actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`expected ${e}, got ${a}`);
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

// --- Word-level end-to-end tests ---

console.log('\nWord-level end-to-end tests\n');

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

test('rapid back-and-forth keeps every turn in order', () => {
  const whisperJson = tokensJson([
    ['Hello', 0, 800], ['there', 800, 1800], ['yes', 2000, 2700],
    ['indeed', 3000, 4700], ['goodbye', 5000, 5800], ['now.', 5800, 6900],
  ]);
  const diarize = [
    { start: 0.0, end: 2.0, speaker: 'SPEAKER_00' },
    { start: 2.0, end: 3.0, speaker: 'SPEAKER_01' },
    { start: 3.0, end: 5.0, speaker: 'SPEAKER_00' },
    { start: 5.0, end: 7.0, speaker: 'SPEAKER_01' },
  ];
  sameBlocks(blocksOf(mergeTranscriptWithDiarization(whisperJson, diarize)), [
    ['Speaker 1', 'Hello there'], ['Speaker 2', 'yes'],
    ['Speaker 1', 'indeed'], ['Speaker 2', 'goodbye now.'],
  ]);
});

test('word straddling a shared boundary goes to the side holding its midpoint', () => {
  // "is" spans 2800-3300, midpoint 3050 -> B. Boundary 3000 belongs to B only.
  const whisperJson = tokensJson([
    ['Hello', 0, 1200], ['this', 2200, 2800], ['is', 2800, 3300], ['goodbye.', 3300, 4600],
  ]);
  const diarize = [
    { start: 0.0, end: 3.0, speaker: 'A' },
    { start: 3.0, end: 6.0, speaker: 'B' },
  ];
  sameBlocks(blocksOf(mergeTranscriptWithDiarization(whisperJson, diarize)), [
    ['Speaker 1', 'Hello this'], ['Speaker 2', 'is goodbye.'],
  ]);
});

test('exact shared boundary: midpoint equal to interval end belongs to the next speaker', () => {
  const whisperJson = tokensJson([['one', 0, 1000], ['two', 2800, 3200], ['three', 4000, 5000]]);
  const diarize = [{ start: 0, end: 3.0, speaker: 'A' }, { start: 3.0, end: 6.0, speaker: 'B' }];
  const r = assignSpeakers(whisperJson, diarize);
  assert(r.words[1].evidence.pointMs === 3000, `point ${r.words[1].evidence.pointMs}`);
  assert(r.words[1].speakerId === 'B', `got ${r.words[1].speakerId}`);
  assert(r.words[1].assignment === 'supported', r.words[1].assignment);
});

test('boundary handling does not depend on how many words surround it', () => {
  const diarize = [{ start: 0, end: 3.0, speaker: 'A' }, { start: 3.0, end: 6.0, speaker: 'B' }];
  const few = assignSpeakers(tokensJson([['a', 2900, 3000], ['b', 3000, 3100]]), diarize);
  const many = assignSpeakers(tokensJson([
    ['w1', 0, 500], ['w2', 500, 1000], ['w3', 1000, 1500], ['w4', 1500, 2000], ['w5', 2000, 2500],
    ['a', 2900, 3000], ['b', 3000, 3100],
    ['w6', 3500, 4000], ['w7', 4000, 4500], ['w8', 4500, 5000], ['w9', 5000, 5500],
  ]), diarize);
  assert(few.words[0].speakerId === 'A' && few.words[1].speakerId === 'B', 'few words');
  assert(many.words[5].speakerId === 'A' && many.words[6].speakerId === 'B', 'many words');
});

// --- Investigation regressions (docs/diarization-investigation.md) ---

console.log('\nInvestigation regressions\n');

test('case 1: different valid DTW anchors change the assigned speaker', () => {
  const diarize = [{ start: 0, end: 1.0, speaker: 'A' }, { start: 1.0, end: 3.0, speaker: 'B' }];
  // Ordinary offsets put both words in A; DTW anchors put the second in B.
  const early = tokensJson([['Hello.', 0, 400, 10], ['Again.', 400, 800, 30], ['End.', 800, 900, 50]]);
  const late = tokensJson([['Hello.', 0, 400, 10], ['Again.', 400, 800, 150], ['End.', 800, 900, 250]]);
  assert(assignSpeakers(early, diarize).words[1].speakerId === 'A', 'early anchor -> A');
  assert(assignSpeakers(late, diarize).words[1].speakerId === 'B', 'late anchor -> B');
});

test('case 2: a correctly timed 600 ms reply survives (A/B/A)', () => {
  const json = tokensJson([['Ready?', 0, 800], ['Yes.', 1000, 1500], ['Continue.', 2000, 2800]]);
  const speakers = [
    { start: 0, end: 0.9, speaker: 'A' },
    { start: 1, end: 1.6, speaker: 'B' },
    { start: 2, end: 3, speaker: 'A' },
  ];
  const text = mergeTranscriptWithDiarization(json, speakers);
  assert(text.startsWith('[2 speakers detected]'), text);
  sameBlocks(blocksOf(text), [['Speaker 1', 'Ready?'], ['Speaker 2', 'Yes.'], ['Speaker 1', 'Continue.']]);
});

test('case 3: a correctly timed 200 ms reply survives (A/B/A)', () => {
  const json = tokensJson([['Ready?', 0, 800], ['Yes.', 1000, 1150], ['Continue.', 1250, 2000]]);
  const speakers = [
    { start: 0, end: 0.9, speaker: 'A' },
    { start: 1, end: 1.2, speaker: 'B' },
    { start: 1.2, end: 2.1, speaker: 'A' },
  ];
  const text = mergeTranscriptWithDiarization(json, speakers);
  assert(text.startsWith('[2 speakers detected]'), text);
  sameBlocks(blocksOf(text), [['Speaker 1', 'Ready?'], ['Speaker 2', 'Yes.'], ['Speaker 1', 'Continue.']]);
});

test('case 4: A-only speech after nested B overlap stays A', () => {
  const json = tokensJson([['Before.', 0, 500], ['During.', 2200, 2600], ['After.', 4000, 4500]]);
  const speakers = [{ start: 0, end: 10, speaker: 'A' }, { start: 2, end: 3, speaker: 'B' }];
  const r = assignSpeakers(json, speakers);
  assert(r.words[2].speakerId === 'A' && r.words[2].assignment === 'supported', 'After. -> supported A');
  assert(r.words[1].assignment === 'ambiguous', `During. should be ambiguous, got ${r.words[1].assignment}`);
  sameBlocks(r.words[1].evidence.candidates.slice().sort(), ['A', 'B']);
  assert(r.words[1].speakerId === 'A', 'ambiguous word keeps the continuing speaker');
});

test('case 5: invalid DTW anchors (-1) leave ordinary token offsets in charge', () => {
  const json = tokensJson([['Hello.', 0, 800, -1], ['Goodbye.', 2000, 2800, -1]]);
  const speakers = [{ start: 0, end: 1, speaker: 'A' }, { start: 1, end: 3, speaker: 'B' }];
  const r = assignSpeakers(json, speakers);
  sameBlocks(blocksOf(r.text), [['Speaker 1', 'Hello.'], ['Speaker 2', 'Goodbye.']]);
  assert(r.words.every((w) => w.timingSource === 'token'), 'token timing');
  assert(r.words.every((w) => w.timingFallback === null), 'no DTW fallback reported when DTW is absent');
});

test('case 6: negative token times fall back to valid segment times', () => {
  const speakers = [{ start: 0, end: 1, speaker: 'A' }, { start: 4, end: 5, speaker: 'B' }];
  const segment = {
    text: ' Yes.',
    offsets: { from: 4000, to: 5000 },
    tokens: [{ text: ' Yes.', offsets: { from: -10, to: -10 } }],
  };
  const r = assignSpeakers({ transcription: [segment] }, speakers);
  assert(r.words[0].timingSource === 'segment', r.words[0].timingSource);
  assert(r.words[0].timingFallback === 'token-offsets-invalid', r.words[0].timingFallback);
  sameBlocks(blocksOf(r.text), [['Speaker 2', 'Yes.']]);
});

test('case 7: Unknown beyond the gap distance survives formatting', () => {
  const json = tokensJson([['Before.', 100, 800], ['Unsupported.', 10000, 10500], ['After.', 20100, 20800]]);
  const speakers = [{ start: 0, end: 1, speaker: 'A' }, { start: 20, end: 21, speaker: 'A' }];
  const r = assignSpeakers(json, speakers);
  sameBlocks(blocksOf(r.text), [['Speaker 1', 'Before.'], ['Unknown', 'Unsupported.'], ['Speaker 1', 'After.']]);
  assert(r.words[1].assignment === 'unknown', r.words[1].assignment);
});

// --- Gaps, overlap and exclusive timelines ---

console.log('\nGaps, overlap and exclusive timelines\n');

test('gap fill within the declared distance is recorded', () => {
  const json = tokensJson([['hello', 6000, 7000]]);
  const r = assignSpeakers(json, [{ start: 0.0, end: 5.0, speaker: 'S0' }]);
  assert(r.words[0].speakerId === 'S0', r.words[0].speakerId);
  assert(r.words[0].assignment === 'gap-filled', r.words[0].assignment);
  assert(r.words[0].evidence.distanceMs === 1500, `distance ${r.words[0].evidence.distanceMs}`);
});

test('gap fill is withheld at or beyond gapFillMaxMs', () => {
  const json = tokensJson([['hello', 12000, 13000]]);
  const r = assignSpeakers(json, [{ start: 0.0, end: 5.0, speaker: 'S0' }]);
  assert(r.words[0].speakerId === null && r.words[0].speaker === 'Unknown', r.words[0].speaker);
  const wider = assignSpeakers(json, [{ start: 0.0, end: 5.0, speaker: 'S0' }], { gapFillMaxMs: 10000 });
  assert(wider.words[0].speakerId === 'S0', 'override respected');
  assert(DEFAULTS.gapFillMaxMs === 5000, 'declared default');
});

test('gap tie goes to the speaker that ended before the word', () => {
  const json = tokensJson([['mid', 1400, 1600]]);
  const r = assignSpeakers(json, [{ start: 0, end: 1.0, speaker: 'A' }, { start: 2.0, end: 3.0, speaker: 'B' }]);
  assert(r.words[0].speakerId === 'A', r.words[0].speakerId);
});

test('point in a gap but span touching speech uses span overlap', () => {
  // Word 800-2000, point 1400 in the gap; overlaps A by 200 ms, B by 0.
  const json = tokensJson([['long', 800, 2000]]);
  const r = assignSpeakers(json, [{ start: 0, end: 1.0, speaker: 'A' }, { start: 2.0, end: 3.0, speaker: 'B' }]);
  assert(r.words[0].speakerId === 'A' && r.words[0].evidence.method === 'overlap', JSON.stringify(r.words[0].evidence));
  assert(r.words[0].assignment === 'supported', r.words[0].assignment);
});

test('regular overlap is ambiguous and records candidates', () => {
  const json = tokensJson([['Hello', 0, 1500], ['world', 1500, 3000], ['this', 3500, 4200], ['is', 4200, 4600], ['test', 6000, 7000]]);
  const diarize = [{ start: 0.0, end: 5.0, speaker: 'S0' }, { start: 3.0, end: 8.0, speaker: 'S1' }];
  const r = assignSpeakers(json, diarize);
  assert(r.timeline === 'regular', r.timeline);
  assert(r.words[2].assignment === 'ambiguous' && r.words[3].assignment === 'ambiguous', 'overlap words ambiguous');
  assert(r.words[4].speakerId === 'S1' && r.words[4].assignment === 'supported', 'after overlap -> S1 supported');
  assert(r.summary.assignment.ambiguous === 2, JSON.stringify(r.summary.assignment));
});

test('exclusive timeline decides the speaker; regular adds overlap evidence', () => {
  const json = tokensJson([['Hello', 0, 1500], ['this', 3500, 4200], ['test', 6000, 7000]]);
  const regular = [{ start: 0.0, end: 5.0, speaker: 'S0' }, { start: 3.0, end: 8.0, speaker: 'S1' }];
  const exclusive = [{ start: 0.0, end: 3.5, speaker: 'S0' }, { start: 3.5, end: 8.0, speaker: 'S1' }];
  const r = assignSpeakers(json, { regular, exclusive });
  assert(r.timeline === 'exclusive', r.timeline);
  assert(r.words[1].speakerId === 'S1' && r.words[1].assignment === 'supported', JSON.stringify(r.words[1]));
  sameBlocks(r.words[1].evidence.overlapSpeakers.slice().sort(), ['S0', 'S1']);
  sameBlocks(blocksOf(r.text), [['Speaker 1', 'Hello'], ['Speaker 2', 'this test']]);
});

test('empty exclusive timeline falls back to regular, legacy array is regular', () => {
  const json = tokensJson([['Hi', 0, 500]]);
  const regular = [{ start: 0, end: 1, speaker: 'S0' }];
  assert(assignSpeakers(json, { regular, exclusive: [] }).timeline === 'regular', 'empty exclusive');
  assert(assignSpeakers(json, { regular, exclusive: null }).timeline === 'regular', 'null exclusive');
  assert(assignSpeakers(json, regular).timeline === 'regular', 'legacy array');
});

// --- Formatting and structure ---

console.log('\nFormatting and structured result\n');

test('no duplicate adjacent blocks and no phantom speakers', () => {
  const json = tokensJson([['a', 0, 400], ['b', 500, 900], ['c', 1000, 1400], ['d', 1500, 1900]]);
  const diarize = [
    { start: 0, end: 0.45, speaker: 'A' }, { start: 0.45, end: 0.95, speaker: 'A' },
    { start: 0.95, end: 1.45, speaker: 'B' }, { start: 1.45, end: 2.0, speaker: 'B' },
  ];
  const text = mergeTranscriptWithDiarization(json, diarize);
  assert(text.startsWith('[2 speakers detected]'), text);
  sameBlocks(blocksOf(text), [['Speaker 1', 'a b'], ['Speaker 2', 'c d']]);
});

test('malformed speaker intervals are dropped and counted', () => {
  const { intervals, dropped } = normaliseSpeakerTimeline([
    { start: 0, end: 1, speaker: 'A' },
    { start: 2, end: 2, speaker: 'A' },
    { start: 3, end: 2, speaker: 'B' },
    { start: NaN, end: 4, speaker: 'B' },
    { start: 4, end: 5 },
    { start: -1, end: 1, speaker: 'C' },
  ]);
  assert(intervals.length === 1 && dropped === 5, `${intervals.length} kept, ${dropped} dropped`);
});

test('structured result keeps text, order, timing and evidence for every word', () => {
  const json = tokensJson([['Ready?', 0, 800, 5], ['Yes.', 1000, 1500, 102], ['Go.', 2000, 2800, 205]]);
  const speakers = [{ start: 0, end: 0.9, speaker: 'A' }, { start: 1, end: 1.6, speaker: 'B' }, { start: 2, end: 3, speaker: 'A' }];
  const r = assignSpeakers(json, speakers);
  assert(r.version === 1, 'version');
  sameBlocks(r.words.map((w) => w.text), ['Ready?', 'Yes.', 'Go.']);
  sameBlocks(r.words.map((w) => w.timingSource), ['dtw', 'dtw', 'dtw']);
  sameBlocks(r.words.map((w) => w.anchorMs), [50, 1020, 2050]);
  sameBlocks(r.words.map((w) => w.assignment), ['supported', 'supported', 'supported']);
  sameBlocks(r.speakers, [{ id: 'A', label: 'Speaker 1' }, { id: 'B', label: 'Speaker 2' }]);
  assert(r.blocks.length === 3 && r.blocks[1].firstWord === 1 && r.blocks[1].lastWord === 1, JSON.stringify(r.blocks));
  assert(r.summary.timing.bySource.dtw === 3, JSON.stringify(r.summary.timing));
  assert(r.text === mergeTranscriptWithDiarization(json, speakers), 'wrapper returns the same text');
});

test('words without any timing are Unknown, not guessed', () => {
  const json = { transcription: [{ text: ' Floating words', tokens: [{ text: ' Floating' }, { text: ' words' }] }] };
  const r = assignSpeakers(json, [{ start: 0, end: 5, speaker: 'A' }]);
  assert(r.words.every((w) => w.timingSource === 'none' && w.assignment === 'unknown'), JSON.stringify(r.words));
  sameBlocks(blocksOf(r.text), [['Unknown', 'Floating words']]);
});

test('assignmentPoint "start" uses word onset (evaluation variant)', () => {
  const json = tokensJson([['word', 800, 1400]]);
  const diarize = [{ start: 0, end: 1.0, speaker: 'A' }, { start: 1.0, end: 2.0, speaker: 'B' }];
  assert(assignSpeakers(json, diarize).words[0].speakerId === 'B', 'midpoint 1100 -> B');
  assert(assignSpeakers(json, diarize, { assignmentPoint: 'start' }).words[0].speakerId === 'A', 'start 800 -> A');
});

// --- Summary ---

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
