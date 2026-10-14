#!/usr/bin/env node
// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

/**
 * Diarisation evaluation harness (task T4.3).
 *
 * Scores saved pipeline outputs (Whisper JSON, optional forced alignment,
 * optional diarisation timeline) against a speaker-labelled reference
 * transcript. It replays saved stages only; it never runs Whisper, pyannote
 * or the aligner, so a comparison can hold any stage fixed.
 *
 * Usage:
 *   node scripts/evaluate-diarization.js --manifest <json> --output <json>
 *        [--quiet] [--no-timestamp]
 *   node scripts/evaluate-diarization.js import-reference --text <gold.txt>
 *        --audio <audio> --out <manifest.json> [--id <id>] [--split tune|heldout]
 *        [--force | --append]
 *
 * --manifest and --output default to $DIARIZATION_EVAL_MANIFEST and
 * $DIARIZATION_EVAL_REPORT. See docs/diarization-evaluation.md for the
 * manifest and report schemas, the text normalisation rules and the metric
 * definitions.
 *
 * Key rules:
 *   - Recognised words are paired with reference words by normalised text
 *     only (weighted edit-distance alignment). Timing is never used to pair words.
 *   - Hypothesis speaker IDs are mapped one-to-one to reference labels per
 *     variant, maximising matched-word agreement.
 *   - A metric that cannot be computed is null and listed under `missing`
 *     with a reason. It is never reported as 0.
 *
 * Exit codes: 0 success, 1 input or evaluation error, 2 usage error.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { normaliseWhisperWords, applyForcedAlignment, summariseTiming } = require('../lib/transcript-timing');
const { assignSpeakers, normaliseSpeakerTimeline, DEFAULTS: MERGE_DEFAULTS } = require('../lib/diarize-merge');

const MANIFEST_SCHEMA = 'transcriber-diarization-eval';
const MANIFEST_VERSION = 1;
const REPORT_SCHEMA = 'transcriber-diarization-eval-report';
const REPORT_VERSION = 1;
const NORMALISATION_ID = 'transcriber-eval-text-v1';

/** Human-readable statement of the rules normaliseRawWords() applies. */
const NORMALISATION_RULES = [
  'Reference header lines such as "[N speakers detected]" are ignored; the speaker inventory comes from the turn labels.',
  'A line starting with "[label]" starts a new turn; following non-blank lines continue it. Blank lines are ignored.',
  'Text inside parentheses or square brackets is a cue such as "(music)" and is dropped. Cue state resets at the end of each reference turn and each Whisper segment.',
  'Curly apostrophes become straight apostrophes, then text is lowercased.',
  'The characters $ , and % are removed, so "$12.6" -> "126" and "10%" -> "10". Numbers are not converted to or from words.',
  'Hyphens, dashes and slashes split words ("sell-off" -> "sell off").',
  'All other punctuation is removed, including full stops inside numbers ("12.6" -> "126").',
  'Apostrophes are kept only between letters or digits ("that\'s" stays; leading and trailing apostrophes go).',
  'Words are split on whitespace after these steps; empty results are dropped.',
];

const SCORING_DEFAULTS = {
  excludedLabels: ['Unknown'],
  shortTurnMaxWords: 5,
  nearChangeWords: 3,
  externalDer: null,
};

const NO_TIMING = 'no independent timing annotation';
const NO_DIARIZATION = 'no diarization output';

/** Largest alignment table allowed (cells, about 200 MB). Split longer recordings. */
const MAX_ALIGNMENT_CELLS = 100e6;

