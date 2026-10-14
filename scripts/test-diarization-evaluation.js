#!/usr/bin/env node
/**
 * Diarisation evaluation harness tests (scripts/evaluate-diarization.js).
 *
 * All data here is synthetic and invented for the tests. No audio, models,
 * Python or private examples are needed. Runs in about a second.
 *
 * Usage:
 *     node scripts/test-diarization-evaluation.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const E = require('./evaluate-diarization');

const SCRIPT = path.join(__dirname, 'evaluate-diarization.js');
const EXAMPLE = path.join(__dirname, 'fixtures', 'diarization', 'evaluation-example.json');

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

function same(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ? msg + ': ' : ''}expected ${e}, got ${a}`);
}

function throwsEval(fn, pattern) {
  try {
    fn();
  } catch (e) {
    assert(e instanceof E.EvalError, `expected EvalError, got ${e.constructor.name}: ${e.message}`);
    assert(pattern.test(e.message), `message "${e.message}" does not match ${pattern}`);
    return;
  }
  throw new Error('expected an error');
}

// --- Synthetic data helpers ---

/** Whisper full JSON from segments of [text, fromMs, toMs] words. */
function whisperFrom(segs) {
  return {
    result: { language: 'en' },
    transcription: segs.map((ws) => ({
      offsets: { from: ws[0][1], to: ws[ws.length - 1][2] },
      text: ws.map((w) => ' ' + w[0]).join(''),
      tokens: ws.map(([t, from, to]) => ({ text: ' ' + t, offsets: { from, to } })),
    })),
  };
}

/** Space words evenly from startMs, 300 ms each. */
function timed(text, startMs) {
  return text.split(' ').map((w, i) => [w, startMs + i * 300, startMs + i * 300 + 280]);
}

// A small invented conversation: A talks, B replies briefly, A again, B again.
const TURNS = [
  { label: 'Unknown', text: '(music) Invented intro jingle.' },
  { label: 'Speaker 1', text: 'Welcome to the invented test show about counting.' },
  { label: 'Speaker 2', text: 'Yes, indeed.' },
  { label: 'Speaker 1', text: 'Tell me how many beans are in the jar.' },
  { label: 'Speaker 2', text: 'There are seven hundred beans in the jar today.' },
];

const SEGS = [
  timed('Welcome to the invented test show about counting.', 2000), // 8 words, 2000-4380
  timed('Yes, indeed.', 5000), // 5000-5580
  timed('Tell me how many beans are in the jar.', 6000), // 9 words, 6000-8680
  timed('There are seven hundred beans in the jar today.', 9000), // 9 words, 9000-11680
];

const GOOD = [
  { start: 1.9, end: 4.5, speaker: 'A' },
  { start: 4.9, end: 5.7, speaker: 'B' },
  { start: 5.9, end: 8.8, speaker: 'A' },
  { start: 8.9, end: 12.0, speaker: 'B' },
];

// The short reply is absorbed into A, as the retired merge stages used to do.
const ABSORBED = [
  { start: 1.9, end: 8.8, speaker: 'A' },
  { start: 8.9, end: 12.0, speaker: 'B' },
];

function score({ turns = TURNS, segs = SEGS, diar = GOOD, timeline, timing = null, alignment = null, inserted = [], config = null, scoring = E.SCORING_DEFAULTS } = {}) {
  const ref = E.buildReferenceModel(turns.map((t, i) => ({ turn: i + 1, ...t })), scoring, inserted);
  let diarization = null;
  if (Array.isArray(diar)) diarization = { regular: diar, exclusive: null };
  else if (diar) diarization = diar;
  return E.scoreVariant({ ref, scoring, whisperJson: whisperFrom(segs), diarization, alignment, config, timeline, timing });
}

function renameSpeakers(list, names) {
  return list.map((iv) => ({ ...iv, speaker: names[iv.speaker] }));
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'diar-eval-test-'));
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(args, opts = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', ...opts });
}

