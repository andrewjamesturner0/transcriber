/**
 * Diarisation merge pipeline — shared between main.js and test-merge.js.
 *
 * Converts whisper --output-json-full and pyannote speaker segments into
 * a speaker-labeled transcript with word-level alignment.  Runs five stages:
 *
 *   0. mergeDiarizeSegments()          — clean up pyannote output
 *   1. groupTokensToWords()            — whisper tokens -> timed words
 *   2. assignWordsToSpeakers()         — midpoint / overlap / gap-fill
 *   3. refineSpeakerBoundaries()       — snap to pyannote boundaries
 *   4. smoothSpeakerAssignments()      — correct remaining isolated mislabels
 *
 * The exported mergeTranscriptWithDiarization() orchestrates all stages
 * plus a post-collapse short-block merge.
 *
 * Set DIARIZE_DEBUG=1 for per-stage diff logging (goes to console.error).
 */

// ---------------------------------------------------------------------------
// Tunables — single flat object so tests can override any field in one call
// ---------------------------------------------------------------------------
const DEFAULTS = {
  // mergeDiarizeSegments: gap (seconds) below which adjacent same-speaker
  // pyannote segments are merged into one.
  mergeGapSec: 0.5,

  // mergeDiarizeSegments: maximum duration (seconds) of a segment that gets
  // absorbed when flanked by the same speaker on both sides.
  absorbShortSegSec: 0.3,

  // refineSpeakerBoundaries: maximum distance (seconds) between a pyannote
  // boundary and a word for snapping to apply.
  boundarySnapMaxDistSec: 3.0,

  // smoothSpeakerAssignments: maximum consecutive-run length that gets
  // corrected when flanking words agree on a different speaker.
  smoothingMaxRunLen: 2,

  // mergeShortBlocks: maximum word count for a block to be considered
  // "short" and eligible for merging.
  shortBlockMaxWords: 3,

  // mergeShortBlocks: maximum duration (seconds) for a short block to be
  // merged.  Blocks longer than this are kept even if they are few words.
  shortBlockMaxDurationSec: 2.0,

  // refineSpeakerBoundaries: when processing an A→B boundary and a word
  // at the snap point is labelled C (a third speaker), only reassign if
  // no other C labels appear within this many seconds around the boundary.
  boundaryThirdSpeakerWindowSec: 2.0,

  // assignWordsToSpeakers: maximum distance (seconds) from a pyannote segment
  // for the nearest-segment last-resort fallback to apply.
  nearestSegMaxDistSec: 5.0,
};

// ---------------------------------------------------------------------------
// Stage 0 — pyannote segment clean-up
// ---------------------------------------------------------------------------

/**
 * Merge adjacent same-speaker segments separated by < mergeGapSec gap,
 * and absorb very short segments (< absorbShortSegSec) that are flanked
 * by same-speaker segments.  Single left-to-right pass.
 */
