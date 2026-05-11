// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

/**
 * Supported media file extensions and validation.
 * No DOM dependencies.
 */

const SUPPORTED_EXTENSIONS = new Set([
  'mp3', 'wav', 'flac', 'm4a', 'ogg', 'webm', 'wma', 'aac',
  'mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', '3gp',
]);

function isValidMediaFile(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// Dual export (browser / Node)
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SUPPORTED_EXTENSIONS, isValidMediaFile };
} else {
  window.mediaExtensions = { SUPPORTED_EXTENSIONS, isValidMediaFile };
}
