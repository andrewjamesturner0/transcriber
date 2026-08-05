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
const crypto = require('crypto');
const models = require('./models');
const { mergeTranscriptWithDiarization } = require('./diarize-merge');
const { createWhisperRunner } = require('./whisper-runner');
const { createEngineAdapterSelector } = require('./engine-adapters');
const { createTranscribeRunner } = require('./transcribe-runner');
const { createTranscribeWorkerClient } = require('./transcribe-worker-client');
const { normalizeWhisperJson, withTranscriptDetail } = require('./transcript-result');
const { _runProcess } = require('./_subprocess');

// ---------------------------------------------------------------------------
// Internal: FFmpeg step
// ---------------------------------------------------------------------------

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', '3gp'];

function _makeTemporaryPath(tmpDir, prefix, extension) {
  return path.join(tmpDir, `${prefix}_${process.pid}_${crypto.randomUUID()}${extension}`);
}

function createTranscriptionJobController() {
  let activeJob = null;

  function begin() {
    if (activeJob) {
      const error = new Error('A transcription is already running.');
      error.code = 'TRANSCRIPTION_BUSY';
      throw error;
    }
    const job = {
      controller: new AbortController(),
      finish() {
        if (activeJob === job) activeJob = null;
      },
    };
    activeJob = job;
    return job;
  }

  function cancel() {
    if (!activeJob) return false;
    activeJob.controller.abort();
    return true;
  }

  return { begin, cancel, hasActiveJob: () => !!activeJob };
}

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

function _getWavDurationSeconds(wavPath) {
  const data = fs.readFileSync(wavPath);
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Converted audio is not a valid WAV file');
  }
  let byteRate = null;
  let dataBytes = null;
  let offset = 12;
  while (offset + 8 <= data.length) {
    const kind = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    if (kind === 'fmt ' && offset + 16 <= data.length) byteRate = data.readUInt32LE(offset + 16);
    if (kind === 'data') { dataBytes = size; break; }
    offset += 8 + size + (size % 2);
  }
  if (!byteRate || dataBytes == null) throw new Error('Converted WAV has no audio data');
  return dataBytes / byteRate;
}

// ---------------------------------------------------------------------------
// Internal: diarization
// ---------------------------------------------------------------------------