/** Write a minimal file-based manifest into dir and return its path. */
function writeManifestDir(dir, { refSha, schema = E.MANIFEST_SCHEMA, variants } = {}) {
  const refFile = path.join(dir, 'ref.txt');
  fs.writeFileSync(refFile, '[2 speakers detected]\n\n[Speaker 1] Hello there friend.\n\n[Speaker 2] Hi.\n');
  fs.writeFileSync(path.join(dir, 'whisper.json'), JSON.stringify(whisperFrom([timed('Hello there friend.', 0), timed('Hi.', 2000)])));
  fs.writeFileSync(path.join(dir, 'diar.json'), JSON.stringify([{ start: 0, end: 1.5, speaker: 'X' }, { start: 1.9, end: 3, speaker: 'Y' }]));
  const manifest = {
    schema,
    version: 1,
    synthetic: true,
    normalisation: { id: E.NORMALISATION_ID },
    recordings: [{
      id: 'tmp',
      split: 'tune',
      audio: null,
      reference: { path: 'ref.txt', sha256: refSha || sha(refFile), format: 'speaker-labelled-text' },
      timing: null,
      variants: variants || [{ id: 'v', whisper: 'whisper.json', diarization: 'diar.json' }],
    }],
  };
  const file = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return file;
}

// --- Reference parsing and normalisation ---

console.log('Reference parsing and normalisation\n');

test('malformed header is ignored and speakers come from the labels', () => {
  const p = E.parseSpeakerLabelledText('[pp3 speakers detected]\n\n[Unknown] (music) Intro.\n\n[Speaker 1] One.\n\n[Speaker 3] Two.\n\n[Speaker 1] Three.\n');
  same(p.header, { line: 1, text: '[pp3 speakers detected]', ignored: true });
  same(p.turns.map((t) => t.label), ['Unknown', 'Speaker 1', 'Speaker 3', 'Speaker 1']);
  const ref = E.buildReferenceModel(p.turns, E.SCORING_DEFAULTS);
  same(ref.speakers, ['Speaker 1', 'Speaker 3'], 'inventory from labels, Unknown excluded, header count ignored');
  same(ref.excludedTurns, [1]);
});

test('multiline labelled turns keep order, line range and text (CRLF too)', () => {
  const src = '[Speaker 1]  First line of the turn\nwraps onto a second\r\nand a third line.\r\n\r\n[Speaker 2] Reply.\n';
  const p = E.parseSpeakerLabelledText(src);
  same(p.turns.length, 2);
  same(p.turns[0].lines, [1, 3]);
  same(p.turns[0].text, 'First line of the turn\nwraps onto a second\nand a third line.');
  same(E.normaliseText(p.turns[0].text), ['first', 'line', 'of', 'the', 'turn', 'wraps', 'onto', 'a', 'second', 'and', 'a', 'third', 'line']);
  same(p.turns[1].lines, [5, 5]);
});

test('text before the first label is an error, not silently dropped', () => {
  throwsEval(() => E.parseSpeakerLabelledText('Stray text\n[Speaker 1] Hello.'), /line 1: text before the first speaker label/);
});

test('parenthesised and bracketed cues are removed', () => {
  same(E.normaliseText('(music) Hello (laughs) there [inaudible] friend (two word cue) end'), ['hello', 'there', 'friend', 'end']);
  // A cue split across Whisper words is dropped as a whole and counted.
  const r = score({ segs: [[['(upbeat', 0, 100], ['music)', 100, 200], ['Welcome', 2000, 2200]]], diar: null });
  same(r.denominators.whisperWordsDroppedByNormalisation, 2);
  same(r.denominators.recognisedWords, 1);
});

test('an unclosed cue cannot swallow the next turn', () => {
  const ref = E.buildReferenceModel([{ label: 'Speaker 1', text: 'Broken (cue here' }, { label: 'Speaker 2', text: 'Next turn.' }], E.SCORING_DEFAULTS);
  same(ref.words.map((w) => w.text), ['broken', 'next', 'turn']);
});

test('numbers, currency, hyphens and apostrophes follow the stated rules', () => {
  same(E.normaliseText('About $12.6 trillion, or 10%.'), ['about', '126', 'trillion', 'or', '10']);
  same(E.normaliseText("That's the 'quoted' sell-off, isn\u2019t it?"), ["that's", 'the', 'quoted', 'sell', 'off', "isn't", 'it']);
  same(E.normaliseText('non-European / mixed'), ['non', 'european', 'mixed']);
});