function mergeDiarizeSegments(segments, config) {
  const { mergeGapSec, absorbShortSegSec } = config || DEFAULTS;
  if (!segments || segments.length <= 1) return segments;

  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const out = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const prev = out[out.length - 1];
    const next = i + 1 < sorted.length ? sorted[i + 1] : null;

    // Absorb very short segment when flanked by the same speaker
    if (cur.end - cur.start < absorbShortSegSec && next &&
        prev.speaker === next.speaker) {
      prev.end = Math.max(prev.end, cur.end);
      continue;
    }

    // Merge adjacent same-speaker segments
    if (cur.speaker === prev.speaker && cur.start - prev.end < mergeGapSec) {
      prev.end = Math.max(prev.end, cur.end);
    } else {
      out.push({ ...cur });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Stage 1 — token grouping
// ---------------------------------------------------------------------------

/**
 * Group a whisper segment's token array into words with accumulated
 * start / end timestamps.  Tokens with no offsets inherit the previous
 * token's end time as their bound.
 */
function groupTokensToWords(tokens) {
  const words = [];
  let current = null;
  let prevEndMs = null;

  for (const token of tokens) {
    if (token.text.startsWith('[_')) continue;

    const hasOffsets = token.offsets !== undefined;
    const tokenStartMs = hasOffsets ? token.offsets.from : prevEndMs;
    const tokenEndMs = hasOffsets ? token.offsets.to : prevEndMs;

    if (current === null || token.text.startsWith(' ')) {
      if (current !== null) words.push(current);
      current = { text: token.text.trimStart(), startMs: tokenStartMs, endMs: tokenEndMs };
    } else {
      current.text += token.text;
      if (tokenEndMs !== null) current.endMs = tokenEndMs;
    }

    if (hasOffsets) prevEndMs = token.offsets.to;
  }

  if (current !== null) words.push(current);
  return words;
}

// ---------------------------------------------------------------------------
// Stage 2 — word-to-speaker assignment
// ---------------------------------------------------------------------------

/**
 * Assign each word to a speaker using midpoint containment, falling back
 * to max temporal overlap when no segment contains the midpoint, and
 * finally to the nearest segment by time distance when there is no overlap.
 */
function assignWordsToSpeakers(words, diarizeSegments, config) {
  const { nearestSegMaxDistSec } = config || DEFAULTS;
  return words.map((word) => {
    const wordStart = word.startMs !== null ? word.startMs / 1000 : null;
    const wordEnd = word.endMs !== null ? word.endMs / 1000 : null;

    // Skip midpoint check when timestamps are missing
    if (wordStart !== null && wordEnd !== null) {
      const midpoint = (wordStart + wordEnd) / 2;
      for (const ds of diarizeSegments) {
        if (midpoint >= ds.start && midpoint <= ds.end) {
          return { ...word, speaker: ds.speaker };
        }
      }
    }

    // Fallback 1: max temporal overlap
    let bestSpeaker = null;
    let bestOverlap = 0;
    if (wordStart !== null && wordEnd !== null) {
      for (const ds of diarizeSegments) {
        const overlapStart = Math.max(wordStart, ds.start);
        const overlapEnd = Math.min(wordEnd, ds.end);
        const overlap = Math.max(0, overlapEnd - overlapStart);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestSpeaker = ds.speaker;
        }
      }
    }

    // Fallback 2: nearest segment by time distance (fills pyannote gaps)
    // Only reassigns words within 5s of a segment to avoid labelling far-away words.
    if (!bestSpeaker && wordStart !== null) {
      let bestDist = Infinity;
      for (const ds of diarizeSegments) {
        const dist = Math.min(
          Math.abs(wordStart - ds.start),
          Math.abs(wordStart - ds.end)
        );
        if (dist < bestDist) {
          bestDist = dist;
          bestSpeaker = ds.speaker;
        }
      }
      if (bestDist >= nearestSegMaxDistSec) bestSpeaker = null;
    }

    return { ...word, speaker: bestSpeaker };
  });
}

// ---------------------------------------------------------------------------
// Stage 3 — boundary refinement
// ---------------------------------------------------------------------------

/**
 * Snap words to the correct side of pyannote speaker boundaries.
 *
 * Each word is snapped to its nearest boundary (within boundarySnapMaxDistSec).
 * Words labelled prevSpeaker or nextSpeaker are reassigned to the speaker
 * on their side of the boundary.  Third-speaker words at a 2-speaker boundary
 * are reassigned only if no other same-speaker word appears nearby (isolation
 * check).  Touched words are flagged so smoothing does not undo the snap.
 */
function refineSpeakerBoundaries(labeled, diarizeSegments, config) {
  const { boundarySnapMaxDistSec, boundaryThirdSpeakerWindowSec } = config || DEFAULTS;
  if (labeled.length < 2 || diarizeSegments.length < 2) return labeled;

  // Build speaker-change boundaries
  const boundaries = [];
  for (let i = 1; i < diarizeSegments.length; i++) {
    const prev = diarizeSegments[i - 1];
    const next = diarizeSegments[i];
    if (prev.speaker !== next.speaker) {
      boundaries.push({
        timeSec: next.start,
        prevSpeaker: prev.speaker,
        nextSpeaker: next.speaker,
      });
    }
  }

  if (boundaries.length === 0) return labeled;

  const result = labeled.map((w) => ({ ...w }));

  for (let j = 0; j < result.length; j++) {
    if (result[j].isSegLevel) continue;
    if (result[j].wordMidSec == null) continue;

    // Find nearest boundary
    let bestB = null;
    let bestDist = Infinity;
    for (const b of boundaries) {
      const dist = Math.abs(result[j].wordMidSec - b.timeSec);
      if (dist < bestDist && dist <= boundarySnapMaxDistSec) {
        bestDist = dist;
        bestB = b;
      }
    }

    if (!bestB) continue;

    const { prevSpeaker, nextSpeaker } = bestB;
    const wordSpeaker = result[j].speaker;

    // Third-speaker isolation check
    if (wordSpeaker !== null && wordSpeaker !== prevSpeaker && wordSpeaker !== nextSpeaker) {
      let hasNearby = false;
      const wordMid = result[j].wordMidSec;
      for (let k = 0; k < result.length; k++) {
        if (k === j) continue;
        if (result[k].isSegLevel || result[k].wordMidSec == null) continue;
        if (result[k].speaker !== wordSpeaker) continue;
        if (Math.abs(result[k].wordMidSec - wordMid) < boundaryThirdSpeakerWindowSec) {
          hasNearby = true;
          break;
        }
      }
      if (!hasNearby) {
        result[j].speaker = wordMid < bestB.timeSec ? prevSpeaker : nextSpeaker;
        result[j]._nearBoundary = true;
      }
      continue;
    }

    // Snap to correct side of boundary (flag even if already correct)
    if (wordSpeaker === prevSpeaker || wordSpeaker === nextSpeaker) {
      result[j].speaker = result[j].wordMidSec < bestB.timeSec ? prevSpeaker : nextSpeaker;
      result[j]._nearBoundary = true;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Stage 4 — smoothing
// ---------------------------------------------------------------------------

/**
 * Iteratively correct runs of misassigned words where flanking words agree
 * on a different speaker. Runs multiple passes with increasing run length
 * (1 .. smoothingMaxRunLen) and repeats each pass to convergence.
 */
function smoothSpeakerAssignments(labeled, config) {
  const { smoothingMaxRunLen } = config || DEFAULTS;
  if (labeled.length < 3) return labeled;
  const result = labeled.map((w) => ({ ...w }));

  for (let runLen = 1; runLen <= smoothingMaxRunLen; runLen++) {
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 1; i < result.length - runLen; i++) {
        const left = result[i - 1];
        const right = result[i + runLen];
        if (left.speaker !== right.speaker) continue;
        if (left.isSegLevel || right.isSegLevel) continue;

        const runSpeakers = new Set();
        let hasSegLevel = false;
        let nearBoundary = false;
        for (let j = 0; j < runLen; j++) {
          if (result[i + j].isSegLevel) { hasSegLevel = true; break; }
          if (result[i + j]._nearBoundary) { nearBoundary = true; break; }
          runSpeakers.add(result[i + j].speaker);
        }
        if (hasSegLevel || nearBoundary) continue;

        if (!runSpeakers.has(left.speaker)) {
          for (let j = 0; j < runLen; j++) {
            result[i + j].speaker = left.speaker;
          }
          changed = true;
        }
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Post-collapse short-block merge
// ---------------------------------------------------------------------------

/**
 * Merge short blocks that are flanked by the same speaker on both sides.
 * A block is "short" when BOTH its word count <= shortBlockMaxWords AND its
 * duration <= shortBlockMaxDurationSec.
 */
function mergeShortBlocks(blocks, config) {
  const { shortBlockMaxWords, shortBlockMaxDurationSec } = config || DEFAULTS;
  if (blocks.length < 3) return blocks;
  const result = [...blocks];
  for (let i = 1; i < result.length - 1; i++) {
    const prev = result[i - 1];
    const cur = result[i];
    const next = result[i + 1];
    if (prev.speaker === next.speaker && cur.speaker !== prev.speaker) {
      const wordCount = cur.text.split(/\s+/).length;
      if (wordCount > shortBlockMaxWords) continue;

      // Duration check: use block-level startSec/endSec when available
      const duration = (cur.endSec != null && cur.startSec != null)
        ? cur.endSec - cur.startSec
        : 0;
      if (cur.endSec != null && cur.startSec != null && duration > shortBlockMaxDurationSec) continue;

      prev.text += ' ' + cur.text;
      // Extend the prev block's time span
      if (cur.startSec != null && (prev.startSec == null || cur.startSec < prev.startSec)) {
        prev.startSec = cur.startSec;
      }
      if (cur.endSec != null && (prev.endSec == null || cur.endSec > prev.endSec)) {
        prev.endSec = cur.endSec;
      }
      result.splice(i, 1);
      i--;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Full merge pipeline: whisper full JSON + pyannote speaker segments →
 * speaker-labeled transcript.
 *
 * @param {object} whisperJson   whisper --output-json-full result
 * @param {array}  diarizeSegments  pyannote segments [{start, end, speaker}]
 * @param {object} configOverrides  optional partial overrides for DEFAULTS
 * @returns {string} formatted transcript with [Speaker N] labels
 */
function mergeTranscriptWithDiarization(whisperJson, diarizeSegments, configOverrides) {
  const config = configOverrides ? { ...DEFAULTS, ...configOverrides } : DEFAULTS;
  const debug = !!(config.debug || (typeof process !== 'undefined' && process.env && process.env.DIARIZE_DEBUG === '1'));

  const log = (msg) => {
    if (debug) console.error(`[diarize-merge] ${msg}`);
  };

  // Stage 0: sort segments by start time, then clean / merge
  const sorted = [...diarizeSegments].sort((a, b) => a.start - b.start);
  log(`mergeDiarizeSegments: ${sorted.length} segments in`);
  const cleanedSegments = mergeDiarizeSegments(sorted, config);
  log(`mergeDiarizeSegments: ${cleanedSegments.length} segments out`);

  const speakerIds = [...new Set(cleanedSegments.map((s) => s.speaker))];
  const speakerLabels = {};
  speakerIds.forEach((id, i) => { speakerLabels[id] = `Speaker ${i + 1}`; });

  const allWords = [];

  for (const seg of (whisperJson.transcription || [])) {
    let words = null;

    if (seg.tokens && seg.tokens.length > 0) {
      const grouped = groupTokensToWords(seg.tokens);
      if (grouped.length > 0 && grouped.some((w) => w.startMs !== null || w.endMs !== null)) {
        words = grouped;
      }
    }

    if (!words) {
      const text = seg.text ? seg.text.trim() : '';
      if (text) {
        words = [{
          text,
          startMs: seg.offsets ? seg.offsets.from : null,
          endMs: seg.offsets ? seg.offsets.to : null,
          isSegLevel: true,
        }];
      }
    }

    if (words) allWords.push(...words);
  }

  log(`assignWordsToSpeakers: ${allWords.length} words in`);

  const rawLabeled = assignWordsToSpeakers(allWords, cleanedSegments, config).map((w) => ({
    speaker: w.speaker || null,
    text: w.text.trim(),
    isSegLevel: w.isSegLevel || false,
    wordMidSec: (w.startMs != null && w.endMs != null) ? (w.startMs + w.endMs) / 2000 : null,
    startMs: w.startMs,
    endMs: w.endMs,
  }));

  log(`refineSpeakerBoundaries: ${rawLabeled.length} words in, ${cleanedSegments.length} segments`);

  const refined = refineSpeakerBoundaries(rawLabeled, cleanedSegments, config);

  if (debug) {
    let changed = 0;
    let boundaryCount = 0;
    for (let i = 1; i < cleanedSegments.length; i++) {
      if (cleanedSegments[i - 1].speaker !== cleanedSegments[i].speaker) boundaryCount++;
    }
    for (let i = 0; i < refined.length; i++) {
      if (refined[i].speaker !== rawLabeled[i].speaker) changed++;
    }
    log(`refineSpeakerBoundaries: ${refined.length} words out, ${changed} reassigned, ${boundaryCount} pyannote boundaries`);
  }

  log(`smoothSpeakerAssignments: ${refined.length} words in`);

  const smoothed = smoothSpeakerAssignments(refined, config);

  if (debug) {
    let changed = 0;
    for (let i = 0; i < smoothed.length; i++) {
      if (smoothed[i].speaker !== refined[i].speaker) changed++;
    }
    log(`smoothSpeakerAssignments: ${smoothed.length} words out, ${changed} reassigned`);
  }

  const labeled = smoothed.map((w) => ({
    speaker: w.speaker ? speakerLabels[w.speaker] || 'Unknown' : 'Unknown',
    text: w.text,
    startSec: w.startMs != null ? w.startMs / 1000 : w.wordMidSec,
    endSec: w.endMs != null ? w.endMs / 1000 : w.wordMidSec,
  }));

  // Collapse consecutive same-speaker blocks, tracking per-block time span
  const collapsed = [];
  for (const item of labeled) {
    if (!item.text) continue;
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.speaker === item.speaker) {
      prev.text += ' ' + item.text;
      if (item.startSec != null) {
        if (prev.startSec == null || item.startSec < prev.startSec) prev.startSec = item.startSec;
        if (prev.endSec == null || item.endSec > prev.endSec) prev.endSec = item.endSec;
      }
    } else {
      collapsed.push({
        speaker: item.speaker,
        text: item.text,
        startSec: item.startSec,
        endSec: item.endSec,
      });
    }
  }

  log(`mergeShortBlocks: ${collapsed.length} blocks in`);

  const merged = mergeShortBlocks(collapsed, config);

  log(`mergeShortBlocks: ${merged.length} blocks out (${collapsed.length - merged.length} merged)`);

  const speakerCount = speakerIds.length;
  const header = `[${speakerCount} speaker${speakerCount !== 1 ? 's' : ''} detected]\n\n`;
  const body = merged.map((s) => `[${s.speaker}] ${s.text}`).join('\n\n');
  return header + body;
}

module.exports = {
  DEFAULTS,
  mergeDiarizeSegments,
  groupTokensToWords,
  assignWordsToSpeakers,
  smoothSpeakerAssignments,
  refineSpeakerBoundaries,
  mergeShortBlocks,
  mergeTranscriptWithDiarization,
};
