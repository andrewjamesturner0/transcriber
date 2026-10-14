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
 *   _buildWhisperArgs, _stripDtwArgs, _findDtwDisableWarning
 *     (exported for tests and scripts/test-whisper-dtw.js)
 *
 * DTW: whisper.cpp turns flash attention on by default and then disables
 * DTW with only a stderr warning (exit code 0). So a DTW request always
 * goes with --no-flash-attn, and stderr is watched for any "dtw ...
 * disabling" warning so the result can say DTW did not run.
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
      // DTW is silently disabled under flash attention (the default), so
      // the two flags always travel together.
      if (preset) args.push('--dtw', preset, '--no-flash-attn');
    }
  } else if (opts.outputJson) {
    args.push('--output-json-full', '-of', jsonPrefix);
  } else {
    args.push('--no-timestamps');
  }

  if (opts.antiCorruption) {
    args.push('-mc', '0', '--temperature', '0.4', '--entropy-thold', '1.8');
  }

  return args;
}

/** Return a copy of args without `--dtw <preset>` and `--no-flash-attn`. */
function _stripDtwArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dtw') { i++; continue; }
    if (args[i] === '--no-flash-attn') continue;
    out.push(args[i]);
  }
  return out;
}

// Matches e.g. "whisper_init_with_params_no_state: dtw_token_timestamps is
// not supported with flash_attn - disabling", or any other line that says
// DTW is being disabled. Also matches whisper-cli rejecting one of the DTW
// flags, because whisper-cli exits 0 after "error: unknown argument".
const DTW_DISABLE_WARNING_RE = /^[^\n]*(?:dtw[^\n]*disabl|not supported with flash_attn|unknown argument: (?:--dtw|--no-flash-attn)\b)[^\n]*$/im;

// Errors (non-zero exit) that mean the DTW request itself failed.
const DTW_ERROR_RE = /unknown DTW preset|unrecognized .*--dtw|DTW .* not (?:built|enabled|supported)|whisper_full.*dtw/i;

/** Return the first DTW-disable warning line in stderr text, or null. */
function _findDtwDisableWarning(stderrText) {
  const m = DTW_DISABLE_WARNING_RE.exec(stderrText || '');
  return m ? m[0].trim() : null;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a whisper runner with long-lived dependencies bound once.
 *
 * @param {object}   opts
 * @param {object}   opts.capabilities - { getActiveBackend, isDtwSupported(backend), disableDtw(backend), disableGpu }
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
   * @returns {Promise<{ output: string, backend: 'cpu'|'vulkan',
   *   dtw: { requested: boolean, preset: string|null, disabledReason: string|null } }>}
   *   dtw.requested is true when the job wanted DTW (diarised, non-tdrz model
   *   with a DTW preset). dtw.disabledReason is null only when the run that
   *   produced the output had the DTW flags and printed no disable warning.
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
    // DTW support is decided per executable, so args are built for a backend.
    const buildArgs = (forBackend) => _buildWhisperArgs(modelPath, wavPath, _jsonPrefix, options, modelSpec,
      () => capabilities.isDtwSupported(forBackend));

    const opts = options || {};
    const preset = (modelSpec && modelSpec.dtwPreset) || null;
    const dtwRequested = !!(opts.diarization && !(modelSpec && modelSpec.tdrz) && preset);

    const backendLabel = activeBackend === 'vulkan' ? 'Transcribing with GPU...' : 'Transcribing (CPU)...';
    onProgress(backendLabel);

    const run = await _runWithFallback(whisperBin, cpuWhisperBin, buildArgs, activeBackend, signal, onProgress);

    let disabledReason = null;
    if (dtwRequested) {
      if (run.dtwReason) {
        disabledReason = run.dtwReason;
      } else if (!run.args.includes('--dtw')) {
        disabledReason = `${run.backend} whisper-cli does not support --dtw with --no-flash-attn`;
      } else {
        const warning = _findDtwDisableWarning(run.stderr);
        if (warning) disabledReason = `whisper-cli disabled DTW: ${warning}`;
      }
      if (disabledReason) log(`[DTW] DTW requested (preset ${preset}) but did not run: ${disabledReason}`);
    }

    return {
      output: run.output,
      backend: run.backend,
      dtw: {
        requested: dtwRequested,
        preset: dtwRequested ? preset : null,
        disabledReason,
      },
    };
  }

  /** Spawn whisper once, collecting stderr for DTW warning checks. */
  async function _runOnce(bin, args, signal) {
    let stderr = '';
    const output = await _runProcess(bin, args, {
      ..._deps, signal, onStderr: (chunk) => { stderr += chunk; },
    });
    return { output: output.trim(), stderr };
  }

  /**
   * Core spawn + retry loop with DTW/GPU fallback classification.
   * Returns { output, backend, args, stderr, dtwReason } where args/stderr
   * belong to the run that succeeded and dtwReason is set when the DTW
   * retry path was taken.
   */
  async function _runWithFallback(whisperBin, cpuWhisperBin, buildArgs, backend, signal, onProgress) {
    const args = buildArgs(backend);
    try {
      const r = await _runOnce(whisperBin, args, signal);
      return { ...r, backend, args, dtwReason: null };
    } catch (err) {
      // Cancellation propagates immediately - no fallback
      if (err.message === 'Cancelled') throw err;

      // DTW fallback (checked before GPU fallback)
      if (DTW_ERROR_RE.test(err.message)) {
        log(`[DTW] DTW not supported by ${backend} whisper-cli (${err.message.trim()}), retrying without --dtw and --no-flash-attn`);
        capabilities.disableDtw(backend);
        const argsNoDtw = _stripDtwArgs(args);
        try {
          const r = await _runOnce(whisperBin, argsNoDtw, signal);
          return { ...r, backend, args: argsNoDtw, dtwReason: `DTW error, retried without --dtw: ${err.message.trim().split('\n')[0]}` };
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
        // DTW args must be valid for the CPU executable, not the GPU one.
        const cpuArgs = buildArgs('cpu');
        try {
          const r = await _runOnce(cpuWhisperBin, cpuArgs, signal);
          return { ...r, backend: 'cpu', args: cpuArgs, dtwReason: null };
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

module.exports = { createWhisperRunner, _buildWhisperArgs, _stripDtwArgs, _findDtwDisableWarning };
