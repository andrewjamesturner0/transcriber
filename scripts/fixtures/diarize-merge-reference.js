// Frozen D5 baseline. Only the sibling import path differs from reviewed production.
/**
 * Diarisation merge: Whisper words + speaker timelines -> speaker transcript.
 *
 * Shared by lib/transcription-runner.js, the evaluation script and tests.
 * Implements decision D1 in the diarisation design record:
 *
 *   1. normaliseWhisperWords()  (lib/transcript-timing.js) gives each word
 *      one declared timing source: DTW anchor, token offsets, segment, none.
 *   2. Speaker intervals are half-open [start, end) in ms. They are not
 *      merged, absorbed or snapped.
 *   3. Each word is assigned from its representative point. The result
 *      records whether the speaker is supported, ambiguous (overlap),
 *      gap-filled (within gapFillMaxMs) or unknown, plus the evidence.
 *   4. Consecutive words with the same label form a block. Nothing rewrites
 *      an assigned word afterwards, so short turns and Unknown survive.
 *
 * Exports:
 *   assignSpeakers(whisperJson, diarization, config?)  -> structured result
 *   mergeTranscriptWithDiarization(...)                -> formatted string
 *
 * `diarization` is either a legacy array of { start, end, speaker } in
 * seconds (treated as a regular timeline) or { regular, exclusive } where
 * exclusive may be null. When exclusive intervals are present they decide
 * the speaker and the regular timeline only adds overlap evidence.
 *
 * Set DIARIZE_DEBUG=1 for a summary on stderr.
 */

const { normaliseWhisperWords, summariseTiming, wordPointMs } = require('../../lib/transcript-timing');

// ---------------------------------------------------------------------------
// Tunables - single flat object so tests and evaluation can override fields
// ---------------------------------------------------------------------------
const DEFAULTS = {
  // Maximum distance (ms) from the nearest speaker interval for a word that
  // falls in a gap to take that speaker. Beyond this the word is Unknown.
  gapFillMaxMs: 5000,

  // Representative point for assignment: 'midpoint' of the word span (D1),
  // or 'start' (word onset). 'start' exists for evaluation comparisons only.
  assignmentPoint: 'midpoint',
};

// ---------------------------------------------------------------------------
// Speaker timelines
// ---------------------------------------------------------------------------

/**
 * Convert { start, end, speaker } seconds into sorted half-open ms intervals.
 * Drops entries with missing speaker, non-finite or non-positive duration.
 */
function normaliseSpeakerTimeline(segments) {
  const intervals = [];
  let dropped = 0;
  for (const s of segments || []) {
    const start = s && typeof s.start === 'number' ? Math.round(s.start * 1000) : NaN;
    const end = s && typeof s.end === 'number' ? Math.round(s.end * 1000) : NaN;
    if (!s || s.speaker === undefined || s.speaker === null ||
        !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      dropped++;
      continue;
    }
    intervals.push({ start, end, speaker: String(s.speaker) });
  }
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  return { intervals, dropped };
}

/** Accept a legacy array or a { regular, exclusive } object. */
function _readDiarization(diarization) {
  if (Array.isArray(diarization)) return { regular: diarization, exclusive: null };
  const d = diarization || {};
  return {
    regular: Array.isArray(d.regular) ? d.regular : [],
    exclusive: Array.isArray(d.exclusive) ? d.exclusive : null,
  };
}

function _containing(intervals, point) {
  return intervals.filter((iv) => iv.start <= point && point < iv.end);
}

function _unique(list) {
  return [...new Set(list)];
}

function _overlapBySpeaker(intervals, startMs, endMs) {
  const totals = new Map();
  for (const iv of intervals) {
    const ov = Math.min(endMs, iv.end) - Math.max(startMs, iv.start);
    if (ov > 0) totals.set(iv.speaker, (totals.get(iv.speaker) || 0) + ov);
  }
  return totals;
}

