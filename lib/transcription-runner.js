// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

/**
 * Transcription pipeline runner.
 *
 * Orchestrates the FFmpeg -> whisper -> diarize pipeline.
 *
 * Exports:
 *   createTranscriptionRunner({ capabilities, paths, spawn, log, tmpDir? })
 *     -> { runTranscription({ filePath, modelId, options, signal, onProgress, onDiarizeProgress }) }
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const models = require('./models');
const { mergeTranscriptWithDiarization } = require('./diarize-merge');
const { createWhisperRunner } = require('./whisper-runner');
const { _runProcess } = require('./_subprocess');

// ---------------------------------------------------------------------------
// Internal: FFmpeg step
// ---------------------------------------------------------------------------

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', '3gp'];

function _runFfmpeg(ffmpegBinary, filePath, tmpWav, deps, signal, onProgress) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const isVideo = VIDEO_EXTENSIONS.includes(ext);
  onProgress(isVideo ? 'Extracting audio...' : 'Converting audio...');
  return _runProcess(ffmpegBinary, [
    '-i', filePath,
    '-ar', '16000',
    '-ac', '1',
    '-c:a', 'pcm_s16le',
    '-y', tmpWav,
  ], { ...deps, signal });
}

// ---------------------------------------------------------------------------
// Internal: diarization
// ---------------------------------------------------------------------------

async function _runDiarization(wavPath, options, pythonCmd, diarizeScriptPath, tmpDir, deps, signal, onDiarizeProgress) {
  const { hfToken, numSpeakers } = options;

  if (!pythonCmd) throw new Error('Python not found');

  if (!fs.existsSync(diarizeScriptPath)) throw new Error('Diarization script not found');

  const outputJson = path.join(tmpDir, `diarize_${Date.now()}.json`);
  const pyPrefix = pythonCmd === 'py' ? ['-3'] : [];
  const args = [...pyPrefix, diarizeScriptPath, '--audio', wavPath, '--output', outputJson];
  if (hfToken) args.push('--hf-token', hfToken);
  if (numSpeakers) args.push('--num-speakers', String(numSpeakers));

  try {
    await _runProcess(pythonCmd, args, {
      ...deps,
      signal,
      onStderr: (data) => {
        for (const line of data.split('\n')) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.error) {
              onDiarizeProgress({ error: parsed.error });
            } else if (parsed.message) {
              onDiarizeProgress({ message: parsed.message, percent: parsed.percent });
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
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a transcription runner with long-lived dependencies bound once.
 *
 * @param {object}   opts
 * @param {object}   opts.capabilities - Capabilities instance (getActiveBackend, isDtwSupported, disableDtw, disableGpu, getPythonCommand)
 * @param {object}   opts.paths        - path resolver (getWhisperBinary, getFfmpegBinary, getResourcePath, makeEnvWithLibPath)
 * @param {Function} opts.spawn        - child_process.spawn (or mock)
 * @param {Function} opts.log          - log writer
 * @param {string}   [opts.tmpDir]     - temp directory (defaults to os.tmpdir())
 * @returns {{ runTranscription: Function }}
 */