// --- Text alignment ---

console.log('\nText alignment\n');

test('mismatch, insertion and deletion are handled with correct denominators', () => {
  const ops = E.alignWords(['a', 'b', 'c', 'd', 'e'], ['a', 'x', 'c', 'e', 'f']);
  same(ops.map((o) => o.op), ['match', 'sub', 'match', 'del', 'match', 'ins']);
  const turns = [{ label: 'Speaker 1', text: 'alpha bravo charlie delta echo' }];
  const r = score({ turns, segs: [timed('alpha xray charlie echo foxtrot', 0)], diar: [{ start: 0, end: 5, speaker: 'A' }] });
  same(r.denominators.referenceWords, 5);
  same(r.denominators.recognisedWords, 5);
  same(r.denominators.matchedWords, 3);
  same(r.denominators.substitutedWords, 1);
  same(r.denominators.deletedReferenceWords, 1);
  same(r.denominators.insertedRecognisedWords, 1);
  same(r.metrics.text.coverage, 0.6);
  same(r.metrics.text.textWordErrorRate, 0.6);
  same(r.metrics.speaker.scoredWords, 3, 'speaker scoring uses matched words only');
});

test('word pairing ignores timing: shifting every time changes no text count', () => {
  const shifted = SEGS.map((s) => s.map(([t, a, b]) => [t, a + 100000, b + 100000]));
  const a = score({ diar: null });
  const b = score({ segs: shifted, diar: null });
  same(b.denominators, a.denominators);
  same(b.metrics.turnCoverage, a.metrics.turnCoverage);
});

// --- Speaker scoring ---

console.log('\nSpeaker scoring\n');

test('correct assignment scores zero error with full counts', () => {
  const r = score();
  same(r.metrics.speaker.scoredWords, 28);
  same(r.metrics.speaker.correct, 28);
  same(r.metrics.speaker.wordSpeakerErrorRate, 0);
  same(r.mapping.map((m) => [m.hypSpeakerId, m.referenceLabel]), [['A', 'Speaker 1'], ['B', 'Speaker 2']]);
});

test('renaming hypothesis speaker IDs does not change any score', () => {
  const a = score();
  const b = score({ diar: renameSpeakers(GOOD, { A: 'zz-last', B: 'aa-first' }) });
  same(b.metrics, a.metrics);
  same(b.denominators, a.denominators);
  same(b.mapping.map((m) => m.referenceLabel), a.mapping.map((m) => m.referenceLabel));
});

test('deliberately wrong assignment is detected', () => {
  const swapped = [
    { start: 1.9, end: 4.5, speaker: 'A' },
    { start: 4.9, end: 5.7, speaker: 'B' },
    { start: 5.9, end: 8.8, speaker: 'B' }, // wrong: Speaker 1's question given to B
    { start: 8.9, end: 12.0, speaker: 'B' },
  ];
  const r = score({ diar: swapped });
  assert(r.metrics.speaker.wordSpeakerErrorRate > 0, JSON.stringify(r.metrics.speaker));
  same(r.metrics.speaker.wrong, 9);
});

test('short reply retained with good timeline, lost when absorbed', () => {
  const good = score();
  same(good.metrics.shortTurns.turns, 1);
  same(good.metrics.shortTurns.retained, 1);
  same(good.metrics.shortTurns.detail[0].turn, 3);
  const bad = score({ diar: ABSORBED });
  same(bad.metrics.shortTurns.retained, 0);
  same(bad.metrics.shortTurns.lostTurns, [3]);
  assert(bad.metrics.speaker.wrong === 2, 'both reply words wrong');
});

test('inserted-clip turns are included in short-turn retention', () => {
  const r = score({ inserted: [5] });
  same(r.metrics.shortTurns.detail.map((t) => [t.turn, t.reason]), [[3, ['short']], [5, ['inserted-clip']]]);
  throwsEval(() => score({ inserted: [99] }), /no reference turn 99/);
});

