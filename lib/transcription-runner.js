// Transcriber — local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

/**
 * Transcription pipeline runner.
 *
 * Orchestrates the FFmpeg → whisper → diarize pipeline that was
 * previously inlined in the `transcribe` IPC handler in main.js.
 * All dependencies (binary paths, spawn, callbacks, capability flags)
 * are injected via the `context` object for testability.
 *
 * Exports:
 *   runTranscription(filePath, modelId, options, context) → transcript string
 *   runDiarizationOnly(wavPath, options, context)        → diarize segments array
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------
// Internal: runProcess
// ---------------------------------------------------------------------------

/**
 * Spawn a subprocess and return its stdout. Handles logging, abort signals,
 * env setup, and optional stderr callback. Throws on non-zero exit or error.
 */
function _runProcess(cmd, args, { signal, onStderr, spawn, makeEnvWithLibPath, log }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      return reject(new Error('Cancelled'));
    }

    const cmdName = path.basename(cmd);
    const safeArgs = args.map((a, i) => {
      if (args[i - 1] === '--hf-token' || (typeof a === 'string' && a.startsWith('hf_'))) return 'hf_***';
      return a.includes(' ') ? `"${a}"` : a;
    });
    log(`[RUN] ${cmdName} ${safeArgs.join(' ')}`);

    const env = makeEnvWithLibPath(path.dirname(cmd));
    const proc = spawn(cmd, args, { env });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      const chunk = d.toString();
      stdout += chunk;
      log(`[STDOUT:${cmdName}] ${chunk.trimEnd()}`);
    });
    proc.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      log(`[STDERR:${cmdName}] ${chunk.trimEnd()}`);
      if (onStderr) onStderr(chunk);
    });
    proc.on('close', (code) => {
      log(`[EXIT:${cmdName}] code=${code}`);
      if (signal && signal.aborted) reject(new Error('Cancelled'));
      else if (code === 0) resolve(stdout);
      else reject(new Error(`Process exited with code ${code}: ${stderr}`));
    });
    proc.on('error', (err) => {
      log(`[ERROR:${cmdName}] ${err.message}`);
      reject(err);
    });

    if (signal) {
      const onAbort = () => {
        proc.kill();
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort);
      proc.on('close', () => signal.removeEventListener('abort', onAbort));
    }
  });
}

// ---------------------------------------------------------------------------
// Internal: FFmpeg step
// ---------------------------------------------------------------------------

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', '3gp'];

function _runFfmpeg(filePath, tmpWav, ctx) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const isVideo = VIDEO_EXTENSIONS.includes(ext);
  ctx.onProgress(isVideo ? 'Extracting audio...' : 'Converting audio...');
  return _runProcess(ctx.ffmpegBinary, [
    '-i', filePath,
    '-ar', '16000',
    '-ac', '1',
    '-c:a', 'pcm_s16le',
    '-y', tmpWav,
  ], ctx);
}

// ---------------------------------------------------------------------------
// Internal: whisper arg construction
// ---------------------------------------------------------------------------

function _buildWhisperArgs(modelPath, tmpWav, jsonPrefix, options, ctx) {
  const args = [
    '-m', modelPath,
    '-f', tmpWav,
    '-t', String(ctx.threads),
  ];

  if (ctx.modelConfig && ctx.modelConfig.tdrz) {
    args.push('--tinydiarize');
  } else if (options.diarization) {
    args.push('--output-json-full', '-of', jsonPrefix);
    if (ctx.isDtwSupported()) {
      const preset = ctx.dtwPresets[options.modelId];
      if (preset) args.push('--dtw', preset);
    }
  } else {
    args.push('--no-timestamps');
  }

  if (options.antiCorruption) {
    args.push('-mc', '0', '--temperature', '0.4', '--entropy-thold', '1.8');
  }

  return args;
}

// ---------------------------------------------------------------------------
// Internal: whisper with fallback chain
// ---------------------------------------------------------------------------