function createTranscriptionRunner({ capabilities, paths, spawn, log, tmpDir }) {
  const _tmpDir = tmpDir || os.tmpdir();
  const _deps = { spawn, makeEnvWithLibPath: paths.makeEnvWithLibPath, log };
  const whisperRunner = createWhisperRunner({ capabilities, paths, spawn, log, tmpDir: _tmpDir });

  /**
   * Run the full transcription pipeline.
   *
   * @param {object}        params
   * @param {string}        params.filePath           - path to the input audio/video file
   * @param {string}        params.modelId            - model identifier (defaults to 'tiny.en')
   * @param {object}        [params.options]          - { diarization, antiCorruption, hfToken, numSpeakers, outputJson }
   * @param {AbortSignal}   [params.signal]           - abort signal
   * @param {Function}      params.onProgress         - status message callback (msg: string)
   * @param {Function}      params.onDiarizeProgress  - diarization progress callback (data: object)
   * @returns {Promise<{ text: string, json?: object }>} transcript text, plus full whisper JSON when outputJson is true
   */
  async function runTranscription({ filePath, modelId, options, signal, onProgress, onDiarizeProgress }) {
    const resolvedId = modelId || 'tiny.en';
    const modelSpec = models.getModel(resolvedId);
    const modelPath = models.getModelPath(resolvedId);

    // Pre-flight: verify ffmpeg, whisper binary, and model exist.
    // Resolve whisper backend the same way WhisperRunner does, so the
    // missing-binary error message is consistent and arrives before FFmpeg.
    const ffmpegBin = paths.getFfmpegBinary();
    const backend = capabilities.getActiveBackend();
    let whisperBin = paths.getWhisperBinary(backend);
    if (!fs.existsSync(whisperBin) && backend === 'vulkan') {
      whisperBin = paths.getWhisperBinary('cpu');
    }
    for (const [name, p] of [['ffmpeg', ffmpegBin], ['whisper-cli', whisperBin], ['model', modelPath]]) {
      if (!fs.existsSync(p)) {
        throw new Error(`${name} not found at ${p}. Run "npm run setup" first.`);
      }
    }

    const diarization = !!(options && options.diarization);
    const outputJson = !!(options && options.outputJson);

    const tmpWav = path.join(_tmpDir, `whisper_input_${Date.now()}.wav`);
    const whisperJsonPrefix = path.join(_tmpDir, `whisper_out_${Date.now()}`);

    try {
      // Step 1: Convert to 16kHz mono WAV
      await _runFfmpeg(ffmpegBin, filePath, tmpWav, _deps, signal, onProgress);

      // Step 2: Run whisper
      // Backend selection, arg construction, and DTW/GPU retry policy all
      // handled inside WhisperRunner.
      const { output: whisperOutput } = await whisperRunner.transcribe({
        modelSpec,
        modelPath,
        wavPath: tmpWav,
        options: { ...options, diarization, outputJson },
        signal,
        onProgress,
        jsonPrefix: whisperJsonPrefix,
      });
      let output = whisperOutput;

      // Step 3: If diarization enabled, run pyannote and merge
      if (diarization && !(modelSpec && modelSpec.tdrz)) {
        try {
          const whisperJsonPath = whisperJsonPrefix + '.json';
          const whisperJson = JSON.parse(fs.readFileSync(whisperJsonPath, 'utf-8'));

          onProgress('Identifying speakers...');
          const pythonCmd = await capabilities.getPythonCommand();
          const diarizeScriptPath = paths.getResourcePath(path.join('lib', 'diarize.py'));
          const diarizeSegments = await _runDiarization(tmpWav, options,
            pythonCmd, diarizeScriptPath, _tmpDir, _deps, signal, onDiarizeProgress);

          const merged = mergeTranscriptWithDiarization(whisperJson, diarizeSegments);
          if (outputJson) {
            return { text: merged, json: { whisper: whisperJson, diarize: diarizeSegments, merged } };
          }
          return { text: merged };
        } catch (err) {
          log(`[DIARIZE-FAIL] ${err.message}\n${err.stack || ''}`);
          if (err.message === 'Cancelled') throw err;
          onProgress(`Diarization failed (${err.message}), using plain transcript`);
          return { text: output.trim() };
        }
      }

      if (outputJson) {
        const whisperJsonPath = whisperJsonPrefix + '.json';
        const whisperJson = JSON.parse(fs.readFileSync(whisperJsonPath, 'utf-8'));
        return { text: output.trim(), json: whisperJson };
      }
      return { text: output.trim() };
    } finally {
      try { fs.unlinkSync(tmpWav); } catch (_) {}
      try { fs.unlinkSync(whisperJsonPrefix + '.json'); } catch (_) {}
    }
  }

  return { runTranscription };
}

module.exports = { createTranscriptionRunner };