test('Unknown reference turn is excluded from speaker scoring but reported', () => {
  const segs = [timed('Invented intro jingle.', 0), ...SEGS];
  const r = score({ segs });
  same(r.denominators.referenceWordsScored, 28);
  same(r.denominators.matchedWords, 31);
  same(r.denominators.matchedWordsScored, 28);
  same(r.metrics.speaker.scoredWords, 28);
  const t1 = r.metrics.turnCoverage[0];
  same([t1.turn, t1.label, t1.excluded, t1.words, t1.matched, t1.correct, t1.wrong], [1, 'Unknown', true, 3, 3, 0, 0]);
});

test('hypothesis Unknown counts as unknown, not as an error', () => {
  // B's last turn is missing from the timeline and far from A: words become Unknown.
  const diar = [{ start: 1.9, end: 4.5, speaker: 'A' }, { start: 4.9, end: 5.7, speaker: 'B' }];
  const segs = [...SEGS.slice(0, 2), timed('Tell me how many beans are in the jar.', 20000), timed('There are seven hundred beans in the jar today.', 30000)];
  const r = score({ diar, segs });
  same(r.metrics.speaker.unknown, 18);
  same(r.metrics.speaker.wrong, 0);
  same(r.metrics.speaker.wordSpeakerErrorRate, 0);
  same(r.metrics.speaker.unknownRate, round(18 / 28));
});

test('ambiguous words are counted separately (regular overlap)', () => {
  const diar = [...GOOD, { start: 9.0, end: 9.6, speaker: 'A' }]; // overlaps B's first words
  const r = score({ diar });
  assert(r.metrics.speaker.ambiguous === 2, JSON.stringify(r.metrics.speaker));
  same(r.metrics.speaker.ambiguousRate, round(2 / 28));
  same(r.metrics.diariserOverlap.flagged.words, 2);
  same(r.assignmentSummary.ambiguous, 2);
});

test('exclusive timeline is used when requested; missing exclusive is an error', () => {
  const env = { regular: [...GOOD, { start: 9.0, end: 9.6, speaker: 'A' }], exclusive: GOOD };
  const r = score({ diar: env, timeline: 'exclusive' });
  same(r.timeline, { requested: 'exclusive', used: 'exclusive' });
  same(r.metrics.speaker.ambiguous, 0);
  same(r.metrics.diariserOverlap.flagged.words, 2, 'regular overlap still recorded as evidence');
  const reg = score({ diar: env, timeline: 'regular' });
  same(reg.timeline.used, 'regular');
  throwsEval(() => score({ diar: { regular: GOOD, exclusive: null }, timeline: 'exclusive' }), /exclusive timeline/);
});

test('turn with zero coverage is flagged', () => {
  const segs = [SEGS[0], SEGS[2], SEGS[3]]; // the recogniser dropped the reply
  const r = score({ segs });
  same(r.metrics.zeroCoverageTurns, [1, 3]);
  same(r.metrics.shortTurns.notRecognisedTurns, [3]);
  same(r.metrics.shortTurns.retained, 0);
  same(r.metrics.shortTurns.recognisedTurns, 0);
});

test('more hypothesis speakers than reference labels: extra speaker is unmapped and wrong', () => {
  // B's last turn is split: its first five words stay B, the last four go to C.
  const diar = [
    { start: 1.9, end: 4.5, speaker: 'A' },
    { start: 4.9, end: 5.7, speaker: 'B' },
    { start: 5.9, end: 8.8, speaker: 'A' },
    { start: 8.9, end: 10.4, speaker: 'B' },
    { start: 10.4, end: 12.0, speaker: 'C' },
  ];
  const r = score({ diar });
  same(r.mapping.map((m) => [m.hypSpeakerId, m.referenceLabel, m.agreedWords]), [['A', 'Speaker 1', 17], ['B', 'Speaker 2', 7], ['C', null, 0]]);
  same(r.metrics.speaker.wrong, 4);
  same(r.metrics.speaker.wrongFromUnmappedSpeakers, 4);
});

