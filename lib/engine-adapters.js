const { createTranscriptResult } = require('./transcript-result');

function createEngineAdapterSelector({ whisperRunner, transcribeRunner }) {
  const whisperAdapter = {
    async transcribe(params) {
      const execution = await whisperRunner.transcribe(params);
      const selectedLanguage = params.options && params.options.sourceLanguage
        && params.options.sourceLanguage !== 'auto' ? params.options.sourceLanguage : undefined;
      return {
        ...execution,
        result: createTranscriptResult({
          text: execution.output,
          model: params.modelSpec.id,
          engine: 'whisper.cpp',
          backend: execution.backend,
          selectedLanguage,
        }),
      };
    },
  };

  function forModel(modelSpec) {
    if (modelSpec.engine === 'whisper.cpp') return whisperAdapter;
    if (modelSpec.engine === 'transcribe.cpp' && transcribeRunner) return transcribeRunner;
    throw new Error(`Engine ${modelSpec.engine} is not available for ${modelSpec.id}`);
  }

  return { forModel };
}

module.exports = { createEngineAdapterSelector };
