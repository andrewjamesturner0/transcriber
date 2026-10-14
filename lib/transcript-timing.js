// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

/**
 * Word timing normalisation for whisper --output-json-full output.
 *
 * Turns Whisper segments and tokens into an ordered list of words with one
 * declared timing source each. The rules are decision D1 in the diarisation
 * design record:
 *
 *   - t_dtw is a DTW onset anchor in 10 ms units (-1 = absent). A word's
 *     anchor is its first text token's anchor; its end is the next onset, so
 *     the span is derived, never measured.
 *   - Ordinary token offsets are Whisper's decoder estimates.
 *   - Segment offsets are the last resort; then no timing at all.
 *
 * All times are integer milliseconds from the start of the converted WAV.
 * Spans are half-open [startMs, endMs). Recognised text and word order are
 * never changed.
 *
 * Exports:
 *   normaliseWhisperWords(whisperJson) -> { words, summary }
 *   groupTokens(tokens)                -> [{ text, tokens }]
 *   wordPointMs(word)                  -> number|null
 */

// ---------------------------------------------------------------------------
// Value validation
// ---------------------------------------------------------------------------

function _isTime(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** DTW anchor in ms, or null when absent (-1, missing) or invalid. */
function _anchorMs(token) {
  if (!token || token.t_dtw === undefined || token.t_dtw === null || token.t_dtw === -1) return null;
  if (!_isTime(token.t_dtw)) return undefined; // present but invalid
  return Math.round(token.t_dtw * 10);
}

/** Ordinary offsets as { from, to } in ms, null when absent, undefined when invalid. */
function _offsets(obj) {
  if (!obj || !obj.offsets) return null;
  const { from, to } = obj.offsets;
  if (!_isTime(from) || !_isTime(to) || to < from) return undefined;
  return { from: Math.round(from), to: Math.round(to) };
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Group a segment's tokens into words. Tokens starting with "[_" are Whisper
 * control tokens and are skipped. A leading space starts a new word; any
 * other token (sub-word, punctuation, contraction) joins the current word.
 */
function groupTokens(tokens) {
  const words = [];
  let current = null;
  for (const token of tokens || []) {
    const text = typeof token.text === 'string' ? token.text : '';
    if (text.startsWith('[_')) continue;
    if (current === null || text.startsWith(' ')) {
      if (current !== null) words.push(current);
      current = { text: text.trimStart(), tokens: [token] };
    } else {
      current.text += text;
      current.tokens.push(token);
    }
  }
  if (current !== null) words.push(current);
  return words.filter((w) => w.text.trim() !== '');
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function _tokenSpan(tokens) {
  let start = null;
  let end = null;
  let sawInvalid = false;
  for (const t of tokens) {
    const o = _offsets(t);
    if (o === undefined) { sawInvalid = true; continue; }
    if (o === null) continue;
    if (start === null) start = o.from;
    end = o.to;
  }
  if (start === null) return { span: null, reason: sawInvalid ? 'token-offsets-invalid' : 'token-offsets-missing' };
  if (end < start) return { span: null, reason: 'token-offsets-invalid' };
  return { span: { from: start, to: end }, reason: null };
}

/**
 * Normalise whisper full JSON into timed words.
 *
 * @param {object} whisperJson  whisper --output-json-full result
 * @returns {{ words: object[], summary: object }}
 */
function normaliseWhisperWords(whisperJson) {
  const segments = (whisperJson && whisperJson.transcription) || [];

  // Pass 1: group and record raw evidence per word.
  const raw = [];
  segments.forEach((seg, segmentIndex) => {
    const segSpan = _offsets(seg);
    const grouped = (seg.tokens && seg.tokens.length > 0)
      ? groupTokens(seg.tokens)
      : String(seg.text || '').trim().split(/\s+/).filter(Boolean).map((text) => ({ text, tokens: [] }));
    grouped.forEach((g, i) => {
      raw.push({
        text: g.text.trim(),
        segmentIndex,
        segSpan,
        lastInSegment: i === grouped.length - 1,
        hasTokens: g.tokens.length > 0,
        anchor: g.tokens.length > 0 ? _anchorMs(g.tokens[0]) : null,
        tokenSpan: _tokenSpan(g.tokens),
      });
    });
  });

  // Pass 2: accept DTW anchors that keep the path monotonic.
  let lastAnchor = -Infinity;
  for (const r of raw) {
    if (r.anchor === null || r.anchor === undefined) {
      r.dtwOk = false;
      r.dtwReason = r.anchor === undefined ? 'dtw-anchor-invalid' : 'dtw-anchor-missing';
      continue;
    }
    if (r.anchor < lastAnchor) {
      r.dtwOk = false;
      r.dtwReason = 'dtw-anchor-non-monotonic';
      continue;
    }
    r.dtwOk = true;
    lastAnchor = r.anchor;
  }
  const anyDtw = raw.some((r) => r.dtwOk);

  // Pass 3: choose one source per word.
  const words = raw.map((r, index) => {
    const base = {
      index,
      text: r.text,
      segmentIndex: r.segmentIndex,
      startMs: null,
      endMs: null,
      anchorMs: null,
      timingSource: 'none',
      timingQuality: 'missing',
      timingFallback: null,
    };

    if (r.dtwOk) {
      base.anchorMs = r.anchor;
      base.startMs = r.anchor;
      base.endMs = _dtwEnd(raw, index);
      base.timingSource = 'dtw';
      base.timingQuality = 'anchor';
      return base;
    }

    // Only report a DTW fallback when DTW was present for this transcript
    // and the word had tokens that could have carried an anchor.
    const dtwReason = anyDtw && r.hasTokens ? r.dtwReason : null;

    if (r.tokenSpan.span) {
      base.startMs = r.tokenSpan.span.from;
      base.endMs = r.tokenSpan.span.to;
      base.timingSource = 'token';
      base.timingQuality = 'estimated';
      base.timingFallback = dtwReason;
      return base;
    }

    if (r.segSpan) {
      base.startMs = r.segSpan.from;
      base.endMs = r.segSpan.to;
      base.timingSource = 'segment';
      base.timingQuality = 'segment';
      base.timingFallback = dtwReason || r.tokenSpan.reason;
      return base;
    }

    base.timingFallback = r.segSpan === undefined ? 'segment-offsets-invalid' : (dtwReason || r.tokenSpan.reason);
    return base;
  });

  return { words, summary: summariseTiming(words) };
}

/** End of a DTW word: next onset in the segment, else segment end, else next onset anywhere. */
function _dtwEnd(raw, i) {
  const r = raw[i];
  const next = raw[i + 1];
  const nextAnchor = next && next.dtwOk && next.anchor > r.anchor ? next.anchor : null;
  if (!r.lastInSegment) return nextAnchor;
  if (r.segSpan && r.segSpan.to > r.anchor) return r.segSpan.to;
  return nextAnchor;
}

/** Count words per timing source, quality and fallback reason. */
function summariseTiming(words) {
  const summary = { words: words.length, bySource: {}, byQuality: {}, fallbacks: {}, missingEnd: 0 };
  for (const w of words) {
    summary.bySource[w.timingSource] = (summary.bySource[w.timingSource] || 0) + 1;
    summary.byQuality[w.timingQuality] = (summary.byQuality[w.timingQuality] || 0) + 1;
    if (w.timingFallback) summary.fallbacks[w.timingFallback] = (summary.fallbacks[w.timingFallback] || 0) + 1;
    if (w.startMs !== null && w.endMs === null) summary.missingEnd++;
  }
  return summary;
}

/**
 * Representative point used for speaker assignment (D1 rule 6). A DTW word
 * uses its anchor: on the gold episode anchors fell inside the aligned word
 * 77% of the time, while the midpoint of the derived span did so only 8%.
 * Other words use their span midpoint, or their start when the end is unknown.
 */
function wordPointMs(word) {
  if (word.timingSource === 'dtw' && word.anchorMs !== null && word.anchorMs !== undefined) return word.anchorMs;
  if (word.startMs === null || word.startMs === undefined) return null;
  if (word.endMs === null || word.endMs === undefined) return word.startMs;
  return (word.startMs + word.endMs) / 2;
}

module.exports = {
  normaliseWhisperWords,
  summariseTiming,
  groupTokens,
  wordPointMs,
};
