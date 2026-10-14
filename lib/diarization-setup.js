// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

/**
 * User-directed model setup (design decision D2).
 *
 * Runs scripts/setup-diarization.py with the same Python the jobs use. This
 * is the only place the app downloads speaker (or, later, alignment)
 * models; transcription jobs are cache-only. The token goes to the child
 * through its environment, never its command line.
 *
 * Exports:
 *   createDiarizationSetup({ capabilities, paths, spawn, log })
 *     -> { prepare({ token, alignment?, signal?, onProgress? }) -> summary }
 */

const path = require('path');
const fs = require('fs');
const { runJsonHelper } = require('./_subprocess');

function createDiarizationSetup({ capabilities, paths, spawn, log }) {
  const deps = { spawn, makeEnvWithLibPath: paths.makeEnvWithLibPath, log };

  /**
   * @param {object}   params
   * @param {string}   params.token        Hugging Face read token
   * @param {boolean}  [params.alignment]  also prepare the alignment model
   * @param {AbortSignal} [params.signal]
   * @param {Function} [params.onProgress] ({ message, percent }) callback
   * @returns {Promise<object>} the helper's JSON summary (status, model, versions, ...)
   */
  async function prepare({ token, alignment, signal, onProgress = () => {} }) {
    const python = await capabilities.getPythonSpawn();
    if (!python) throw new Error('Python 3.10 or later was not found');
    const script = paths.getResourcePath(path.join('scripts', 'setup-diarization.py'));
    if (!fs.existsSync(script)) throw new Error('Setup script not found');

    const args = [...python.args, script];
    if (alignment) args.push('--alignment');

    const stdout = await runJsonHelper(python.command, args, {
      ...deps,
      signal,
      extraEnv: token ? { HF_TOKEN: token } : {},
      onMessage: (m) => {
        if (!m.error && m.message) onProgress({ message: m.message, percent: m.percent });
      },
    });
    const last = stdout.trim().split('\n').pop();
    let summary;
    try { summary = JSON.parse(last); } catch (_) { throw new Error('Setup finished without a readable summary'); }
    // Later jobs must see the new cache state.
    if (typeof capabilities.getPythonInfo === 'function') await capabilities.getPythonInfo({ refresh: true });
    return summary;
  }

  return { prepare };
}

module.exports = { createDiarizationSetup };