async function _runDiarization(wavPath, options, pythonCmd, diarizeScriptPath, tmpDir, deps, signal, onDiarizeProgress) {
  const { hfToken, numSpeakers } = options;

  if (!pythonCmd) throw new Error('Python not found');

  if (!fs.existsSync(diarizeScriptPath)) throw new Error('Diarization script not found');

  const outputJson = _makeTemporaryPath(tmpDir, 'diarize', '.json');
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
  const workerClient = createTranscribeWorkerClient({ launch: paths.getTranscribeWorkerLaunch(), spawn, log });
  const transcribeRunner = createTranscribeRunner({ workerClient });
  const engineAdapters = createEngineAdapterSelector({ whisperRunner, transcribeRunner });

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
    const engineAdapter = engineAdapters.forModel(modelSpec);
    const optionValidation = models.validateJobOptions(resolvedId, options || {});
    if (!optionValidation.valid) {
      const first = optionValidation.errors[0];
      const error = new Error(first.message);
      error.code = first.code;
      error.validation = optionValidation;
      throw error;
    }

    // Pre-flight: verify ffmpeg, whisper binary, and model exist.
    // Resolve whisper backend the same way WhisperRunner does, so the
    // missing-binary error message is consistent and arrives before FFmpeg.
    const ffmpegBin = paths.getFfmpegBinary();
    const requiredPaths = [['ffmpeg', ffmpegBin], ['model', modelPath]];
    if (modelSpec.engine === 'whisper.cpp') {
      const backend = capabilities.getActiveBackend();
      let whisperBin = paths.getWhisperBinary(backend);
      if (!fs.existsSync(whisperBin) && backend === 'vulkan') whisperBin = paths.getWhisperBinary('cpu');
      requiredPaths.splice(1, 0, ['whisper-cli', whisperBin]);
    } else {
      requiredPaths.splice(1, 0, ['transcribe worker', paths.getTranscribeWorkerPath()]);
    }
    for (const [name, p] of requiredPaths) {
      if (!fs.existsSync(p)) {
        throw new Error(`${name} not found at ${p}. Run "npm run setup" first.`);
      }
    }

    const diarization = !!(options && options.diarization);
    const outputJson = !!(options && options.outputJson);

    const tmpWav = _makeTemporaryPath(_tmpDir, 'whisper_input', '.wav');
    const whisperJsonPrefix = _makeTemporaryPath(_tmpDir, 'whisper_out', '');

    try {
      // Step 1: Convert to 16kHz mono WAV
      await _runFfmpeg(ffmpegBin, filePath, tmpWav, _deps, signal, onProgress);

      if (modelSpec.audioLimitSeconds != null) {
        const durationSeconds = _getWavDurationSeconds(tmpWav);
        if (durationSeconds > modelSpec.audioLimitSeconds) {
          const error = new Error(`${modelSpec.displayName} supports recordings up to about ${modelSpec.audioLimitSeconds} seconds; this file is ${Math.ceil(durationSeconds)} seconds.`);
          error.code = 'AUDIO_LIMIT_EXCEEDED';
          error.limitSeconds = modelSpec.audioLimitSeconds;
          error.durationSeconds = durationSeconds;
          throw error;
        }
      }

      // Step 2: Run whisper
      // Backend selection, arg construction, and DTW/GPU retry policy all
      // handled inside WhisperRunner.
      const engineOptions = {
        ...options,
        ...optionValidation.effective,
        backend: modelSpec.backends.includes(capabilities.getActiveBackend())
          ? capabilities.getActiveBackend() : 'cpu',
      };
      const execution = await engineAdapter.transcribe({
        modelSpec,
        modelPath,
        wavPath: tmpWav,
        options: { ...engineOptions, diarization, outputJson },
        signal,
        onProgress,
        jsonPrefix: whisperJsonPrefix,
      });
      const whisperOutput = execution.output;
      let transcriptResult = execution.result;
      let output = whisperOutput;

      if (modelSpec.engine === 'transcribe.cpp') {
        if (outputJson) return { text: output.trim(), result: transcriptResult, json: transcriptResult };
        return { text: output.trim(), result: transcriptResult };
      }

      // Step 3: If diarization enabled, run pyannote and merge
      if (diarization && !(modelSpec && modelSpec.tdrz)) {
        try {
          const whisperJsonPath = whisperJsonPrefix + '.json';
          const whisperJson = JSON.parse(fs.readFileSync(whisperJsonPath, 'utf-8'));
          transcriptResult = withTranscriptDetail(transcriptResult, normalizeWhisperJson(whisperJson));

          onProgress('Identifying speakers...');
          const pythonCmd = await capabilities.getPythonCommand();
          const diarizeScriptPath = paths.getResourcePath(path.join('lib', 'diarize.py'));
          const diarizeSegments = await _runDiarization(tmpWav, options,
            pythonCmd, diarizeScriptPath, _tmpDir, _deps, signal, onDiarizeProgress);

          const merged = mergeTranscriptWithDiarization(transcriptResult, diarizeSegments);
          if (outputJson) {
            return { text: merged, result: { ...transcriptResult, text: merged }, json: { whisper: whisperJson, diarize: diarizeSegments, merged } };
          }
          return { text: merged, result: { ...transcriptResult, text: merged } };
        } catch (err) {
          log(`[DIARIZE-FAIL] ${err.message}\n${err.stack || ''}`);
          if (err.message === 'Cancelled') throw err;
          onProgress(`Diarization failed (${err.message}), using plain transcript`);
          return { text: output.trim(), result: transcriptResult };
        }
      }

      if (outputJson) {
        const whisperJsonPath = whisperJsonPrefix + '.json';
        const whisperJson = JSON.parse(fs.readFileSync(whisperJsonPath, 'utf-8'));
        transcriptResult = withTranscriptDetail(transcriptResult, normalizeWhisperJson(whisperJson));
        return { text: output.trim(), result: transcriptResult, json: whisperJson };
      }
      return { text: output.trim(), result: transcriptResult };
    } finally {
      try { fs.unlinkSync(tmpWav); } catch (_) {}
      try { fs.unlinkSync(whisperJsonPrefix + '.json'); } catch (_) {}
    }
  }

  return { runTranscription, shutdown: () => workerClient.shutdown() };
}

module.exports = {
  createTranscriptionRunner,
  createTranscriptionJobController,
  _getWavDurationSeconds,
  _makeTemporaryPath,
};
