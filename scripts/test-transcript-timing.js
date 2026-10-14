#!/usr/bin/env node
/**
 * Word timing normalisation (lib/transcript-timing.js).
 *
 * Covers every worked example of design decision D1: grouping, DTW anchors,
 * ordinary offsets, segment fallback, invalid values and preserved text.
 * No audio, models or Python needed.
 *
 * Usage:
 *     node scripts/test-transcript-timing.js
 */

const {
  normaliseWhisperWords, groupTokens, wordPointMs,
  alignmentLanguage, buildAlignmentInput, applyForcedAlignment,
} = require('../lib/transcript-timing');

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

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label || 'value'}: expected ${e}, got ${a}`);
}

function tok(text, from, to, tDtw) {
  const t = { text };
  if (from !== undefined && from !== null) t.offsets = { from, to };
  if (tDtw !== undefined) t.t_dtw = tDtw;
  return t;
}

function seg(from, to, tokens) {
  return { offsets: { from, to }, text: tokens.map((t) => t.text).join(''), tokens };
}

function words(...segments) {
  return normaliseWhisperWords({ transcription: segments }).words;
}

// --- Grouping ---

console.log('Grouping\n');

test('first token without a leading space still starts a word', () => {
  eq(groupTokens([tok('Hello', 0, 500), tok(' world', 500, 1000)]).map((w) => w.text), ['Hello', 'world']);
});

test('punctuation and contractions join the current word', () => {
  eq(groupTokens([tok(' I', 0, 200), tok("'m", 200, 400), tok(' fine', 400, 800), tok('.', 800, 900)])
    .map((w) => w.text), ["I'm", 'fine.']);
});

test('Whisper control tokens are skipped', () => {
  eq(groupTokens([{ text: '[_BEG_]' }, tok(' Hello', 0, 500), { text: '[_TT_5]' }, tok(' world', 500, 1000)])
    .map((w) => w.text), ['Hello', 'world']);
});

test('leading punctuation token starts the word it belongs to', () => {
  eq(groupTokens([tok(' "', 0, 0, 20), tok('Yes', 0, 400, 21), tok('."', 400, 500, 22)]).map((w) => w.text), ['"Yes."']);
});

test('sub-word tokens form one word with the first token anchor', () => {
  const w = words(seg(1000, 2000, [tok(' Green', 1000, 1300, 120), tok('land', 1300, 1500, 135), tok('.', 1500, 1500, 150), tok(' Yes', 1600, 1900, 160)]));
  eq(w.map((x) => x.text), ['Greenland.', 'Yes']);
  eq([w[0].startMs, w[0].endMs, w[0].anchorMs, w[0].timingSource, w[0].timingQuality], [1200, 1600, 1200, 'dtw', 'anchor']);
});

// --- DTW anchors ---

console.log('\nDTW anchors\n');

test('different valid anchors change the selected word times', () => {
  const a = words(seg(0, 1000, [tok(' Hello.', 0, 800, 10), tok(' Bye.', 800, 1000, 90)]));
  const b = words(seg(0, 1000, [tok(' Hello.', 0, 800, 40), tok(' Bye.', 800, 1000, 90)]));
  assert(a[0].startMs === 100 && b[0].startMs === 400, `${a[0].startMs} vs ${b[0].startMs}`);
});

test('valid zero anchor is kept', () => {
  const w = words(seg(0, 500, [tok(' Hi', 0, 400, 0)]));
  eq([w[0].anchorMs, w[0].startMs, w[0].timingSource], [0, 0, 'dtw']);
});

test('-1 anchor means absent; ordinary offsets used with a fallback reason when DTW ran elsewhere', () => {
  const w = words(seg(0, 2000, [tok(' One', 0, 400, 5), tok(' two', 400, 600, -1), tok(' three', 800, 1200, 85)]));
  eq([w[1].timingSource, w[1].timingQuality, w[1].timingFallback, w[1].startMs, w[1].endMs],
    ['token', 'estimated', 'dtw-anchor-missing', 400, 600]);
  eq(w[0].endMs, null, 'end is null when the next word has no anchor');
});

test('no DTW anywhere means no DTW fallback reason', () => {
  const w = words(seg(0, 1000, [tok(' One', 0, 400, -1), tok(' two', 400, 900, -1)]));
  eq(w.map((x) => x.timingFallback), [null, null]);
  eq(w.map((x) => x.timingSource), ['token', 'token']);
});

test('non-finite or negative anchors are invalid', () => {
  const w = words(seg(0, 1000, [tok(' A', 0, 300, 2), tok(' B', 300, 600, NaN), tok(' C', 600, 900, -5)]));
  eq(w.map((x) => x.timingFallback), [null, 'dtw-anchor-invalid', 'dtw-anchor-invalid']);
  eq(w.map((x) => x.timingSource), ['dtw', 'token', 'token']);
});

test('anchor earlier than the previous DTW word is rejected as non-monotonic', () => {
  const w = words(seg(0, 1000, [tok(' A', 0, 300, 50), tok(' B', 300, 600, 30), tok(' C', 600, 900, 70)]));
  eq(w.map((x) => x.timingSource), ['dtw', 'token', 'dtw']);
  eq(w[1].timingFallback, 'dtw-anchor-non-monotonic');
});

test('final word ends at the segment end when it is later than the anchor', () => {
  const w = words(seg(0, 1100, [tok(' A', 0, 300, 10), tok(' B', 300, 1000, 90)]));
  eq([w[1].startMs, w[1].endMs], [900, 1100]);
});

test('final word uses the next segment anchor when the segment end is not later', () => {
  const w = words(
    seg(0, 900, [tok(' A', 0, 300, 10), tok(' B', 300, 900, 95)]),
    seg(900, 2000, [tok(' C', 1300, 1600, 130)]),
  );
  eq([w[1].startMs, w[1].endMs], [950, 1300]);
  eq(w[2].endMs, 2000);
});

test('missing duration stays explicit and the point falls back to the anchor', () => {
  const w = words(seg(0, 900, [tok(' A', 0, 300, 95)]));
  eq([w[0].startMs, w[0].endMs], [950, null]);
  eq(wordPointMs(w[0]), 950);
  eq(normaliseWhisperWords({ transcription: [seg(0, 900, [tok(' A', 0, 300, 95)])] }).summary.missingEnd, 1);
});

test('anchors across segments are absolute (seek already applied)', () => {
  const w = words(
    seg(0, 30000, [tok(' early', 100, 400, 10)]),
    seg(30000, 31000, [tok(' late', 30000, 30500, 3005)]),
  );
  eq([w[0].segmentIndex, w[1].segmentIndex, w[1].startMs], [0, 1, 30050]);
});

test('DTW words are assigned at their anchor, not the derived span midpoint', () => {
  const w = words(seg(0, 2000, [tok(' A', 0, 300, 10), tok(' B', 300, 600, 150)]));
  eq([w[0].startMs, w[0].endMs, wordPointMs(w[0])], [100, 1500, 100]);
});

test('token-timed words use the span midpoint', () => {
  const w = words(seg(0, 2000, [tok(' A', 200, 600)]));
  eq(wordPointMs(w[0]), 400);
});

// --- Ordinary offsets and segment fallback ---

console.log('\nOrdinary offsets and segment fallback\n');

test('token span uses first valid from and last valid to', () => {
  const w = words(seg(0, 1000, [tok(' Good', 0, 500), tok('bye', null)]));
  eq([w[0].text, w[0].startMs, w[0].endMs], ['Goodbye', 0, 500]);
});

test('reversed token offsets are invalid; segment timing used', () => {
  const w = words(seg(4000, 5000, [tok(' Yes', 800, 500)]));
  eq([w[0].timingSource, w[0].timingFallback, w[0].startMs, w[0].endMs], ['segment', 'token-offsets-invalid', 4000, 5000]);
});

test('negative token offsets are invalid; segment timing used', () => {
  const w = words(seg(4000, 5000, [tok(' Yes.', -10, -10)]));
  eq([w[0].timingSource, w[0].startMs], ['segment', 4000]);
});

test('tokens without offsets fall back to the segment span', () => {
  const w = words(seg(0, 4000, [tok(' No', null, null, -1), tok(' timestamps', null, null, -1)]));
  eq(w.map((x) => x.timingSource), ['segment', 'segment']);
  eq(w[0].timingFallback, 'token-offsets-missing');
  eq(wordPointMs(w[0]), 2000);
});

test('segment without tokens is split on whitespace with segment timing', () => {
  const w = normaliseWhisperWords({ transcription: [{ offsets: { from: 0, to: 3000 }, text: ' Hello there.' }] }).words;
  eq(w.map((x) => [x.text, x.timingSource, x.startMs, x.endMs]), [['Hello', 'segment', 0, 3000], ['there.', 'segment', 0, 3000]]);
});

test('invalid segment offsets and no tokens give no timing', () => {
  const w = normaliseWhisperWords({ transcription: [{ offsets: { from: 500, to: 100 }, text: ' Lost' }] }).words;
  eq([w[0].timingSource, w[0].timingQuality, w[0].timingFallback, w[0].startMs], ['none', 'missing', 'segment-offsets-invalid', null]);
});

test('empty and whitespace-only segments produce no words', () => {
  const w = normaliseWhisperWords({ transcription: [{ offsets: { from: 0, to: 1000 }, text: '   ' }, { offsets: { from: 0, to: 1000 }, text: '' }] }).words;
  eq(w.length, 0);
});

// --- Text preservation and summary ---

console.log('\nText preservation and summary\n');

test('recognised text and order are unchanged by normalisation', () => {
  const segments = [
    seg(0, 2000, [{ text: '[_BEG_]' }, tok(' The', 0, 200, 0), tok(' U', 200, 300, 20), tok('.S', 300, 400, 30), tok('.', 400, 400, 40), tok(' $12', 500, 900, 50), tok('.6', 900, 1100, 90)]),
    seg(2000, 3000, [tok(' trillion,', 2000, 2500, -1), tok(' right?', 2500, 3000, 250)]),
  ];
  const text = segments.map((s) => s.tokens.filter((t) => !t.text.startsWith('[_')).map((t) => t.text).join('')).join('').trim();
  const w = words(...segments);
  eq(w.map((x) => x.text).join(' '), text);
  eq(w.map((x) => x.index), [0, 1, 2, 3, 4]);
});

test('summary counts sources, qualities and fallbacks', () => {
  const { summary } = normaliseWhisperWords({ transcription: [
    seg(0, 1000, [tok(' A', 0, 300, 2), tok(' B', 300, 600, -1)]),
    { offsets: { from: 1000, to: 2000 }, text: ' C' },
  ] });
  eq(summary.bySource, { dtw: 1, token: 1, segment: 1 });
  eq(summary.byQuality, { anchor: 1, estimated: 1, segment: 1 });
  eq(summary.fallbacks, { 'dtw-anchor-missing': 1, 'token-offsets-missing': 1 });
});

// --- Forced alignment helpers (D3) ---

console.log('\nForced alignment helpers\n');

function twoSegments() {
  return { result: { language: 'en' }, transcription: [
    seg(0, 1000, [tok(' Hello,', 0, 400, -1), tok(' world', 400, 900, -1)]),
    seg(1000, 2000, [tok(' $12', 1000, 1300, -1), tok('.6', 1300, 1500, -1), tok(' trillion.', 1500, 1900, -1)]),
  ] };
}

test('alignment language: .en models force en, otherwise Whisper result, auto is unknown', () => {
  eq(alignmentLanguage({ result: { language: 'fr' } }, 'small.en'), 'en');
  eq(alignmentLanguage({ result: { language: 'fr' } }, 'small'), 'fr');
  eq(alignmentLanguage({ result: { language: 'auto' } }, 'small'), null);
  eq(alignmentLanguage({}, 'large-v3'), null);
});

test('alignment input holds each segment\'s words in order with its window', () => {
  const json = twoSegments();
  const { words } = normaliseWhisperWords(json);
  const input = buildAlignmentInput(words, json, { language: 'en' });
  eq(input, { language: 'en', padMs: 200, segments: [
    { index: 0, startMs: 0, endMs: 1000, words: ['Hello,', 'world'] },
    { index: 1, startMs: 1000, endMs: 2000, words: ['$12.6', 'trillion.'] },
  ] });
});

test('alignment input uses timed word span when segment offsets are invalid, skips untimed segments', () => {
  const json = { transcription: [
    { offsets: { from: 900, to: 100 }, text: ' a b', tokens: [tok(' a', 200, 300), tok(' b', 300, 500)] },
    { text: ' lost words', tokens: [tok(' lost'), tok(' words')] },
  ] };
  const { words } = normaliseWhisperWords(json);
  eq(buildAlignmentInput(words, json, { language: 'en', padMs: 0 }).segments, [{ index: 0, startMs: 200, endMs: 500, words: ['a', 'b'] }]);
});

test('applying alignment marks measured, interpolated and unaligned words', () => {
  const json = twoSegments();
  const { words } = normaliseWhisperWords(json);
  const alignment = { segments: [
    { index: 0, status: 'aligned', words: [
      { startMs: 120, endMs: 380, score: 0.9, quality: 'measured' },
      { startMs: 410, endMs: 800, score: null, quality: 'interpolated' },
    ] },
    { index: 1, status: 'aligned', words: [
      { startMs: null, endMs: null, score: null, quality: 'unaligned' },
      { startMs: 1500, endMs: 1880, score: 0.7, quality: 'measured' },
    ] },
  ] };
  const { words: out, summary } = applyForcedAlignment(words, alignment);
  eq(out.map((w) => w.text), words.map((w) => w.text), 'text unchanged');
  eq(out.map((w) => [w.timingSource, w.timingQuality, w.timingFallback]), [
    ['forced', 'measured', null], ['forced', 'interpolated', null],
    ['token', 'estimated', 'alignment-unaligned'], ['forced', 'measured', null],
  ]);
  eq([out[0].startMs, out[0].endMs, wordPointMs(out[0])], [120, 380, 250]);
  eq(summary.bySource, { forced: 3, token: 1 });
});

test('missing segment, malformed entries and null alignment keep Whisper timing', () => {
  const json = twoSegments();
  const { words } = normaliseWhisperWords(json);
  const partial = applyForcedAlignment(words, { segments: [
    { index: 0, words: [{ startMs: 500, endMs: 100, quality: 'measured' }, { startMs: 'x', endMs: 2, quality: 'measured' }] },
  ] }).words;
  eq(partial.map((w) => w.timingSource), ['token', 'token', 'token', 'token']);
  eq(partial.map((w) => w.timingFallback), Array(4).fill('alignment-unaligned'));
  const none = applyForcedAlignment(words, null).words;
  eq(none, words, 'null alignment returns words unchanged');
});

test('pre-timed words can be passed straight to speaker assignment', () => {
  const { assignSpeakers } = require('../lib/diarize-merge');
  const json = twoSegments();
  const { words } = normaliseWhisperWords(json);
  const timed = applyForcedAlignment(words, { segments: [{ index: 0, words: [
    { startMs: 100, endMs: 300, quality: 'measured' }, { startMs: 1200, endMs: 1400, quality: 'measured' },
  ] }] });
  const r = assignSpeakers(timed, [{ start: 0, end: 1.0, speaker: 'A' }, { start: 1.0, end: 2.0, speaker: 'B' }]);
  eq(r.words.map((w) => w.speakerId), ['A', 'B', 'B', 'B']);
  eq(r.summary.timing.bySource, { forced: 2, token: 2 });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
