// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

/**
 * Time estimate lookup for model selection tooltip.
 * No DOM dependencies.
 */

const TIME_ESTIMATES = {
  tiny:          { ratio: '6x faster than realtime',   example: '~8 min',   quality: 'Fastest' },
  base:          { ratio: '3x faster than realtime',   example: '~15 min',  quality: 'Fast' },
  small:         { ratio: '1.5x faster than realtime', example: '~30 min',  quality: 'Balanced' },
  medium:        { ratio: '2x slower than realtime',   example: '~90 min',  quality: 'Accurate' },
  'large-turbo': { ratio: 'Near realtime',             example: '~50 min',  quality: 'Fast + accurate' },
  large:         { ratio: '3x slower than realtime',   example: '~150 min', quality: 'Most accurate' },
};

function getEstimateKey(modelId) {
  if (modelId.startsWith('large') && modelId.includes('turbo')) return 'large-turbo';
  for (const key of ['tiny', 'base', 'small', 'medium', 'large']) {
    if (modelId.startsWith(key)) return key;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dual export (browser / Node)
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TIME_ESTIMATES, getEstimateKey };
} else {
  window.timeEstimates = { TIME_ESTIMATES, getEstimateKey };
}
