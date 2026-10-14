// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

/**
 * Transcription pipeline runner.
 *
 * Orchestrates the FFmpeg -> whisper -> [align] -> diarize pipeline. Each
 * step is its own process, so GPU memory is released between them.
 *
 * Exports:
 *   createTranscriptionRunner({ capabilities, paths, spawn, log, tmpDir? })
 *     -> { runTranscription({ filePath, modelId, options, signal, onProgress, onDiarizeProgress }) }
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const models = require('./models');
const { assignSpeakers } = require('./diarize-merge');
const {
  normaliseWhisperWords, alignmentLanguage, buildAlignmentInput, applyForcedAlignment,
} = require('./transcript-timing');
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
// Internal: Python helper output
// ---------------------------------------------------------------------------

/**
 * Return an onStderr handler that splits chunks into whole lines (a JSON
 * progress line can arrive split across chunks) and passes each parsed
 * JSON object to onJson. Non-JSON lines are ignored (they are logged by
 * _runProcess anyway).
 */
function _jsonLineReader(onJson) {
  let pending = '';
  return (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { onJson(JSON.parse(line)); } catch (_) { /* not JSON */ }
    }
  };
}

function _isTimeline(list) {
  return Array.isArray(list) && list.every((s) => s && typeof s.start === 'number' &&
    typeof s.end === 'number' && s.speaker !== undefined && s.speaker !== null);
}

/**
 * Validate lib/diarize.py output (design decision D2). Returns
 * { regular, exclusive, info }. A bare array from an older helper is a
 * regular timeline; exclusive is never invented from the regular one.
 */
function _readDiarizeResult(parsed) {
  if (Array.isArray(parsed)) {
    if (!_isTimeline(parsed)) throw new Error('Malformed diarization output');
    return { regular: parsed, exclusive: null, info: { legacy: true } };
  }
  if (!parsed || parsed.format !== 'transcriber-diarization' || parsed.version !== 1) {
    throw new Error('Unrecognised diarization output format');
  }
  if (!_isTimeline(parsed.regular)) throw new Error('Malformed diarization output: regular timeline');
  const exclusive = parsed.exclusiveAvailable && parsed.exclusive !== null ? parsed.exclusive : null;
  if (exclusive !== null && !_isTimeline(exclusive)) {
    throw new Error('Malformed diarization output: exclusive timeline');
  }
  const { regular: _r, exclusive: _e, ...info } = parsed;
  return { regular: parsed.regular, exclusive, info };
}

// ---------------------------------------------------------------------------
// Internal: forced alignment (design decision D3)
// ---------------------------------------------------------------------------

const ALIGNMENT_VALUES = ['whisper', 'forced'];

/** { command, args } for the job's Python, or null. Same interpreter as the probes. */
async function _pythonSpawn(capabilities) {
  if (typeof capabilities.getPythonSpawn === 'function') return capabilities.getPythonSpawn();
  const cmd = await capabilities.getPythonCommand();
  if (!cmd) return null;
  return { command: cmd, args: cmd === 'py' ? ['-3'] : [] };
}

function _readAlignmentResult(parsed, input) {
  if (!parsed || parsed.format !== 'transcriber-alignment' || parsed.version !== 1 || !Array.isArray(parsed.segments)) {
    throw new Error('Unrecognised alignment output format');
  }
  const expected = new Map(input.segments.map((seg) => [seg.index, seg.words.length]));
  for (const seg of parsed.segments) {
    if (!expected.has(seg.index) || !Array.isArray(seg.words) || seg.words.length !== expected.get(seg.index)) {
      throw new Error('Malformed alignment output: word count does not match input');
    }
  }
  return parsed;
}

/**
 * Run lib/align.py on the same WAV. Returns the validated alignment output.
 * Throws on any failure; the caller decides the fallback (Cancelled must
 * always propagate).
 */
