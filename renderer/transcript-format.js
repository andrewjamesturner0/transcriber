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

// ---------------------------------------------------------------------------
// Rich transcript parsing
// ---------------------------------------------------------------------------

const MAX_SPEAKER_CLASS = 8;

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
    const match = line.match(/^\[Speaker (\d+)\]\s*(.*)/s);
    if (!match) continue;

    const originalNum = parseInt(match[1], 10);
    const speakerNum = Math.min(originalNum, MAX_SPEAKER_CLASS);
    const speakerText = match[2].trim();
    if (!speakerText) continue;

    segments.push({
      speakerNum,
      speakerLabel: String(originalNum),
      text: speakerText,
    });
  }

  return segments;
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
    parseRichTranscript,
    countPyannoteSpeakers,
    countWhisperSpeakerTurns,
  };
} else {
  window.transcriptFormat = {
    isPyannoteDiarized,
    formatDiarizedOutput,
    parseRichTranscript,
    countPyannoteSpeakers,
    countWhisperSpeakerTurns,
  };
}
