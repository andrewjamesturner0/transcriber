// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

/**
 * Speaker labelling availability and per-job options. No DOM dependencies.
 *
 * Speaker labelling is one switch with no partial mode: every labelled job
 * runs pyannote and word alignment. So the switch is usable only when both
 * the speaker model and the word alignment model are ready.
 *
 *   speakerLabelState() turns the two setup checks into what Settings shows.
 *   buildJobOptions() turns the current controls into the options object
 *   sent with each queued file (read when the file starts).
 */

// Python packages are installed by the user, outside the app. Until they
// are, neither model can be downloaded.
const PACKAGE_PROBLEMS = new Set([
  'python-missing', 'python-unsupported', 'pyannote-missing', 'pyannote-unsupported',
  'alignment-missing', 'alignment-unsupported',
]);

/**
 * @param {object} s
 * @param {string} s.diarizationStatus  from the Python check (diarize.py --check)
 * @param {string} s.alignmentStatus    from align.py --check for English, or
 *                                      'checking' / 'unavailable' when not run
 * @returns {{ ready: boolean, canDownload: boolean, needsToken: boolean }}
 *   ready        the "Label speakers" switch can be turned on
 *   canDownload  show the one "Download speaker models" button
 *   needsToken   the speaker model is missing, so the download needs a token
 */
function speakerLabelState({ diarizationStatus, alignmentStatus }) {
  const ready = diarizationStatus === 'ready' && alignmentStatus === 'ready';
  const packagesOk = !PACKAGE_PROBLEMS.has(diarizationStatus) && !PACKAGE_PROBLEMS.has(alignmentStatus);
  const missingModel = diarizationStatus === 'model-not-prepared' || alignmentStatus === 'model-not-prepared';
  return {
    ready,
    canDownload: packagesOk && missingModel,
    needsToken: diarizationStatus === 'model-not-prepared',
  };
}

/**
 * @param {object} c
 * @param {boolean} c.antiCorruption
 * @param {boolean} c.diarizationOn     the "Label speakers" switch is on
 * @param {string}  c.numSpeakers       'auto' or a number as text
 * @returns {object} options for window.api.transcribe
 */
function buildJobOptions({ antiCorruption, diarizationOn, numSpeakers }) {
  const options = { antiCorruption: !!antiCorruption };
  if (diarizationOn) {
    options.diarization = true;
    options.alignment = 'forced';
    if (numSpeakers && numSpeakers !== 'auto') options.numSpeakers = parseInt(numSpeakers, 10);
  }
  return options;
}

// ---------------------------------------------------------------------------
// Dual export (browser / Node)
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { speakerLabelState, buildJobOptions };
} else {
  window.jobOptions = { speakerLabelState, buildJobOptions };
}
