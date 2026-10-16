// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

/**
 * Pure transcript formatting and parsing functions.
 * No DOM dependencies. Testable in plain Node.
 */

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function isPyannoteDiarized(text) {
  return /\[\d+ speakers? detected\]/.test(text);
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatDiarizedOutput(text) {
  // Pyannote-diarized text already has [Speaker N] labels - pass through
  if (isPyannoteDiarized(text)) {
    return text;
  }

  if (!text.includes('[SPEAKER_TURN]')) {
    return text;
  }
  // Strip whisper timestamp lines like "[00:00:00.000 --> 00:05:00.000]  "
  text = text.replace(/\[\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\]\s*/g, '');

  return text
    .split('[SPEAKER_TURN]')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n--- Speaker Change ---\n\n');
}

/** Assemble canonical copy/save text for the successful files in one run. */
function formatBatchText(results) {
  if (results.length === 0) return '';
  if (results.length === 1) return results[0].text;
  return results.map(({ fileName, text }) => `=== ${fileName} ===\n\n${text}`).join('\n\n\n');
}

// ---------------------------------------------------------------------------
// Rich transcript parsing
// ---------------------------------------------------------------------------

const MAX_SPEAKER_CLASS = 8;

function speakerSegment(label, text) {
  if (label === 'Unknown') return { speakerNum: 0, speakerLabel: 'Unknown', text };
  const number = /^Speaker (\d+)$/.exec(label);
  if (!number) return { speakerNum: 0, speakerLabel: 'Unknown', text };
  return {
    speakerNum: Math.max(1, Math.min(Number(number[1]), MAX_SPEAKER_CLASS)),
    speakerLabel: String(Number(number[1])),
    text,
  };
}

/**
 * Parse pyannote-diarized text into structured speaker segments.
 * Returns triples with the original speaker label (for display) and
 * the CSS-safe speaker number (clamped to MAX_SPEAKER_CLASS).
 *
 * @param {string} text
 * @returns {Array<{ speakerNum: number, speakerLabel: string, text: string }>}
 */
function parseRichTranscript(text) {
  const segments = [];
  // Strip leading "[N speakers detected]" header
  const body = text.replace(/^\[\d+ speakers? detected\]\n\n/, '');

  for (const line of body.split('\n\n')) {
    const match = line.match(/^\[(Speaker \d+|Unknown)\]\s*(.*)/s);
    if (!match) continue;

    const speakerText = match[2].trim();
    if (!speakerText) continue;

    segments.push(speakerSegment(match[1], speakerText));
  }

  return segments;
}

/** Read actual attribution blocks; canonical text is reserved for copy/save. */
function getTranscriptSegments(result) {
  if (!result.transcript || result.transcript.kind !== 'speaker-labelled') {
    const text = formatDiarizedOutput(result.text);
    return text ? [{ speakerNum: 0, speakerLabel: null, text }] : [];
  }
  return result.transcript.blocks
    .filter((block) => block.text.trim())
    .map((block) => speakerSegment(block.speaker, block.text));
}

// ---------------------------------------------------------------------------
// Speaker counting
// ---------------------------------------------------------------------------

function countPyannoteSpeakers(text) {
  const matches = text.match(/\[Speaker \d+\]/g) || [];
  const labels = [...new Set(matches)];
  return { count: labels.length, labels };
}

function countWhisperSpeakerTurns(text) {
  return (text.match(/\[SPEAKER_TURN\]/g) || []).length;
}

// ---------------------------------------------------------------------------
// Dual export (browser / Node)
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isPyannoteDiarized,
    formatDiarizedOutput,
    formatBatchText,
    parseRichTranscript,
    getTranscriptSegments,
    countPyannoteSpeakers,
    countWhisperSpeakerTurns,
  };
} else {
  window.transcriptFormat = {
    isPyannoteDiarized,
    formatDiarizedOutput,
    formatBatchText,
    parseRichTranscript,
    getTranscriptSegments,
    countPyannoteSpeakers,
    countWhisperSpeakerTurns,
  };
}