test('mapping is optimal, not greedy', () => {
  same(E.maxWeightAssignment([[5, 4, 0], [4, 0, 0], [0, 0, 1]]), [1, 0, 2]);
  same(E.maxWeightAssignment([[1, 9], [8, 2], [7, 7]]), [1, 0, -1]);
  same(E.maxWeightAssignment([]), []);
});

test('no diarization: coverage reported, speaker metrics null with reason', () => {
  const r = score({ diar: null });
  same(r.metrics.speaker, null);
  same(r.mapping, null);
  same(r.metrics.text.coverage, round(28 / 31));
  for (const k of ['speaker', 'shortTurns', 'nearChange', 'diariserOverlap', 'mapping']) {
    assert(r.missing.some((m) => m.metric === k && m.reason === 'no diarization output'), k);
  }
  same(r.metrics.turnCoverage[1].correct, null);
});

test('errors near speaker changes are separated from errors elsewhere', () => {
  const r = score({ diar: ABSORBED });
  // The two-word reply sits entirely within 3 words of a change.
  same(r.metrics.nearChange.near.wrong, 2);
  same(r.metrics.nearChange.elsewhere.wrong, 0);
  same(r.metrics.nearChange.near.words + r.metrics.nearChange.elsewhere.words, 28);
});

test('forced alignment output is applied before assignment', () => {
  const alignment = {
    format: 'transcriber-alignment', version: 1,
    segments: SEGS.map((ws, index) => ({ index, status: 'aligned', reason: null, words: ws.map(([, a, b]) => ({ startMs: a + 10, endMs: b - 10, score: 0.9, quality: 'measured' })) })),
  };
  const r = score({ alignment });
  same(r.timingSummary.bySource, { forced: 28 });
  same(r.metrics.speaker.wordSpeakerErrorRate, 0);
});

// --- Timing ---

console.log('\nTiming metrics\n');

test('timing metrics are null with a reason when there is no annotation', () => {
  const r = score();
  same(r.metrics.timing, { wordStartError: null, timeWeightedSpeakerError: null, referenceOverlapWords: null, der: null });
  for (const k of ['timing.wordStartError', 'timing.timeWeightedSpeakerError', 'timing.referenceOverlapWords', 'timing.der']) {
    assert(r.missing.some((m) => m.metric === k && m.reason === 'no independent timing annotation'), k);
  }
});

test('a synthetic timing annotation produces word start error and time-weighted error', () => {
  const timing = {
    turns: [
      { start: 2.0, end: 4.4, speaker: 'Speaker 1' },
      { start: 5.0, end: 5.6, speaker: 'Speaker 2' },
      { start: 6.0, end: 8.7, speaker: 'Speaker 1' },
      { start: 8.6, end: 11.7, speaker: 'Speaker 2' }, // 100 ms reference overlap
    ],
    words: [
      { turn: 2, word: 0, text: 'Welcome', startMs: 1900 }, // hyp 2000: +100
      { turn: 3, word: 0, text: 'yes', startMs: 5050 }, // hyp 5000: -50
      { turn: 4, word: 1, startMs: 6300 }, // hyp 6300: 0
      { turn: 5, word: 0, text: 'There', startMs: 8650 }, // hyp 9000: +350, inside reference overlap
    ],
  };
  const r = score({ timing });
  const w = r.metrics.timing.wordStartError;
  same([w.annotatedWords, w.scored, w.signedMedianMs, w.absMedianMs, w.absP95Ms], [4, 4, 50, 75, 350]);
  const t = r.metrics.timing.timeWeightedSpeakerError;
  assert(t && typeof t.rate === 'number' && /Not DER/.test(t.definition), JSON.stringify(t));
  same(t.referenceOverlapSec, 0.1);
  same(r.metrics.timing.referenceOverlapWords.overlapped.words, 1);
  assert(!('diarizationErrorRate' in t), 'homegrown measure is not labelled DER');
  same(r.metrics.timing.der, null);
  assert(r.missing.some((m) => m.metric === 'timing.der' && /not requested/.test(m.reason)), 'DER missing with reason');
});