class EvalError extends Error {}
class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function round(x, dp = 4) {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

function ratio(num, den) {
  return den > 0 ? round(num / den) : null;
}

function median(sorted) {
  const n = sorted.length;
  if (n === 0) return null;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/** Nearest-rank percentile of a sorted array. */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

function readJson(file, what) {
  if (!fs.existsSync(file)) throw new EvalError(`${what} not found: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new EvalError(`${what} is not valid JSON: ${file} (${e.message})`);
  }
}

// ---------------------------------------------------------------------------
// Reference parsing and text normalisation
// ---------------------------------------------------------------------------

/**
 * Parse speaker-labelled text into turns. The source text is never changed.
 *
 * @returns {{ header: object|null, turns: { turn, label, lines: [first, last], text }[] }}
 *          `turn` is 1-based in document order; `lines` are 1-based line numbers.
 */
function parseSpeakerLabelledText(source) {
  const lines = String(source).split(/\r?\n/);
  let header = null;
  const turns = [];
  let current = null;
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.trim();
    if (line === '') return;
    const m = /^\[([^\]]*)\](.*)$/.exec(line);
    if (m && turns.length === 0 && m[2].trim() === '' && /speakers?\s+detected/i.test(m[1])) {
      header = { line: lineNo, text: line, ignored: true };
      return;
    }
    if (m && m[1].trim() !== '') {
      current = { turn: turns.length + 1, label: m[1].trim(), lines: [lineNo, lineNo], parts: [] };
      if (m[2].trim() !== '') current.parts.push(m[2].trim());
      turns.push(current);
      return;
    }
    if (!current) throw new EvalError(`reference line ${lineNo}: text before the first speaker label`);
    current.parts.push(line);
    current.lines[1] = lineNo;
  });
  if (turns.length === 0) throw new EvalError('reference has no speaker-labelled turns');
  return {
    header,
    turns: turns.map((t) => ({ turn: t.turn, label: t.label, lines: t.lines, text: t.parts.join('\n') })),
  };
}

/**
 * Normalise a list of raw words (one unit: a reference turn or a Whisper
 * segment). Returns, for each raw word, the list of normalised words it
 * produced (possibly empty). Rules: NORMALISATION_RULES.
 */
function normaliseRawWords(rawWords) {
  let depth = 0;
  return rawWords.map((raw) => {
    let kept = '';
    for (const ch of String(raw).replace(/[\u2018\u2019\u02BC]/g, "'")) {
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') { if (depth > 0) depth--; }
      else if (depth === 0) kept += ch;
    }
    const s = kept.toLowerCase()
      .replace(/[$,%]/g, '')
      .replace(/[-\u2010-\u2015/]/g, ' ')
      .replace(/[^\p{L}\p{N}'\s]/gu, '');
    return s.split(/\s+/)
      .map((w) => w.replace(/^'+|'+$/g, ''))
      .filter((w) => w !== '');
  });
}

/** Normalise free text (one unit) into words. */
function normaliseText(text) {
  return normaliseRawWords(String(text).split(/\s+/).filter(Boolean)).flat();
}

/**
 * Build the scoring view of the reference.
 *
 * @param {object[]} turns   [{ turn?, label, text }]
 * @param {object}   scoring { excludedLabels, ... }
 * @param {number[]} [insertedClipTurns]  1-based turn numbers
 */
function buildReferenceModel(turns, scoring, insertedClipTurns = []) {
  const excluded = new Set(scoring.excludedLabels);
  const words = [];
  const turnInfo = turns.map((t, i) => {
    if (typeof t.label !== 'string' || t.label.trim() === '') throw new EvalError(`reference turn ${i + 1} has no label`);
    const turnWords = normaliseText(t.text || '');
    const first = words.length;
    turnWords.forEach((w, k) => words.push({
      text: w, turn: i + 1, turnWord: k, label: t.label, excluded: excluded.has(t.label),
    }));
    return { turn: i + 1, label: t.label, excluded: excluded.has(t.label), words: turnWords, first };
  });
  const speakers = [];
  for (const t of turnInfo) if (!t.excluded && !speakers.includes(t.label)) speakers.push(t.label);
  // Speaker changes: positions where the label differs from the previous word's.
  const boundaries = [];
  for (let i = 1; i < words.length; i++) if (words[i].label !== words[i - 1].label) boundaries.push(i);
  for (const n of insertedClipTurns) {
    if (!Number.isInteger(n) || n < 1 || n > turnInfo.length) throw new EvalError(`insertedClipTurns: no reference turn ${n}`);
  }
  return {
    turns: turnInfo,
    words,
    speakers,
    boundaries,
    insertedClipTurns: [...insertedClipTurns].sort((a, b) => a - b),
    excludedTurns: turnInfo.filter((t) => t.excluded).map((t) => t.turn),
  };
}

/** Normalised recognised words, each pointing back at its Whisper word. */
function buildHypothesisWords(whisperWords) {
  const out = [];
  let dropped = 0;
  let i = 0;
  while (i < whisperWords.length) {
    const seg = whisperWords[i].segmentIndex;
    let j = i;
    while (j < whisperWords.length && whisperWords[j].segmentIndex === seg) j++;
    const norm = normaliseRawWords(whisperWords.slice(i, j).map((w) => w.text));
    norm.forEach((list, k) => {
      if (list.length === 0) dropped++;
      list.forEach((text, pos) => out.push({ text, word: i + k, wordInitial: pos === 0 }));
    });
    i = j;
  }
  return { words: out, dropped };
}

// ---------------------------------------------------------------------------
// Text alignment (no timing)
// ---------------------------------------------------------------------------

/**
 * Minimum-cost alignment of two word arrays. Equal words cost 0, a
 * substitution 3, an insertion or deletion 2. A substitution is cheaper than
 * a deletion plus an insertion, but two substitutions never beat a match
 * with one deletion and one insertion, so ties cannot lose a match. Ties
 * prefer the diagonal, then deletion, so the result is deterministic.
 *
 * @returns {{ op: 'match'|'sub'|'del'|'ins', r: number|null, h: number|null }[]}
 */
const SUB = 3;
const GAP = 2;

function alignWords(ref, hyp) {
  const n = ref.length;
  const m = hyp.length;
  const cells = (n + 1) * (m + 1);
  if (cells > MAX_ALIGNMENT_CELLS) {
    throw new EvalError(`alignment too large (${n} x ${m} words); split the recording into shorter excerpts`);
  }
  const W = m + 1;
  const D = 2 * (n + m) < 65535 ? new Uint16Array(cells) : new Uint32Array(cells);
  for (let j = 0; j <= m; j++) D[j] = j * GAP;
  for (let i = 1; i <= n; i++) {
    D[i * W] = i * GAP;
    const a = ref[i - 1];
    for (let j = 1; j <= m; j++) {
      const diag = D[(i - 1) * W + j - 1] + (a === hyp[j - 1] ? 0 : SUB);
      const del = D[(i - 1) * W + j] + GAP;
      const ins = D[i * W + j - 1] + GAP;
      D[i * W + j] = diag <= del ? (diag <= ins ? diag : ins) : (del <= ins ? del : ins);
    }
  }
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const here = D[i * W + j];
    if (i > 0 && j > 0) {
      const eq = ref[i - 1] === hyp[j - 1];
      if (here === D[(i - 1) * W + j - 1] + (eq ? 0 : SUB)) {
        ops.push({ op: eq ? 'match' : 'sub', r: i - 1, h: j - 1 });
        i--; j--;
        continue;
      }
    }
    if (i > 0 && here === D[(i - 1) * W + j] + GAP) {
      ops.push({ op: 'del', r: i - 1, h: null });
      i--;
      continue;
    }
    ops.push({ op: 'ins', r: null, h: j - 1 });
    j--;
  }
  return ops.reverse();
}

// ---------------------------------------------------------------------------
// Speaker mapping
// ---------------------------------------------------------------------------

/**
 * Maximum-weight one-to-one assignment (Hungarian method, integer weights).
 * @param {number[][]} weights rows x cols
 * @returns {number[]} column for each row, or -1
 */
function maxWeightAssignment(weights) {
  const nr = weights.length;
  const nc = nr ? weights[0].length : 0;
  const n = Math.max(nr, nc);
  if (n === 0) return [];
  let max = 0;
  for (const row of weights) for (const w of row) if (w > max) max = w;
  const cost = (r, c) => (r < nr && c < nc ? max - weights[r][c] : max);
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);
  for (let row = 1; row <= n; row++) {
    p[0] = row;
    let j0 = 0;
    const minv = new Array(n + 1).fill(Infinity);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const rowToCol = new Array(nr).fill(-1);
  for (let j = 1; j <= n; j++) if (p[j] - 1 < nr && j - 1 < nc) rowToCol[p[j] - 1] = j - 1;
  return rowToCol;
}

/**
 * Map hypothesis speaker IDs to reference labels. IDs are ordered by first
 * appearance in the transcript (not by name), so renaming IDs cannot change
 * the result. A pairing with zero agreed words is reported as unmapped.
 */
function mapSpeakers(assignedWords, pairs, ref) {
  const hypIds = [];
  for (const w of assignedWords) if (w.speakerId !== null && !hypIds.includes(w.speakerId)) hypIds.push(w.speakerId);
  const labelsById = new Map(assignedWords.filter((w) => w.speakerId !== null).map((w) => [w.speakerId, w.speaker]));
  const weights = hypIds.map(() => ref.speakers.map(() => 0));
  const matchedById = new Map(hypIds.map((id) => [id, 0]));
  for (const { refWord, hypWord } of pairs) {
    const id = hypWord.speakerId;
    if (id === null) continue;
    matchedById.set(id, matchedById.get(id) + 1);
    const c = ref.speakers.indexOf(refWord.label);
    if (c >= 0) weights[hypIds.indexOf(id)][c]++;
  }
  const cols = maxWeightAssignment(weights);
  const map = new Map();
  const entries = hypIds.map((id, r) => {
    const c = cols[r];
    const agreed = c >= 0 ? weights[r][c] : 0;
    const label = c >= 0 && agreed > 0 ? ref.speakers[c] : null;
    map.set(id, label);
    return {
      hypSpeakerId: id,
      hypLabel: labelsById.get(id),
      referenceLabel: label,
      agreedWords: agreed,
      matchedWords: matchedById.get(id),
    };
  });
  return { map, entries };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function tally() {
  return { words: 0, correct: 0, wrong: 0, unknown: 0 };
}

function addOutcome(t, outcome) {
  t.words++;
  t[outcome]++;
}

function finishTally(t) {
  return { ...t, errorRate: ratio(t.wrong, t.words), unknownRate: ratio(t.unknown, t.words) };
}

/** Resolve timing.words entries to global reference word positions. */
function resolveTimingWords(timing, ref) {
  const byPos = new Map();
  for (const [k, e] of (timing.words || []).entries()) {
    const t = ref.turns[e.turn - 1];
    if (!t) throw new EvalError(`timing.words[${k}]: no reference turn ${e.turn}`);
    if (!Number.isInteger(e.word) || e.word < 0 || e.word >= t.words.length) {
      throw new EvalError(`timing.words[${k}]: turn ${e.turn} has no word ${e.word}`);
    }
    if (e.text !== undefined && normaliseText(e.text).join(' ') !== t.words[e.word]) {
      throw new EvalError(`timing.words[${k}]: text does not match turn ${e.turn} word ${e.word}`);
    }
    if (typeof e.startMs !== 'number' || !Number.isFinite(e.startMs) || e.startMs < 0) {
      throw new EvalError(`timing.words[${k}]: startMs must be a non-negative number`);
    }
    byPos.set(t.first + e.word, e.startMs);
  }
  return byPos;
}

/** Validate annotated reference turns (seconds, reference labels). */
function readTimingTurns(timing, ref) {
  return (timing.turns || []).map((t, k) => {
    if (typeof t.start !== 'number' || typeof t.end !== 'number' || !(t.end > t.start) || t.start < 0) {
      throw new EvalError(`timing.turns[${k}]: needs numeric start < end in seconds`);
    }
    if (!ref.speakers.includes(t.speaker)) throw new EvalError(`timing.turns[${k}]: speaker "${t.speaker}" is not a scored reference label`);
    return { start: Math.round(t.start * 1000), end: Math.round(t.end * 1000), speaker: t.speaker };
  });
}

/** Speakers active at each elementary piece of time. */
function _pieces(refTurns, hypIntervals) {
  const cuts = new Set();
  for (const iv of refTurns) { cuts.add(iv.start); cuts.add(iv.end); }
  for (const iv of hypIntervals) { cuts.add(iv.start); cuts.add(iv.end); }
  const points = [...cuts].sort((a, b) => a - b);
  const pieces = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const mid = (a + b) / 2;
    const refSet = [...new Set(refTurns.filter((iv) => iv.start <= mid && mid < iv.end).map((iv) => iv.speaker))];
    const hypSet = [...new Set(hypIntervals.filter((iv) => iv.start <= mid && mid < iv.end).map((iv) => iv.speaker))];
    pieces.push({ a, b, refSet, hypSet });
  }
  return pieces;
}

/**
 * Time-weighted speaker error over annotated single-speaker reference time.
 * Not DER: no collar, no false-alarm term, homegrown definition.
 */
function timeWeightedSpeakerError(refTurns, hypIntervals, regularIntervals, map) {
  const mapped = hypIntervals.map((iv) => ({ ...iv, speaker: map.has(iv.speaker) && map.get(iv.speaker) !== null ? map.get(iv.speaker) : `unmapped:${iv.speaker}` }));
  let scope = 0, correct = 0, missed = 0, confused = 0, overlap = 0, overlapDetected = 0;
  for (const p of _pieces(refTurns, mapped)) {
    const d = p.b - p.a;
    if (p.refSet.length === 1) {
      scope += d;
      if (p.hypSet.length === 0) missed += d;
      else if (p.hypSet.length === 1 && p.hypSet[0] === p.refSet[0]) correct += d;
      else confused += d;
    }
  }
  // Overlap detection is a property of the regular timeline: the exclusive
  // one has no overlap by construction.
  for (const p of _pieces(refTurns, regularIntervals)) {
    if (p.refSet.length > 1) {
      overlap += p.b - p.a;
      if (p.hypSet.length > 1) overlapDetected += p.b - p.a;
    }
  }
  const s = (ms) => round(ms / 1000, 3);
  return {
    definition: 'Within annotated time where exactly one reference speaker talks: (missed + confused) / scope. Missed = no hypothesis speaker; confused = any other mapped speaker set. Not DER.',
    scopeSec: s(scope),
    correctSec: s(correct),
    missedSec: s(missed),
    confusedSec: s(confused),
    rate: ratio(missed + confused, scope),
    referenceOverlapSec: s(overlap),
    referenceOverlapAlsoOverlappedInRegularTimelineSec: s(overlapDetected),
  };
}

function _python() {
  if (process.env.DIARIZATION_EVAL_PYTHON) return process.env.DIARIZATION_EVAL_PYTHON;
  if (process.env.TRANSCRIBER_PYTHON) return process.env.TRANSCRIBER_PYTHON;
  return process.platform === 'win32' ? 'python' : 'python3';
}

const DER_SCRIPT = [
  'import json, sys',
  'from pyannote.core import Annotation, Segment, Timeline',
  'from pyannote.metrics.diarization import DiarizationErrorRate',
  'import pyannote.metrics',
  'd = json.load(sys.stdin)',
  'ref = Annotation()',
  "for i, t in enumerate(d['reference']): ref[Segment(t['start'], t['end']), i] = t['speaker']",
  'hyp = Annotation()',
  "for i, t in enumerate(d['hypothesis']): hyp[Segment(t['start'], t['end']), i] = t['speaker']",
  "uem = Timeline([Segment(d['uem'][0], d['uem'][1])])",
  "m = DiarizationErrorRate(collar=d['collar'], skip_overlap=d['skipOverlap'])",
  'r = m(ref, hyp, uem=uem, detailed=True)',
  "print(json.dumps({'version': pyannote.metrics.__version__, 'detail': {k: float(v) for k, v in r.items()}}))",
].join('\n');

/** Optional standard DER through pyannote.metrics. Returns { value, reason }. */
function externalDer(settings, refTurns, hypIntervals) {
  if (!settings) return { value: null, reason: 'external DER not requested (scoring.externalDer is null)' };
  if (settings.tool !== 'pyannote.metrics') return { value: null, reason: `unsupported DER tool "${settings.tool}"` };
  const collar = typeof settings.collar === 'number' ? settings.collar : 0;
  const skipOverlap = !!settings.skipOverlap;
  const uem = [Math.min(...refTurns.map((t) => t.start)) / 1000, Math.max(...refTurns.map((t) => t.end)) / 1000];
  const input = JSON.stringify({
    reference: refTurns.map((t) => ({ start: t.start / 1000, end: t.end / 1000, speaker: t.speaker })),
    hypothesis: hypIntervals.map((t) => ({ start: t.start / 1000, end: t.end / 1000, speaker: t.speaker })),
    uem, collar, skipOverlap,
  });
  const py = _python();
  const r = spawnSync(py, ['-I', '-c', DER_SCRIPT], { input, encoding: 'utf8', timeout: 120000 });
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : String(r.stderr || '').trim().split('\n').pop();
    return { value: null, reason: `pyannote.metrics not available via ${py}: ${why}` };
  }
  const out = JSON.parse(r.stdout);
  return {
    value: {
      tool: 'pyannote.metrics',
      toolVersion: out.version,
      collarSec: collar,
      collarNote: 'pyannote.metrics collar is the total width removed around each reference boundary',
      skipOverlap,
      uemSec: uem,
      diarizationErrorRate: round(out.detail['diarization error rate']),
      detailSec: {
        total: round(out.detail.total, 3),
        missedDetection: round(out.detail['missed detection'], 3),
        falseAlarm: round(out.detail['false alarm'], 3),
        confusion: round(out.detail.confusion, 3),
      },
    },
    reason: null,
  };
}

/**
 * Pick the diarisation input for assignSpeakers according to the variant's
 * timeline choice.
 */
function selectTimeline(diarization, timeline) {
  const regular = diarization.regular;
  const exclusive = diarization.exclusive;
  if (timeline === 'regular') return { regular, exclusive: null };
  if (timeline === 'exclusive') {
    if (!Array.isArray(exclusive) || exclusive.length === 0) {
      throw new EvalError('variant requests the exclusive timeline but the diarization input has none');
    }
    return { regular, exclusive };
  }
  return { regular, exclusive };
}

/**
 * Score one variant from loaded inputs. Pure apart from the optional
 * external DER subprocess.
 *
 * @param {object} p
 * @param {object} p.ref          buildReferenceModel() result
 * @param {object} p.whisperJson  whisper --output-json-full result
 * @param {object|null} p.diarization  { regular, exclusive } or null
 * @param {object|null} p.alignment    lib/align.py output or null
 * @param {object} [p.config]     assignSpeakers overrides
 * @param {string} [p.timeline]   'auto' | 'regular' | 'exclusive'
 * @param {object|null} [p.timing] { turns, words } independent annotation
 * @param {object} p.scoring      SCORING_DEFAULTS-shaped
 */
function scoreVariant(p) {
  const { ref, scoring } = p;
  const missing = [];
  const miss = (metric, reason) => { missing.push({ metric, reason }); return null; };

  // 1. Words and timing, exactly as the runner would build them.
  const base = normaliseWhisperWords(p.whisperJson);
  const timed = p.alignment ? applyForcedAlignment(base.words, p.alignment) : base;

  // 2. Speaker assignment (or none).
  let assigned = null;
  let timelineUsed = null;
  let hypIntervals = null;
  let regularIntervals = null;
  if (p.diarization) {
    const input = selectTimeline(p.diarization, p.timeline || 'auto');
    assigned = assignSpeakers({ words: timed.words, summary: timed.summary }, input, p.config || undefined);
    timelineUsed = assigned.timeline;
    regularIntervals = normaliseSpeakerTimeline(input.regular).intervals;
    hypIntervals = timelineUsed === 'exclusive' ? normaliseSpeakerTimeline(input.exclusive).intervals : regularIntervals;
  }
  const words = assigned ? assigned.words : timed.words;

  // 3. Text alignment.
  const hyp = buildHypothesisWords(words);
  const ops = alignWords(ref.words.map((w) => w.text), hyp.words.map((w) => w.text));
  const refToHyp = new Array(ref.words.length).fill(null);
  let matched = 0, sub = 0, del = 0, ins = 0;
  for (const o of ops) {
    if (o.op === 'match') { matched++; refToHyp[o.r] = o.h; }
    else if (o.op === 'sub') sub++;
    else if (o.op === 'del') del++;
    else ins++;
  }
  const scoredRefWords = ref.words.filter((w) => !w.excluded).length;
  const pairs = [];
  for (let r = 0; r < ref.words.length; r++) {
    if (refToHyp[r] === null) continue;
    const h = hyp.words[refToHyp[r]];
    pairs.push({ r, refWord: ref.words[r], hypToken: h, hypWord: words[h.word] });
  }
  const scoredPairs = pairs.filter((x) => !x.refWord.excluded);

  const denominators = {
    referenceTurns: ref.turns.length,
    referenceWords: ref.words.length,
    referenceWordsScored: scoredRefWords,
    whisperWords: words.length,
    whisperWordsDroppedByNormalisation: hyp.dropped,
    recognisedWords: hyp.words.length,
    matchedWords: matched,
    matchedWordsScored: scoredPairs.length,
    substitutedWords: sub,
    deletedReferenceWords: del,
    insertedRecognisedWords: ins,
  };

  const text = {
    coverage: ratio(matched, ref.words.length),
    scoredCoverage: ratio(scoredPairs.length, scoredRefWords),
    recognisedMatchedRate: ratio(matched, hyp.words.length),
    textWordErrorRate: ratio(sub + del + ins, ref.words.length),
  };

  // 4. Speaker mapping and outcomes.
  let mapping = null;
  let speakerMap = null;
  let outcome = null;
  if (assigned) {
    const m = mapSpeakers(words, scoredPairs, ref);
    mapping = m.entries;
    speakerMap = m.map;
    outcome = (x) => {
      if (x.hypWord.speakerId === null) return 'unknown';
      return speakerMap.get(x.hypWord.speakerId) === x.refWord.label ? 'correct' : 'wrong';
    };
  } else {
    miss('mapping', NO_DIARIZATION);
  }

  // Per-turn coverage (always).
  const perTurn = ref.turns.map((t) => ({
    turn: t.turn, label: t.label, excluded: t.excluded, words: t.words.length, matched: 0,
    correct: assigned ? 0 : null, wrong: assigned ? 0 : null, unknown: assigned ? 0 : null,
  }));
  for (const x of pairs) {
    const pt = perTurn[x.refWord.turn - 1];
    pt.matched++;
    if (assigned && !x.refWord.excluded) pt[outcome(x)]++;
  }
  for (const pt of perTurn) pt.coverage = ratio(pt.matched, pt.words);
  const zeroCoverageTurns = perTurn.filter((t) => t.words > 0 && t.matched === 0).map((t) => t.turn);

  const metrics = {
    text,
    speaker: null,
    shortTurns: null,
    nearChange: null,
    diariserOverlap: null,
    turnCoverage: perTurn,
    zeroCoverageTurns,
    timing: { wordStartError: null, timeWeightedSpeakerError: null, referenceOverlapWords: null, der: null },
  };

  if (assigned && scoredPairs.length === 0) {
    miss('speaker', 'no matched words in scored reference turns');
  } else if (assigned) {
    const all = tally();
    const byAssignment = {};
    for (const k of ['supported', 'ambiguous', 'gap-filled', 'unknown']) byAssignment[k] = tally();
    let unmapped = 0;
    for (const x of scoredPairs) {
      const o = outcome(x);
      addOutcome(all, o);
      addOutcome(byAssignment[x.hypWord.assignment], o);
      if (o === 'wrong' && speakerMap.get(x.hypWord.speakerId) === null) unmapped++;
    }
    const ambiguous = byAssignment.ambiguous;
    metrics.speaker = {
      scoredWords: all.words,
      correct: all.correct,
      wrong: all.wrong,
      unknown: all.unknown,
      ambiguous: ambiguous.words,
      ambiguousWrong: ambiguous.wrong,
      wrongFromUnmappedSpeakers: unmapped,
      wordSpeakerErrorRate: ratio(all.wrong, all.words),
      unknownRate: ratio(all.unknown, all.words),
      ambiguousRate: ratio(ambiguous.words, all.words),
      byAssignment,
    };

    // Short-turn retention.
    const maxWords = scoring.shortTurnMaxWords;
    const candidates = perTurn.filter((t) => !t.excluded && t.words > 0 &&
      (t.words <= maxWords || ref.insertedClipTurns.includes(t.turn)));
    const list = candidates.map((t) => {
      const why = [];
      if (t.words <= maxWords) why.push('short');
      if (ref.insertedClipTurns.includes(t.turn)) why.push('inserted-clip');
      let status;
      if (t.matched === 0) status = 'not-recognised';
      else if (t.correct * 2 > t.matched) status = 'retained';
      else status = 'lost';
      return { turn: t.turn, label: t.label, reason: why, words: t.words, matched: t.matched, correct: t.correct, status };
    });
    const retained = list.filter((t) => t.status === 'retained').length;
    const recognised = list.filter((t) => t.status !== 'not-recognised').length;
    metrics.shortTurns = {
      maxWords,
      insertedClipTurns: ref.insertedClipTurns,
      turns: list.length,
      retained,
      retention: ratio(retained, list.length),
      recognisedTurns: recognised,
      retentionOfRecognised: ratio(retained, recognised),
      lostTurns: list.filter((t) => t.status === 'lost').map((t) => t.turn),
      notRecognisedTurns: list.filter((t) => t.status === 'not-recognised').map((t) => t.turn),
      detail: list,
    };

    // Errors near speaker changes.
    const K = scoring.nearChangeWords;
    const near = new Uint8Array(ref.words.length);
    for (const b of ref.boundaries) {
      for (let i = Math.max(0, b - K); i < Math.min(ref.words.length, b + K); i++) near[i] = 1;
    }
    const nearT = tally();
    const farT = tally();
    for (const x of scoredPairs) addOutcome(near[x.r] ? nearT : farT, outcome(x));
    metrics.nearChange = {
      windowWords: K,
      definition: 'Reference words within K words either side of a change of reference label',
      near: finishTally(nearT),
      elsewhere: finishTally(farT),
    };

    // Words the diariser flagged as overlapped or tied.
    const flagged = tally();
    const rest = tally();
    for (const x of scoredPairs) {
      const ev = x.hypWord.evidence || {};
      const isFlagged = (ev.overlapSpeakers || []).length > 1 || (ev.candidates || []).length > 1;
      addOutcome(isFlagged ? flagged : rest, outcome(x));
    }
    metrics.diariserOverlap = {
      definition: 'Matched words whose assignment evidence lists two or more overlapping or tied speakers',
      flagged: finishTally(flagged),
      notFlagged: finishTally(rest),
    };
  } else {
    for (const k of ['speaker', 'shortTurns', 'nearChange', 'diariserOverlap']) miss(k, NO_DIARIZATION);
  }

  // 5. Timing metrics (only with an independent annotation).
  const timing = p.timing || null;
  if (!timing) {
    for (const k of ['timing.wordStartError', 'timing.timeWeightedSpeakerError', 'timing.referenceOverlapWords', 'timing.der']) miss(k, NO_TIMING);
  } else {
    const annotated = resolveTimingWords(timing, ref);
    const refTurns = readTimingTurns(timing, ref);

    if (annotated.size === 0) {
      miss('timing.wordStartError', 'timing annotation has no word times');
    } else {
      const errs = [];
      let untimed = 0, notWordInitial = 0, annotatedMatched = 0;
      for (const x of pairs) {
        if (!annotated.has(x.r)) continue;
        annotatedMatched++;
        if (!x.hypToken.wordInitial) { notWordInitial++; continue; }
        if (x.hypWord.startMs === null || x.hypWord.startMs === undefined) { untimed++; continue; }
        errs.push(x.hypWord.startMs - annotated.get(x.r));
      }
      if (errs.length === 0) {
        miss('timing.wordStartError', 'no annotated word was matched to a timed recognised word');
      } else {
        const signed = [...errs].sort((a, b) => a - b);
        const abs = errs.map(Math.abs).sort((a, b) => a - b);
        metrics.timing.wordStartError = {
          annotatedWords: annotated.size,
          annotatedMatched,
          scored: errs.length,
          untimed,
          notWordInitial,
          signedMedianMs: round(median(signed), 1),
          absMedianMs: round(median(abs), 1),
          absP95Ms: round(percentile(abs, 0.95), 1),
          percentileMethod: 'nearest rank',
        };
      }
    }

    if (refTurns.length === 0) {
      miss('timing.timeWeightedSpeakerError', 'timing annotation has no speaker turns');
      miss('timing.referenceOverlapWords', 'timing annotation has no speaker turns');
      miss('timing.der', 'timing annotation has no speaker turns');
    } else if (!assigned) {
      for (const k of ['timing.timeWeightedSpeakerError', 'timing.referenceOverlapWords', 'timing.der']) miss(k, NO_DIARIZATION);
    } else {
      metrics.timing.timeWeightedSpeakerError = timeWeightedSpeakerError(refTurns, hypIntervals, regularIntervals, speakerMap);

      if (annotated.size === 0) {
        miss('timing.referenceOverlapWords', 'timing annotation has no word times');
      } else {
        const inOverlap = (ms) => refTurns.filter((t) => t.start <= ms && ms < t.end).length > 1;
        const ov = tally();
        const single = tally();
        for (const x of scoredPairs) {
          if (!annotated.has(x.r)) continue;
          addOutcome(inOverlap(annotated.get(x.r)) ? ov : single, outcome(x));
        }
        metrics.timing.referenceOverlapWords = {
          definition: 'Annotated matched words whose annotated start lies where two or more annotated reference turns overlap; scored against the text label',
          overlapped: finishTally(ov),
          notOverlapped: finishTally(single),
        };
      }

      const der = externalDer(scoring.externalDer, refTurns, hypIntervals);
      if (der.value) metrics.timing.der = { ...der.value, hypothesisTimeline: timelineUsed };
      else miss('timing.der', der.reason);
    }
  }

  return {
    timeline: { requested: p.diarization ? (p.timeline || 'auto') : null, used: timelineUsed },
    metrics,
    denominators,
    mapping,
    timingSummary: assigned ? assigned.summary.timing : summariseTiming(words),
    assignmentSummary: assigned ? assigned.summary.assignment : null,
    missing,
  };
}

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

function _inputRef(value, what) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return { path: value, sha256: null };
  if (typeof value === 'object' && typeof value.path === 'string') return { path: value.path, sha256: value.sha256 || null };
  throw new EvalError(`${what} must be a path string, { path, sha256 } or null`);
}

function _loadInput(ref, baseDir, what) {
  const file = path.resolve(baseDir, ref.path);
  if (!fs.existsSync(file)) throw new EvalError(`${what} not found: ${ref.path}`);
  const sha = sha256File(file);
  if (ref.sha256 && ref.sha256 !== sha) {
    throw new EvalError(`${what} checksum mismatch for ${ref.path}: manifest ${ref.sha256}, file ${sha}`);
  }
  return { file, sha };
}

function loadWhisper(file) {
  const j = readJson(file, 'whisper JSON');
  if (j && Array.isArray(j.transcription)) return j;
  if (j && j.whisper && Array.isArray(j.whisper.transcription)) return j.whisper;
  throw new EvalError(`whisper JSON has no "transcription" array: ${file}`);
}

/** Accept a lib/diarize.py envelope, a legacy array or a runner JSON. */
function loadDiarization(file) {
  const j = readJson(file, 'diarization');
  if (Array.isArray(j)) return { regular: j, exclusive: null, source: 'legacy-array' };
  if (j && j.format === 'transcriber-diarization') {
    if (j.version !== 1) throw new EvalError(`diarization envelope version ${j.version} is not supported (expected 1): ${file}`);
    if (!Array.isArray(j.regular)) throw new EvalError(`diarization envelope has no "regular" array: ${file}`);
    return { regular: j.regular, exclusive: Array.isArray(j.exclusive) ? j.exclusive : null, source: 'envelope' };
  }
  if (j && Array.isArray(j.diarize)) {
    return { regular: j.diarize, exclusive: Array.isArray(j.diarizeExclusive) ? j.diarizeExclusive : null, source: 'runner-json' };
  }
  throw new EvalError(`diarization file is not an envelope, legacy array or runner JSON: ${file}`);
}

function loadAlignment(file) {
  const j = readJson(file, 'alignment');
  if (!j || j.format !== 'transcriber-alignment' || j.version !== 1) {
    throw new EvalError(`alignment file is not "transcriber-alignment" version 1 (lib/align.py output): ${file}`);
  }
  return j;
}

function readScoring(manifest) {
  const s = { ...SCORING_DEFAULTS, ...(manifest.scoring || {}) };
  if (!Array.isArray(s.excludedLabels)) throw new EvalError('scoring.excludedLabels must be an array');
  if (!Number.isInteger(s.shortTurnMaxWords) || s.shortTurnMaxWords < 1) throw new EvalError('scoring.shortTurnMaxWords must be a positive integer');
  if (!Number.isInteger(s.nearChangeWords) || s.nearChangeWords < 1) throw new EvalError('scoring.nearChangeWords must be a positive integer');
  return s;
}

function validateManifest(m) {
  if (!m || typeof m !== 'object') throw new EvalError('manifest is not a JSON object');
  if (m.schema !== MANIFEST_SCHEMA) throw new EvalError(`manifest schema is "${m.schema}", expected "${MANIFEST_SCHEMA}"`);
  if (m.version !== MANIFEST_VERSION) throw new EvalError(`manifest version ${m.version} is not supported (expected ${MANIFEST_VERSION})`);
  if (m.normalisation && m.normalisation.id !== NORMALISATION_ID) {
    throw new EvalError(`manifest normalisation "${m.normalisation.id}" is not supported (expected "${NORMALISATION_ID}")`);
  }
  if (!Array.isArray(m.recordings) || m.recordings.length === 0) throw new EvalError('manifest has no recordings');
  const ids = new Set();
  for (const r of m.recordings) {
    if (!r || typeof r.id !== 'string' || r.id === '') throw new EvalError('every recording needs a string id');
    if (ids.has(r.id)) throw new EvalError(`duplicate recording id "${r.id}"`);
    ids.add(r.id);
    if (r.split !== 'tune' && r.split !== 'heldout') throw new EvalError(`recording "${r.id}": split must be "tune" or "heldout"`);
    if (!r.reference || typeof r.reference !== 'object') throw new EvalError(`recording "${r.id}": missing reference`);
    if (!Array.isArray(r.reference.turns) && !(typeof r.reference.path === 'string')) {
      throw new EvalError(`recording "${r.id}": reference needs { path, sha256, format } or { turns }`);
    }
    if (typeof r.reference.path === 'string') {
      if (r.reference.format !== 'speaker-labelled-text') throw new EvalError(`recording "${r.id}": reference format must be "speaker-labelled-text"`);
      if (!r.reference.sha256) throw new EvalError(`recording "${r.id}": reference sha256 is required`);
    }
    if (r.audio && (typeof r.audio.path !== 'string' || !r.audio.sha256)) throw new EvalError(`recording "${r.id}": audio needs { path, sha256 } or null`);
    if (!Array.isArray(r.variants)) throw new EvalError(`recording "${r.id}": variants must be an array`);
    const vids = new Set();
    for (const v of r.variants) {
      if (!v || typeof v.id !== 'string' || v.id === '') throw new EvalError(`recording "${r.id}": every variant needs a string id`);
      if (vids.has(v.id)) throw new EvalError(`recording "${r.id}": duplicate variant id "${v.id}"`);
      vids.add(v.id);
      if (!v.whisper) throw new EvalError(`variant "${r.id}/${v.id}": whisper path is required`);
      if (v.timeline !== undefined && !['auto', 'regular', 'exclusive'].includes(v.timeline)) {
        throw new EvalError(`variant "${r.id}/${v.id}": timeline must be auto, regular or exclusive`);
      }
      for (const k of Object.keys(v.config || {})) {
        if (!(k in MERGE_DEFAULTS)) throw new EvalError(`variant "${r.id}/${v.id}": unknown config key "${k}" (allowed: ${Object.keys(MERGE_DEFAULTS).join(', ')})`);
      }
    }
  }
}

/** Load and check one recording's reference; returns { turns, sha, parsed }. */
function loadReference(rec, baseDir) {
  const r = rec.reference;
  if (Array.isArray(r.turns) && typeof r.path !== 'string') {
    return { turns: r.turns.map((t, i) => ({ turn: i + 1, label: t.label, text: t.text })), sha: null, header: null };
  }
  const { file, sha } = _loadInput({ path: r.path, sha256: r.sha256 }, baseDir, `recording "${rec.id}" reference`);
  const parsed = parseSpeakerLabelledText(fs.readFileSync(file, 'utf8'));
  if (r.parsed && Array.isArray(r.parsed.turns)) {
    const a = JSON.stringify(r.parsed.turns.map((t) => [t.label, t.text]));
    const b = JSON.stringify(parsed.turns.map((t) => [t.label, t.text]));
    if (a !== b) throw new EvalError(`recording "${rec.id}": stored reference turns do not match the reference file; re-run import-reference`);
  }
  return { turns: parsed.turns, sha, header: parsed.header };
}

// ---------------------------------------------------------------------------
// Evaluation driver
// ---------------------------------------------------------------------------

function evaluateManifest(manifestPath, { timestamp = true } = {}) {
  const manifest = readJson(manifestPath, 'manifest');
  validateManifest(manifest);
  const baseDir = path.dirname(path.resolve(manifestPath));
  const scoring = readScoring(manifest);

  const recordings = manifest.recordings.map((rec) => {
    const audio = rec.audio ? _loadInput(rec.audio, baseDir, `recording "${rec.id}" audio`) : null;
    const reference = loadReference(rec, baseDir);
    const ref = buildReferenceModel(reference.turns, scoring, rec.reference.insertedClipTurns || []);

    const variants = rec.variants.map((v) => {
      const what = `variant "${rec.id}/${v.id}"`;
      const wRef = _inputRef(v.whisper, `${what} whisper`);
      const dRef = _inputRef(v.diarization, `${what} diarization`);
      const aRef = _inputRef(v.alignment, `${what} alignment`);
      const w = _loadInput(wRef, baseDir, `${what} whisper`);
      const d = dRef ? _loadInput(dRef, baseDir, `${what} diarization`) : null;
      const a = aRef ? _loadInput(aRef, baseDir, `${what} alignment`) : null;
      let scored;
      try {
        scored = scoreVariant({
          ref,
          scoring,
          whisperJson: loadWhisper(w.file),
          diarization: d ? loadDiarization(d.file) : null,
          alignment: a ? loadAlignment(a.file) : null,
          config: v.config || null,
          timeline: v.timeline || 'auto',
          timing: rec.timing || null,
        });
      } catch (e) {
        if (e instanceof EvalError) throw new EvalError(`${what}: ${e.message}`);
        throw e;
      }
      if (!v.runtime) scored.missing.push({ metric: 'runtime', reason: 'not recorded in manifest' });
      return {
        id: v.id,
        description: v.description || null,
        inputs: {
          whisper: { path: wRef.path, sha256: w.sha },
          diarization: dRef ? { path: dRef.path, sha256: d.sha } : null,
          alignment: aRef ? { path: aRef.path, sha256: a.sha } : null,
          config: v.config || {},
        },
        timeline: scored.timeline,
        metrics: scored.metrics,
        denominators: scored.denominators,
        mapping: scored.mapping,
        timingSummary: scored.timingSummary,
        assignmentSummary: scored.assignmentSummary,
        runtime: v.runtime || null,
        missing: scored.missing,
      };
    });

    return {
      id: rec.id,
      split: rec.split,
      inputs: { audioSha: audio ? audio.sha : null, referenceSha: reference.sha },
      referenceSummary: {
        turns: ref.turns.length,
        words: ref.words.length,
        scoredWords: ref.words.filter((w) => !w.excluded).length,
        speakers: ref.speakers,
        excludedTurns: ref.excludedTurns,
        insertedClipTurns: ref.insertedClipTurns,
        headerIgnored: !!reference.header,
        timingAnnotation: rec.timing
          ? { turns: (rec.timing.turns || []).length, words: (rec.timing.words || []).length, source: rec.timing.source || null }
          : null,
      },
      variants,
    };
  });

  const notes = [];
  if (manifest.synthetic) {
    notes.push('SYNTHETIC: this manifest uses invented text, words and speaker timelines. The report checks the harness only and is not acoustic evidence.');
  }
  notes.push('Recognised words are paired with reference words by normalised text only (weighted edit-distance alignment); timing is never used to pair words.');
  notes.push('Hypothesis speaker IDs are mapped one-to-one to reference labels per variant (Hungarian method) to maximise matched-word agreement.');
  notes.push(`Speaker rates use matched words in scored reference turns as the denominator; turns labelled ${scoring.excludedLabels.join(', ')} are excluded from speaker scoring but reported for coverage.`);
  notes.push('Missing metrics are null and listed under "missing" with a reason; they are never reported as 0.');
  if (manifest.recordings.some((r) => r.split === 'heldout')) {
    notes.push('Held-out recordings: acceptance rules must be pinned before these scores are read.');
  }
  for (const n of manifest.notes || []) notes.push(String(n));

  const report = { schema: REPORT_SCHEMA, version: REPORT_VERSION };
  if (timestamp) report.generatedAt = new Date().toISOString();
  report.manifest = { path: path.relative(process.cwd(), path.resolve(manifestPath)) || manifestPath, sha256: sha256File(manifestPath) };
  report.synthetic = !!manifest.synthetic;
  report.normalisation = { id: NORMALISATION_ID, rules: NORMALISATION_RULES };
  report.scoring = scoring;
  report.recordings = recordings;
  report.notes = notes;
  return report;
}

function fmt(x, pct = true) {
  if (x === null || x === undefined) return '-';
  return pct ? (x * 100).toFixed(1) + '%' : String(x);
}

function summaryTable(report) {
  const rows = [['recording', 'variant', 'timeline', 'matched/ref', 'cover', 'spkErr', 'unknown', 'ambig', 'short kept', 'zero-cov turns']];
  for (const rec of report.recordings) {
    for (const v of rec.variants) {
      const s = v.metrics.speaker;
      const st = v.metrics.shortTurns;
      rows.push([
        rec.id, v.id, v.timeline.used || '-',
        `${v.denominators.matchedWords}/${v.denominators.referenceWords}`,
        fmt(v.metrics.text.coverage),
        fmt(s && s.wordSpeakerErrorRate), fmt(s && s.unknownRate), fmt(s && s.ambiguousRate),
        st ? `${st.retained}/${st.turns}` : '-',
        v.metrics.zeroCoverageTurns.length ? v.metrics.zeroCoverageTurns.join(',') : '-',
      ]);
    }
  }
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  const lines = rows.map((r) => r.map((cell, c) => String(cell).padEnd(widths[c])).join('  ').trimEnd());
  if (report.synthetic) lines.unshift('SYNTHETIC data: harness check only, not acoustic evidence.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// import-reference
// ---------------------------------------------------------------------------

function importReference({ text, audio, out, id, split = 'tune', force = false, append = false }) {
  if (!text || !audio || !out) throw new UsageError('import-reference needs --text, --audio and --out');
  if (split !== 'tune' && split !== 'heldout') throw new UsageError('--split must be tune or heldout');
  for (const [f, what] of [[text, 'reference text'], [audio, 'audio']]) {
    if (!fs.existsSync(f)) throw new EvalError(`${what} not found: ${f}`);
  }
  const outDir = path.dirname(path.resolve(out));
  const parsed = parseSpeakerLabelledText(fs.readFileSync(text, 'utf8'));
  const scoring = { ...SCORING_DEFAULTS };
  const ref = buildReferenceModel(parsed.turns, scoring);
  const recId = id || path.basename(audio).replace(/\.[^.]+$/, '');
  const recording = {
    id: recId,
    split,
    audio: { path: path.relative(outDir, path.resolve(audio)), sha256: sha256File(audio) },
    reference: {
      path: path.relative(outDir, path.resolve(text)),
      sha256: sha256File(text),
      format: 'speaker-labelled-text',
      insertedClipTurns: [],
      parsed: {
        header: parsed.header,
        speakers: ref.speakers,
        excludedTurns: ref.excludedTurns,
        turns: parsed.turns.map((t, i) => ({
          turn: t.turn,
          label: t.label,
          excluded: ref.turns[i].excluded,
          lines: t.lines,
          text: t.text,
          wordCount: ref.turns[i].words.length,
          words: ref.turns[i].words,
        })),
      },
    },
    timing: null,
    variants: [],
  };

  let manifest;
  if (fs.existsSync(out) && append) {
    manifest = readJson(out, 'manifest');
    if (manifest.schema !== MANIFEST_SCHEMA || manifest.version !== MANIFEST_VERSION) {
      throw new EvalError(`cannot append: ${out} is not a ${MANIFEST_SCHEMA} version ${MANIFEST_VERSION} manifest`);
    }
    if (manifest.recordings.some((r) => r.id === recId)) throw new EvalError(`cannot append: recording "${recId}" already exists (use --id)`);
    manifest.recordings.push(recording);
  } else {
    if (fs.existsSync(out) && !force) throw new EvalError(`${out} exists; pass --force to overwrite or --append to add a recording`);
    manifest = {
      schema: MANIFEST_SCHEMA,
      version: MANIFEST_VERSION,
      synthetic: false,
      notes: ['Local manifest generated by import-reference. Keep it, its inputs and reports in an ignored path.'],
      normalisation: { id: NORMALISATION_ID, rules: NORMALISATION_RULES },
      scoring,
      recordings: [recording],
    };
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  return {
    id: recId,
    turns: parsed.turns.length,
    words: ref.words.length,
    speakers: ref.speakers,
    excludedTurns: ref.excludedTurns,
    headerIgnored: !!parsed.header,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  node scripts/evaluate-diarization.js --manifest <json> --output <json> [--quiet] [--no-timestamp]
  node scripts/evaluate-diarization.js import-reference --text <gold.txt> --audio <audio> --out <manifest.json>
       [--id <id>] [--split tune|heldout] [--force | --append]

--manifest and --output default to $DIARIZATION_EVAL_MANIFEST and $DIARIZATION_EVAL_REPORT.`;

function parseArgs(argv, valueFlags, boolFlags) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlags.includes(a)) {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      out[a.slice(2)] = argv[++i];
    } else if (boolFlags.includes(a)) {
      out[a.slice(2)] = true;
    } else {
      throw new UsageError(`unknown argument: ${a}`);
    }
  }
  return out;
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (argv[0] === 'import-reference') {
    const o = parseArgs(argv.slice(1), ['--text', '--audio', '--out', '--id', '--split'], ['--force', '--append']);
    const s = importReference(o);
    process.stderr.write(`Imported "${s.id}": ${s.turns} turns, ${s.words} words, speakers ${s.speakers.join(', ')}; ` +
      `excluded turns ${s.excludedTurns.join(', ') || 'none'}; header ${s.headerIgnored ? 'ignored' : 'absent'}. Wrote ${o.out}\n`);
    return 0;
  }
  const o = parseArgs(argv, ['--manifest', '--output'], ['--quiet', '--no-timestamp']);
  const manifestPath = o.manifest || process.env.DIARIZATION_EVAL_MANIFEST;
  const outputPath = o.output || process.env.DIARIZATION_EVAL_REPORT;
  if (!manifestPath || !outputPath) throw new UsageError('--manifest and --output are required (or set DIARIZATION_EVAL_MANIFEST and DIARIZATION_EVAL_REPORT)');
  const report = evaluateManifest(manifestPath, { timestamp: !o['no-timestamp'] });
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  if (!o.quiet) process.stderr.write(summaryTable(report) + `\nWrote ${outputPath}\n`);
  return 0;
}

if (require.main === module) {
  let code;
  try {
    code = main(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`evaluate-diarization: ${e.message}\n\n${USAGE}\n`);
      code = 2;
    } else if (e instanceof EvalError) {
      process.stderr.write(`evaluate-diarization: error: ${e.message}\n`);
      code = 1;
    } else {
      throw e;
    }
  }
  process.exitCode = code;
}

module.exports = {
  MANIFEST_SCHEMA,
  MANIFEST_VERSION,
  REPORT_SCHEMA,
  NORMALISATION_ID,
  NORMALISATION_RULES,
  SCORING_DEFAULTS,
  EvalError,
  parseSpeakerLabelledText,
  normaliseRawWords,
  normaliseText,
  buildReferenceModel,
  alignWords,
  maxWeightAssignment,
  scoreVariant,
  evaluateManifest,
  importReference,
  summaryTable,
};