async function _runAlignment(wavPath, input, python, alignScriptPath, tmpDir, deps, signal, onDiarizeProgress) {
  if (!python) throw new Error('Python not found');
  if (!fs.existsSync(alignScriptPath)) throw new Error('Alignment script not found');

  const stamp = Date.now();
  const inputJson = path.join(tmpDir, `align_in_${stamp}.json`);
  const outputJson = path.join(tmpDir, `align_out_${stamp}.json`);
  const args = [...python.args, alignScriptPath, '--audio', wavPath, '--input', inputJson, '--output', outputJson];

  let helperError = null;
  try {
    fs.writeFileSync(inputJson, JSON.stringify(input));
    try {
      await _runProcess(python.command, args, {
        ...deps,
        signal,
        onStderr: _jsonLineReader((parsed) => {
          if (parsed.error) helperError = parsed.error;
          else if (parsed.message) onDiarizeProgress({ message: parsed.message, percent: parsed.percent });
        }),
      });
    } catch (err) {
      if (err.message !== 'Cancelled' && helperError) throw new Error(helperError);
      throw err;
    }
    return _readAlignmentResult(JSON.parse(fs.readFileSync(outputJson, 'utf-8')), input);
  } finally {
    try { fs.unlinkSync(inputJson); } catch (_) {}
    try { fs.unlinkSync(outputJson); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Internal: diarization
// ---------------------------------------------------------------------------

async function _runDiarization(wavPath, options, python, diarizeScriptPath, tmpDir, deps, signal, onDiarizeProgress) {
  const { numSpeakers } = options;

  if (!python) throw new Error('Python not found');

  if (!fs.existsSync(diarizeScriptPath)) throw new Error('Diarization script not found');

  const outputJson = path.join(tmpDir, `diarize_${Date.now()}.json`);
  // Inference is cache-only (D2), so no token is passed to the helper.
  const args = [...python.args, diarizeScriptPath, '--audio', wavPath, '--output', outputJson];
  if (numSpeakers) args.push('--num-speakers', String(numSpeakers));

  let helperError = null;
  try {
    try {
      await _runProcess(python.command, args, {
        ...deps,
        signal,
        onStderr: _jsonLineReader((parsed) => {
          if (parsed.error) {
            helperError = parsed.error;
            onDiarizeProgress({ error: parsed.error, code: parsed.code });
          } else if (parsed.message) {
            onDiarizeProgress({ message: parsed.message, percent: parsed.percent });
          }
        }),
      });
    } catch (err) {
      // Prefer the helper's own message over "Process exited with code 1: ..."
      if (err.message !== 'Cancelled' && helperError) throw new Error(helperError);
      throw err;
    }
    return _readDiarizeResult(JSON.parse(fs.readFileSync(outputJson, 'utf-8')));
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
   * @param {object}        [params.options]          - { diarization, antiCorruption, numSpeakers, outputJson,
   *                                                      alignment: 'whisper' (default) | 'forced' }
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
    const alignment = (options && options.alignment) || 'whisper';
    if (!ALIGNMENT_VALUES.includes(alignment)) {
      throw new Error(`Unknown alignment "${alignment}" (expected whisper or forced)`);
    }
    if (alignment === 'forced' && !diarization) {
      throw new Error('Forced alignment needs speaker diarisation');
    }

    const tmpWav = path.join(_tmpDir, `whisper_input_${Date.now()}.wav`);
    const whisperJsonPrefix = path.join(_tmpDir, `whisper_out_${Date.now()}`);

    try {
      // Step 1: Convert to 16kHz mono WAV
      await _runFfmpeg(ffmpegBin, filePath, tmpWav, _deps, signal, onProgress);

      // Step 2: Run whisper
      // Backend selection, arg construction, and DTW/GPU retry policy all
      // handled inside WhisperRunner.
      const { output: whisperOutput, dtw } = await whisperRunner.transcribe({
        modelSpec,
        modelPath,
        wavPath: tmpWav,
        options: { ...options, diarization, outputJson, alignment },
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

          const python = await _pythonSpawn(capabilities);
          let timed = normaliseWhisperWords(whisperJson);
          let alignmentInfo = { requested: alignment, status: alignment === 'forced' ? 'pending' : 'not-requested' };

          // Step 3a: optional forced alignment of the same words. Failure keeps
          // Whisper timing and says so once; cancellation always propagates.
          if (alignment === 'forced') {
            const language = alignmentLanguage(whisperJson, resolvedId);
            try {
              if (!language) throw new Error('language-unknown');
              onProgress('Aligning words to the audio...');
              const input = buildAlignmentInput(timed.words, whisperJson, { language });
              const alignScriptPath = paths.getResourcePath(path.join('lib', 'align.py'));
              const aligned = await _runAlignment(tmpWav, input, python, alignScriptPath,
                _tmpDir, _deps, signal, onDiarizeProgress);
              timed = applyForcedAlignment(timed.words, aligned);
              const { segments: _s, ...meta } = aligned;
              alignmentInfo = { requested: alignment, status: 'aligned', language, ...meta };
            } catch (err) {
              if (err.message === 'Cancelled') throw err;
              log(`[ALIGN-FAIL] ${err.message}`);
              onProgress(`Word alignment failed (${err.message}), using Whisper timing`);
              alignmentInfo = { requested: alignment, status: 'failed', language, reason: err.message };
            }
          }

          onProgress('Identifying speakers...');
          const diarizeScriptPath = paths.getResourcePath(path.join('lib', 'diarize.py'));
          const diarized = await _runDiarization(tmpWav, options,
            python, diarizeScriptPath, _tmpDir, _deps, signal, onDiarizeProgress);

          const attribution = assignSpeakers(timed, { regular: diarized.regular, exclusive: diarized.exclusive });
          const merged = attribution.text;
          if (outputJson) {
            // `whisper`, `diarize` (regular timeline) and `merged` keep their
            // original meaning; the other keys are additive (D1, D2).
            const { text: _text, ...evidence } = attribution;
            return {
              text: merged,
              json: {
                whisper: whisperJson,
                diarize: diarized.regular,
                merged,
                diarizeExclusive: diarized.exclusive,
                diarizeInfo: diarized.info,
                speakerAttribution: { ...evidence, whisperDtw: dtw || null, alignment: alignmentInfo },
              },
            };
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

module.exports = { createTranscriptionRunner, _readDiarizeResult, _readAlignmentResult, _jsonLineReader };