test('timing annotation whose text does not match the reference word is an error', () => {
  const timing = { turns: [], words: [{ turn: 2, word: 0, text: 'Goodbye', startMs: 1900 }] };
  throwsEval(() => score({ timing }), /text does not match turn 2 word 0/);
  throwsEval(() => score({ timing: { words: [{ turn: 2, word: 50, startMs: 1 }] } }), /turn 2 has no word 50/);
});

// --- Manifest and CLI ---

console.log('\nManifest and CLI\n');

test('checksum mismatch fails clearly with a non-zero exit', () => {
  const dir = tmpDir();
  const m = writeManifestDir(dir, { refSha: '0'.repeat(64) });
  const r = run(['--manifest', m, '--output', path.join(dir, 'out.json'), '--quiet']);
  assert(r.status === 1, `exit ${r.status}`);
  assert(/checksum mismatch for ref\.txt/.test(r.stderr), r.stderr);
  assert(!fs.existsSync(path.join(dir, 'out.json')), 'no report written');
});

test('schema mismatch fails clearly', () => {
  const dir = tmpDir();
  const m = writeManifestDir(dir, { schema: 'something-else' });
  const r = run(['--manifest', m, '--output', path.join(dir, 'out.json')]);
  assert(r.status === 1 && /manifest schema is "something-else"/.test(r.stderr), r.stderr);
});

test('missing variant file and unknown config key fail clearly', () => {
  const dir = tmpDir();
  let m = writeManifestDir(dir, { variants: [{ id: 'v', whisper: 'nope.json', diarization: null }] });
  let r = run(['--manifest', m, '--output', path.join(dir, 'out.json')]);
  assert(r.status === 1 && /whisper not found: nope\.json/.test(r.stderr), r.stderr);
  m = writeManifestDir(dir, { variants: [{ id: 'v', whisper: 'whisper.json', config: { smoothing: true } }] });
  r = run(['--manifest', m, '--output', path.join(dir, 'out.json')]);
  assert(r.status === 1 && /unknown config key "smoothing"/.test(r.stderr), r.stderr);
});

test('usage errors exit 2', () => {
  const r = run(['--bogus']);
  assert(r.status === 2 && /unknown argument/.test(r.stderr), r.stderr);
});

test('file-based manifest evaluates, and env vars supply paths', () => {
  const dir = tmpDir();
  const m = writeManifestDir(dir);
  const out = path.join(dir, 'out.json');
  const env = { ...process.env, DIARIZATION_EVAL_MANIFEST: m, DIARIZATION_EVAL_REPORT: out };
  const r = run(['--quiet', '--no-timestamp'], { env });
  assert(r.status === 0, r.stderr);
  const rep = JSON.parse(fs.readFileSync(out, 'utf8'));
  same(rep.schema, E.REPORT_SCHEMA);
  assert(!('generatedAt' in rep), '--no-timestamp omits generatedAt');
  same(rep.recordings[0].referenceSummary.speakers, ['Speaker 1', 'Speaker 2']);
  same(rep.recordings[0].referenceSummary.headerIgnored, true);
  same(rep.recordings[0].variants[0].metrics.speaker.wordSpeakerErrorRate, 0);
});