async function _runWhisper(whisperBin, args, backend, ctx) {
  try {
    const output = await _runProcess(whisperBin, args, ctx);
    return { output, backend };
  } catch (err) {
    if (err.message !== 'Cancelled' && /unknown DTW preset|unrecognized .*--dtw|DTW .* not (?:built|enabled|supported)|whisper_full.*dtw/i.test(err.message)) {
      ctx.log(`[DTW] DTW not supported (${err.message.trim()}), retrying without --dtw`);
      ctx.disableDtw();
      const dtw = args.indexOf('--dtw');
      const argsNoDtw = dtw >= 0 ? args.filter((_, i) => i !== dtw && i !== dtw + 1) : args;
      try {
        const output = await _runProcess(whisperBin, argsNoDtw, ctx);
        return { output, backend };
      } catch (retryErr) {
        ctx.log(`[DTW] Retry without --dtw also failed: ${retryErr.message}`);
        throw err;
      }
    } else if (backend === 'vulkan' && err.message !== 'Cancelled') {
      ctx.log(`[GPU] Vulkan transcription failed (${err.message}), falling back to CPU`);
      const isOOM = /OutOfDeviceMemory|failed to allocate/i.test(err.message);
      if (!isOOM) ctx.disableGpu();
      const fallbackMsg = isOOM
        ? 'Model too large for GPU memory — retrying with CPU...'
        : 'GPU unavailable — retrying with CPU...';
      ctx.onProgress(fallbackMsg);
      try {
        const output = await _runProcess(ctx.cpuWhisperBinary, args, ctx);
        return { output, backend: 'cpu' };
      } catch (retryErr) {
        ctx.log(`[GPU] CPU fallback also failed: ${retryErr.message}`);
        throw err;
      }
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: diarization
// ---------------------------------------------------------------------------

async function _runDiarization(wavPath, options, ctx) {
  const { hfToken, numSpeakers } = options;

  if (!ctx.pythonCmd) throw new Error('Python not found');

  if (!fs.existsSync(ctx.diarizeScriptPath)) throw new Error('Diarization script not found');

  const outputJson = path.join(ctx._tmpDir, `diarize_${Date.now()}.json`);
  const pyPrefix = ctx.pythonCmd === 'py' ? ['-3'] : [];
  const args = [...pyPrefix, ctx.diarizeScriptPath, '--audio', wavPath, '--output', outputJson];
  if (hfToken) args.push('--hf-token', hfToken);
  if (numSpeakers) args.push('--num-speakers', String(numSpeakers));

  try {
    await _runProcess(ctx.pythonCmd, args, {
      ...ctx,
      onStderr: (data) => {
        for (const line of data.split('\n')) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.error) {
              ctx.onDiarizeProgress({ error: parsed.error });
            } else if (parsed.message) {
              ctx.onDiarizeProgress({ message: parsed.message, percent: parsed.percent });
            }
          } catch (_) { /* not JSON */ }
        }
      },
    });
    return JSON.parse(fs.readFileSync(outputJson, 'utf-8'));
  } finally {
    try { fs.unlinkSync(outputJson); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the full transcription pipeline.
 *
 * @param {string} filePath     - path to the input audio/video file
 * @param {string} modelId      - model identifier (key in MODELS array)
 * @param {object} options      - { diarization, antiCorruption, hfToken, numSpeakers }
 * @param {object} ctx          - dependency injection context (see below)
 *
 * Context fields:
 *   ffmpegBinary       - path to ffmpeg
 *   whisperBinary      - path to whisper-cli for the current backend
 *   cpuWhisperBinary   - path to whisper-cli CPU fallback
 *   modelPath          - path to the model .bin file
 *   modelConfig        - the MODELS array entry (for tdrz check)
 *   dtwPresets         - DTW_PRESETS map (modelId -> preset name)
 *   threads            - max thread count
 *   onProgress(msg)    - status message callback
 *   onDiarizeProgress(data) - diarization progress callback
 *   log(msg)           - log writer
 *   isDtwSupported()   - => boolean
 *   disableDtw()       - mark DTW unsupported for the session
 *   disableGpu()       - disable GPU for the session
 *   pythonCmd          - python command (string or null)
 *   diarizeScriptPath  - path to diarize.py
 *   mergeTranscript    - mergeTranscriptWithDiarization function
 *   signal             - AbortSignal
 *
 *   // Injected for testing, defaults provided:
 *   spawn              - child_process.spawn
 *   makeEnvWithLibPath - env setup function
 *   _tmpDir            - temp directory (defaults to os.tmpdir())
 *
 * @returns {Promise<string>} the transcript text
 */
async function runTranscription(filePath, modelId, options, ctx) {
  // Apply defaults for injectable fields
  if (!ctx._tmpDir) ctx._tmpDir = os.tmpdir();

  const diarization = !!(options && options.diarization);

  const tmpWav = path.join(ctx._tmpDir, `whisper_input_${Date.now()}.wav`);
  const whisperJsonPrefix = path.join(ctx._tmpDir, `whisper_out_${Date.now()}`);

  try {
    // Step 1: Convert to 16kHz mono WAV
    await _runFfmpeg(filePath, tmpWav, ctx);

    // Step 2: Run whisper
    const backend = ctx.whisperBackend || 'cpu';
    const backendLabel = backend === 'vulkan' ? 'Transcribing with GPU...' : 'Transcribing (CPU)...';
    ctx.onProgress(backendLabel);

    const args = _buildWhisperArgs(ctx.modelPath, tmpWav, whisperJsonPrefix,
      { ...options, modelId, diarization }, ctx);

    const result = await _runWhisper(ctx.whisperBinary, args, backend, ctx);
    let output = result.output;

    // Step 3: If diarization enabled, run pyannote and merge
    if (diarization && !(ctx.modelConfig && ctx.modelConfig.tdrz)) {
      try {
        const whisperJsonPath = whisperJsonPrefix + '.json';
        const whisperJson = JSON.parse(fs.readFileSync(whisperJsonPath, 'utf-8'));

        ctx.onProgress('Identifying speakers...');
        const diarizeSegments = await _runDiarization(tmpWav, options, ctx);

        return ctx.mergeTranscript(whisperJson, diarizeSegments);
      } catch (err) {
        ctx.log(`[DIARIZE-FAIL] ${err.message}\n${err.stack || ''}`);
        if (err.message === 'Cancelled') throw err;
        ctx.onProgress(`Diarization failed (${err.message}), using plain transcript`);
        return output.trim();
      }
    }

    return output.trim();
  } finally {
    try { fs.unlinkSync(tmpWav); } catch (_) {}
    try { fs.unlinkSync(whisperJsonPrefix + '.json'); } catch (_) {}
  }
}

/**
 * Run diarization on a pre-converted WAV file. Standalone variant used
 * by the `diarize` IPC handler (not part of the full transcription flow).
 *
 * @param {string} wavPath  - path to the WAV file
 * @param {object} options  - { hfToken, numSpeakers }
 * @param {object} ctx      - same context shape as runTranscription
 * @returns {Promise<Array>} diarization segments
 */
async function runDiarizationOnly(wavPath, options, ctx) {
  if (!ctx._tmpDir) ctx._tmpDir = os.tmpdir();
  return _runDiarization(wavPath, options, ctx);
}

module.exports = { runTranscription, runDiarizationOnly };
