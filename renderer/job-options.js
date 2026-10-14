// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

/**
 * Per-job option rules (design decision D4). No DOM dependencies.
 *
 *   alignmentControlState() decides whether the "Align words to the audio"
 *   switch is shown, usable, and what its help line says.
 *   buildJobOptions() turns the current controls into the options object
 *   sent with each queued file (read when the file starts, like the other
 *   options).
 */

const ALIGNMENT_HELP = 'Re-times each word against the recording before speakers are assigned. Adds a short extra step.';

function alignmentHelpForStatus(status) {
  switch (status) {
    case 'ready': return ALIGNMENT_HELP;
    case 'model-not-prepared': return 'Not set up yet. Download the alignment model in Settings.';
    case 'alignment-missing':
    case 'alignment-unsupported': return 'Not installed. See the setup guide in Settings.';
    case 'checking': return 'Checking setup...';
    default: return 'Not available. See Settings, Speaker Diarization.';
  }
}

/**
 * @param {object} s
 * @param {boolean} s.diarizationOn     the Settings diarisation switch is on
 * @param {string}  s.alignmentStatus   status from align.py --check, or 'checking'
 * @returns {{ visible: boolean, enabled: boolean, help: string }}
 */
function alignmentControlState({ diarizationOn, alignmentStatus }) {
  const enabled = !!diarizationOn && alignmentStatus === 'ready';
  return {
    visible: !!diarizationOn,
    enabled,
    help: alignmentHelpForStatus(alignmentStatus),
  };
}

/**
 * @param {object} c
 * @param {boolean} c.antiCorruption
 * @param {boolean} c.diarizationOn
 * @param {string}  c.numSpeakers       'auto' or a number as text
 * @param {boolean} c.alignChecked      the alignment switch is on
 * @param {string}  c.alignmentStatus
 * @returns {object} options for window.api.transcribe
 */
function buildJobOptions({ antiCorruption, diarizationOn, numSpeakers, alignChecked, alignmentStatus }) {
  const options = { antiCorruption: !!antiCorruption };
  if (diarizationOn) {
    options.diarization = true;
    if (numSpeakers && numSpeakers !== 'auto') options.numSpeakers = parseInt(numSpeakers, 10);
    const state = alignmentControlState({ diarizationOn, alignmentStatus });
    options.alignment = state.enabled && alignChecked ? 'forced' : 'whisper';
  }
  return options;
}

// ---------------------------------------------------------------------------
// Dual export (browser / Node)
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { alignmentControlState, buildJobOptions, ALIGNMENT_HELP };
} else {
  window.jobOptions = { alignmentControlState, buildJobOptions, ALIGNMENT_HELP };
}