test('import-reference writes checksums, parsed turns and rules, and never edits the source', () => {
  const dir = tmpDir();
  const text = path.join(dir, 'gold.txt');
  const audio = path.join(dir, 'audio.bin');
  fs.writeFileSync(text, '[pp3 speakers detected]\n\n[Unknown] (music) Jingle.\n\n[Speaker 1]  Hello\nthere.\n\n[Speaker 2] Hi.\n');
  fs.writeFileSync(audio, Buffer.from([1, 2, 3, 4]));
  const before = sha(text);
  const out = path.join(dir, 'sub', 'manifest.json');
  let r = run(['import-reference', '--text', text, '--audio', audio, '--out', out, '--id', 'gold']);
  assert(r.status === 0, r.stderr);
  same(sha(text), before, 'source unchanged');
  const m = JSON.parse(fs.readFileSync(out, 'utf8'));
  const rec = m.recordings[0];
  same([m.schema, m.version, m.normalisation.id], [E.MANIFEST_SCHEMA, 1, E.NORMALISATION_ID]);
  same(rec.reference.path, '../gold.txt');
  same(rec.reference.sha256, before);
  same(rec.audio.sha256, sha(audio));
  same(rec.reference.parsed.speakers, ['Speaker 1', 'Speaker 2']);
  same(rec.reference.parsed.header.ignored, true);
  same(rec.reference.parsed.turns.map((t) => [t.turn, t.label, t.lines, t.words]), [
    [1, 'Unknown', [3, 3], ['jingle']], [2, 'Speaker 1', [5, 6], ['hello', 'there']], [3, 'Speaker 2', [8, 8], ['hi']],
  ]);
  same(m.scoring.excludedLabels, ['Unknown']);
  assert(m.normalisation.rules.some((x) => /\$ , and %/.test(x)), 'number rule stated');

  r = run(['import-reference', '--text', text, '--audio', audio, '--out', out]);
  assert(r.status === 1 && /exists; pass --force/.test(r.stderr), 'refuses to overwrite');
  r = run(['import-reference', '--text', text, '--audio', audio, '--out', out, '--id', 'gold-2', '--split', 'heldout', '--append']);
  assert(r.status === 0, r.stderr);
  same(JSON.parse(fs.readFileSync(out, 'utf8')).recordings.map((x) => [x.id, x.split]), [['gold', 'tune'], ['gold-2', 'heldout']]);
});

test('stored turns that disagree with the reference file are rejected', () => {
  const dir = tmpDir();
  const text = path.join(dir, 'gold.txt');
  const audio = path.join(dir, 'audio.bin');
  fs.writeFileSync(text, '[Speaker 1] Hello.\n\n[Speaker 2] Hi.\n');
  fs.writeFileSync(audio, 'x');
  const out = path.join(dir, 'manifest.json');
  assert(run(['import-reference', '--text', text, '--audio', audio, '--out', out]).status === 0);
  const m = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.writeFileSync(path.join(dir, 'w.json'), JSON.stringify(whisperFrom([timed('Hello.', 0)])));
  m.recordings[0].variants = [{ id: 'v', whisper: 'w.json', diarization: null }];
  m.recordings[0].reference.parsed.turns[1].label = 'Speaker 9';
  fs.writeFileSync(out, JSON.stringify(m));
  const r = run(['--manifest', out, '--output', path.join(dir, 'r.json')]);
  assert(r.status === 1 && /stored reference turns do not match/.test(r.stderr), r.stderr);
});

test('synthetic example runs end to end, deterministically, marked synthetic', () => {
  const dir = tmpDir();
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');
  for (const out of [a, b]) {
    const r = run(['--manifest', EXAMPLE, '--output', out, '--quiet', '--no-timestamp']);
    assert(r.status === 0, r.stderr);
  }
  const ta = fs.readFileSync(a, 'utf8');
  assert(ta === fs.readFileSync(b, 'utf8'), 'byte-identical reports');
  const rep = JSON.parse(ta);
  assert(rep.synthetic === true && /SYNTHETIC/.test(rep.notes[0]), 'marked synthetic');
  const v = Object.fromEntries(rep.recordings[0].variants.map((x) => [x.id, x]));
  same(v.exclusive.metrics.speaker.wordSpeakerErrorRate, 0);
  assert(v['legacy-absorbed'].metrics.speaker.wordSpeakerErrorRate > 0, 'wrong variant detected');
  same(v['legacy-absorbed'].metrics.shortTurns.retained, 0);
  same(v.regular.metrics.speaker.ambiguous, 1);
  same(v['whisper-text-only'].metrics.speaker, null);
  same(v.exclusive.metrics.zeroCoverageTurns, [1]);
  same(v['exclusive-forced'].timingSummary.fallbacks, { 'alignment-unaligned': 1 });
  same(v.exclusive.runtime.diarizationSec, 2.5);
  assert(rep.recordings[1].variants[1].metrics.timing.wordStartError.scored > 0, 'timed recording scored');
});

function round(x) {
  return Math.round(x * 1e4) / 1e4;
}

// --- Summary ---

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