/** Distance from point to a half-open interval (0 when inside). */
function _distance(iv, point) {
  if (point < iv.start) return iv.start - point;
  if (point >= iv.end) return point - iv.end;
  return 0;
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/**
 * Pick one label among tied candidates: the previous word's speaker if it is
 * a candidate, else the largest span overlap, else the earliest interval.
 */
function _choose(candidates, prevSpeaker, overlaps, intervals) {
  if (prevSpeaker && candidates.includes(prevSpeaker)) return prevSpeaker;
  let best = null;
  let bestOv = -1;
  for (const c of candidates) {
    const ov = overlaps.get(c) || 0;
    if (ov > bestOv) { best = c; bestOv = ov; }
  }
  if (bestOv > 0) {
    const top = candidates.filter((c) => (overlaps.get(c) || 0) === bestOv);
    if (top.length === 1) return best;
    candidates = top;
  }
  const first = intervals.find((iv) => candidates.includes(iv.speaker));
  return first ? first.speaker : candidates[0];
}

function _assignWord(word, intervals, regular, prevSpeaker, config) {
  const point = config.assignmentPoint === 'start' ? word.startMs : wordPointMs(word);
  const evidence = { method: null, pointMs: point, candidates: [], distanceMs: null, overlapSpeakers: [] };
  if (point === null || point === undefined) {
    return { speakerId: null, assignment: 'unknown', evidence };
  }

  if (regular) {
    const overlapping = _unique(_containing(regular, point).map((iv) => iv.speaker));
    if (overlapping.length > 1) evidence.overlapSpeakers = overlapping;
  }

  const hasSpan = word.endMs !== null && word.endMs > word.startMs;
  const overlaps = hasSpan ? _overlapBySpeaker(intervals, word.startMs, word.endMs) : new Map();

  // 1. Point containment
  const inside = _unique(_containing(intervals, point).map((iv) => iv.speaker));
  if (inside.length === 1) {
    evidence.method = 'point';
    evidence.candidates = inside;
    return { speakerId: inside[0], assignment: 'supported', evidence };
  }
  if (inside.length > 1) {
    evidence.method = 'point';
    evidence.candidates = inside;
    return { speakerId: _choose(inside, prevSpeaker, overlaps, intervals), assignment: 'ambiguous', evidence };
  }

  // 2. Span overlap (point is in a gap but the word span touches speech)
  if (overlaps.size > 0) {
    const max = Math.max(...overlaps.values());
    const top = [...overlaps.keys()].filter((k) => overlaps.get(k) === max);
    evidence.method = 'overlap';
    evidence.candidates = top;
    if (top.length === 1) return { speakerId: top[0], assignment: 'supported', evidence };
    return { speakerId: _choose(top, prevSpeaker, overlaps, intervals), assignment: 'ambiguous', evidence };
  }

  // 3. Nearest interval within the declared gap distance
  let best = null;
  let bestDist = Infinity;
  for (const iv of intervals) {
    const d = _distance(iv, point);
    const before = iv.end <= point;
    if (d < bestDist || (d === bestDist && before && best && !(best.end <= point))) {
      best = iv;
      bestDist = d;
    }
  }
  if (best && bestDist < config.gapFillMaxMs) {
    evidence.method = 'nearest';
    evidence.candidates = [best.speaker];
    evidence.distanceMs = bestDist;
    return { speakerId: best.speaker, assignment: 'gap-filled', evidence };
  }
  if (best) evidence.distanceMs = bestDist;
  return { speakerId: null, assignment: 'unknown', evidence };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Assign every recognised word to a speaker and keep the evidence.
 *
 * @param {object}       whisperJson   whisper --output-json-full result, or
 *                                     { words, summary? } already timed by
 *                                     lib/transcript-timing.js
 * @param {array|object} diarization   legacy array or { regular, exclusive }
 * @param {object}       [configOverrides]
 * @returns {object} { version, timeline, speakerCount, speakers, words, blocks, summary, text }
 */
function assignSpeakers(whisperJson, diarization, configOverrides) {
  const config = configOverrides ? { ...DEFAULTS, ...configOverrides } : DEFAULTS;
  const { regular, exclusive } = _readDiarization(diarization);
  const reg = normaliseSpeakerTimeline(regular);
  const exc = exclusive ? normaliseSpeakerTimeline(exclusive) : null;
  const useExclusive = !!(exc && exc.intervals.length > 0);
  const intervals = useExclusive ? exc.intervals : reg.intervals;

  const speakerIds = _unique(intervals.map((iv) => iv.speaker));
  const labels = {};
  speakerIds.forEach((id, i) => { labels[id] = `Speaker ${i + 1}`; });

  // Either raw Whisper JSON, or words already timed (e.g. by forced alignment).
  const pretimed = whisperJson && Array.isArray(whisperJson.words) && !whisperJson.transcription;
  const timed = pretimed ? whisperJson.words : normaliseWhisperWords(whisperJson).words;
  const timing = pretimed && whisperJson.summary ? whisperJson.summary : summariseTiming(timed);

  const counts = { supported: 0, ambiguous: 0, 'gap-filled': 0, unknown: 0 };
  let prevSpeaker = null;
  const words = timed.map((w) => {
    const a = _assignWord(w, intervals, useExclusive ? reg.intervals : null, prevSpeaker, config);
    counts[a.assignment]++;
    if (a.speakerId) prevSpeaker = a.speakerId;
    return {
      ...w,
      speaker: a.speakerId ? labels[a.speakerId] : 'Unknown',
      speakerId: a.speakerId,
      assignment: a.assignment,
      evidence: a.evidence,
    };
  });

  const blocks = [];
  for (const w of words) {
    const prev = blocks[blocks.length - 1];
    if (prev && prev.speaker === w.speaker) {
      prev.text += ' ' + w.text;
      prev.lastWord = w.index;
      if (w.startMs !== null && (prev.startMs === null || w.startMs < prev.startMs)) prev.startMs = w.startMs;
      const end = w.endMs !== null ? w.endMs : w.startMs;
      if (end !== null && (prev.endMs === null || end > prev.endMs)) prev.endMs = end;
    } else {
      blocks.push({
        speaker: w.speaker,
        speakerId: w.speakerId,
        text: w.text,
        startMs: w.startMs,
        endMs: w.endMs !== null ? w.endMs : w.startMs,
        firstWord: w.index,
        lastWord: w.index,
      });
    }
  }

  const speakerCount = speakerIds.length;
  const header = `[${speakerCount} speaker${speakerCount !== 1 ? 's' : ''} detected]\n\n`;
  const text = header + blocks.map((b) => `[${b.speaker}] ${b.text}`).join('\n\n');

  if (config.debug || (typeof process !== 'undefined' && process.env && process.env.DIARIZE_DEBUG === '1')) {
    console.error(`[diarize-merge] ${words.length} words, timeline=${useExclusive ? 'exclusive' : 'regular'}, ` +
      `timing=${JSON.stringify(timing.bySource)}, assignment=${JSON.stringify(counts)}, blocks=${blocks.length}`);
  }

  return {
    version: 1,
    timeline: useExclusive ? 'exclusive' : 'regular',
    speakerCount,
    speakers: speakerIds.map((id) => ({ id, label: labels[id] })),
    words,
    blocks,
    summary: {
      timing,
      assignment: counts,
      droppedIntervals: { regular: reg.dropped, exclusive: exc ? exc.dropped : null },
    },
    text,
  };
}

/**
 * Full merge returning only the formatted transcript (the GUI/CLI text
 * contract): a "[N speakers detected]" header then "[Speaker N] text" blocks.
 */
function mergeTranscriptWithDiarization(whisperJson, diarization, configOverrides) {
  return assignSpeakers(whisperJson, diarization, configOverrides).text;
}

module.exports = {
  DEFAULTS,
  normaliseSpeakerTimeline,
  assignSpeakers,
  mergeTranscriptWithDiarization,
};
