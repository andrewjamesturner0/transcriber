const { createTranscriptResult } = require('./transcript-result');

function createTranscribeRunner({ workerClient }) {
  let nextJobId = 1;

  function normalizeTimedRecords(records) {
    if (!Array.isArray(records) || records.length === 0) return undefined;
    return records.map(({ t0Ms, t1Ms, ...record }) => ({
      ...record,
      ...(t0Ms != null ? { startMs: t0Ms } : {}),
      ...(t1Ms != null ? { endMs: t1Ms } : {}),
    }));
  }

  function mapOptions(modelSpec, options = {}) {
    const mapped = {
      task: options.jobMode || 'transcribe',
      timestamps: modelSpec.timestampLevel,
    };
    if (options.sourceLanguage && options.sourceLanguage !== 'auto') mapped.language = options.sourceLanguage;
    if (options.targetLanguage) mapped.targetLanguage = options.targetLanguage;
    return mapped;
  }

  async function transcribe({ modelSpec, modelPath, wavPath, options, signal, onProgress }) {
    if (modelSpec.runtimeAvailable === false) {
      const error = new Error(`${modelSpec.displayName} is deferred until a compatible transcribe.cpp release is available.`);
      error.code = 'MODEL_DEFERRED';
      throw error;
    }
    const backend = options && options.backend || 'cpu';
    const jobId = `transcribe-${nextJobId++}`;
    onProgress(backend === 'vulkan' ? 'Transcribing with GPU...' : 'Transcribing (CPU)...');
    const raw = await workerClient.transcribe({
      modelPath,
      backend,
      wavPath,
      options: mapOptions(modelSpec, options),
      jobId,
      signal,
      supportsCpu: modelSpec.backends.includes('cpu'),
    });
    const hasTranscriptTiming = modelSpec.timestampLevel !== 'none';
    const result = createTranscriptResult({
      text: raw.text || '',
      model: modelSpec.id,
      engine: 'transcribe.cpp',
      backend: raw.backend || backend,
      selectedLanguage: options && options.sourceLanguage && options.sourceLanguage !== 'auto'
        ? options.sourceLanguage : undefined,
      detectedLanguage: typeof raw.language === 'string' && raw.language.length > 0 ? raw.language : undefined,
      segments: hasTranscriptTiming ? normalizeTimedRecords(raw.segments) : undefined,
      words: hasTranscriptTiming ? normalizeTimedRecords(raw.words) : undefined,
      tokens: hasTranscriptTiming ? normalizeTimedRecords(raw.tokens) : undefined,
      timings: raw.timings,
      truncated: typeof raw.truncated === 'boolean' ? raw.truncated : undefined,
    });
    return { output: result.text, backend: result.backend, result, rawResult: raw };
  }

  return {
    transcribe,
    shutdown: () => workerClient.shutdown(),
  };
}

module.exports = { createTranscribeRunner };
