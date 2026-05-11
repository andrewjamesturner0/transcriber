// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

/**
 * Whisper invocation + retry policy.
 *
 * Owns whisper arg construction, backend resolution, process spawning,
 * and GPU/DTW fallback retry. Extracted from lib/transcription-runner.js.
 *
 * Exports:
 *   createWhisperRunner({ capabilities, paths, spawn, log })
 *     -> { transcribe({ modelSpec, modelPath, wavPath, options, signal, onProgress }) }
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { _runProcess } = require('./_subprocess');

// ---------------------------------------------------------------------------
// Internal: whisper arg construction
// ---------------------------------------------------------------------------

function _buildWhisperArgs(modelPath, wavPath, jsonPrefix, options, modelSpec, isDtwSupportedFn) {
  const opts = options || {};
  const threads = opts.threads || 4;
  const args = [
    '-m', modelPath,
    '-f', wavPath,
    '-t', String(threads),
  ];

  if (modelSpec && modelSpec.tdrz) {
    args.push('--tinydiarize');
  } else if (opts.diarization) {
    args.push('--output-json-full', '-of', jsonPrefix);
    if (isDtwSupportedFn()) {
      const preset = modelSpec && modelSpec.dtwPreset;
      if (preset) args.push('--dtw', preset);
    }
  } else {
    args.push('--no-timestamps');
  }

  if (opts.antiCorruption) {
    args.push('-mc', '0', '--temperature', '0.4', '--entropy-thold', '1.8');
  }

  return args;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a whisper runner with long-lived dependencies bound once.
 *
 * @param {object}   opts
 * @param {object}   opts.capabilities - { getActiveBackend, isDtwSupported, disableDtw, disableGpu }
 * @param {object}   opts.paths        - { getWhisperBinary, makeEnvWithLibPath }
 * @param {Function} opts.spawn        - child_process.spawn (or mock)
 * @param {Function} opts.log          - log writer
 * @returns {{ transcribe: Function }}
 */
function createWhisperRunner({ capabilities, paths, spawn, log, tmpDir }) {
  const _deps = { spawn, makeEnvWithLibPath: paths.makeEnvWithLibPath, log };
  const _tmpDir = tmpDir || os.tmpdir();

  /**
   * Run whisper transcription with retry/fallback policy.
   *
   * @param {object}       params
   * @param {object}       params.modelSpec   - model entry from lib/models.js (has tdrz, dtwPreset)
   * @param {string}       params.modelPath   - absolute path to the .bin model file
   * @param {string}       params.wavPath     - path to 16kHz mono WAV
   * @param {object}       params.options     - { diarization, antiCorruption, threads? }
   * @param {AbortSignal}  [params.signal]    - abort signal
   * @param {Function}     params.onProgress  - status message callback (msg: string)
   * @returns {Promise<{ output: string, backend: 'cpu'|'vulkan' }>}
   */
  async function transcribe({ modelSpec, modelPath, wavPath, options, signal, onProgress, jsonPrefix }) {
    const backend = capabilities.getActiveBackend();
    let whisperBin = paths.getWhisperBinary(backend);

    // Fall back to CPU if chosen backend binary missing
    if (!fs.existsSync(whisperBin) && backend === 'vulkan') {
      log(`[GPU] Vulkan binary not found, falling back to CPU`);
      whisperBin = paths.getWhisperBinary('cpu');
    }

    const cpuWhisperBin = paths.getWhisperBinary('cpu');
    const activeBackend = (whisperBin === cpuWhisperBin) ? 'cpu' : backend;

    const _jsonPrefix = jsonPrefix || path.join(_tmpDir, `whisper_out_${Date.now()}`);
    const args = _buildWhisperArgs(modelPath, wavPath, _jsonPrefix, options, modelSpec,
      capabilities.isDtwSupported.bind(capabilities));

    const backendLabel = activeBackend === 'vulkan' ? 'Transcribing with GPU...' : 'Transcribing (CPU)...';
    onProgress(backendLabel);

    return _runWithFallback(whisperBin, cpuWhisperBin, args, activeBackend, signal, onProgress);
  }

  /**
   * Core spawn + retry loop with DTW/GPU fallback classification.
   */
  async function _runWithFallback(whisperBin, cpuWhisperBin, args, backend, signal, onProgress) {
    try {
      const output = await _runProcess(whisperBin, args, { ..._deps, signal });
      return { output: output.trim(), backend };
    } catch (err) {
      // Cancellation propagates immediately - no fallback
      if (err.message === 'Cancelled') throw err;

      // DTW fallback
      if (/unknown DTW preset|unrecognized .*--dtw|DTW .* not (?:built|enabled|supported)|whisper_full.*dtw/i.test(err.message)) {
        log(`[DTW] DTW not supported (${err.message.trim()}), retrying without --dtw`);
        capabilities.disableDtw();
        const dtw = args.indexOf('--dtw');
        const argsNoDtw = dtw >= 0 ? args.filter((_, i) => i !== dtw && i !== dtw + 1) : args;
        try {
          const output = await _runProcess(whisperBin, argsNoDtw, { ..._deps, signal });
          return { output: output.trim(), backend };
        } catch (retryErr) {
          log(`[DTW] Retry without --dtw also failed: ${retryErr.message}`);
          if (retryErr.message === 'Cancelled') throw retryErr;
          throw err;
        }
      }

      // GPU fallback
      if (backend === 'vulkan') {
        log(`[GPU] Vulkan transcription failed (${err.message}), falling back to CPU`);
        const isOOM = /OutOfDeviceMemory|failed to allocate/i.test(err.message);
        if (!isOOM) capabilities.disableGpu();
        const fallbackMsg = isOOM
          ? 'Model too large for GPU memory - retrying with CPU...'
          : 'GPU unavailable - retrying with CPU...';
        onProgress(fallbackMsg);
        try {
          const output = await _runProcess(cpuWhisperBin, args, { ..._deps, signal });
          return { output: output.trim(), backend: 'cpu' };
        } catch (retryErr) {
          log(`[GPU] CPU fallback also failed: ${retryErr.message}`);
          if (retryErr.message === 'Cancelled') throw retryErr;
          throw err;
        }
      }

      throw err;
    }
  }

  return { transcribe };
}

module.exports = { createWhisperRunner };
