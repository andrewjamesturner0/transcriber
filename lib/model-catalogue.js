// Curated model catalogue and capability validation.

const WHISPER_REPO = 'ggerganov/whisper.cpp';
const WHISPER_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

const WHISPER_FILES = [
  ['tiny.en', 'ggml-tiny.en.bin', 'Tiny (English)', '75 MB', 77704715, '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f', 'tiny.en'],
  ['tiny', 'ggml-tiny.bin', 'Tiny (Multilingual)', '75 MB', 77691713, 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21', 'tiny'],
  ['base.en', 'ggml-base.en.bin', 'Base (English)', '142 MB', 147964211, 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002', 'base.en'],
  ['base', 'ggml-base.bin', 'Base (Multilingual)', '142 MB', 147951465, '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', 'base'],
  ['small.en', 'ggml-small.en.bin', 'Small (English)', '466 MB', 487614201, 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d', 'small.en'],
  ['small', 'ggml-small.bin', 'Small (Multilingual)', '466 MB', 487601967, '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b', 'small'],
  ['medium.en', 'ggml-medium.en.bin', 'Medium (English)', '1.5 GB', 1533774781, 'cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356', 'medium.en'],
  ['medium', 'ggml-medium.bin', 'Medium (Multilingual)', '1.5 GB', 1533763059, '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208', 'medium'],
  ['large-v3', 'ggml-large-v3.bin', 'Large v3 (Multilingual)', '3.1 GB', 3095033483, '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2', 'large.v3'],
  ['large-v3-turbo', 'ggml-large-v3-turbo.bin', 'Large v3 Turbo (Multilingual)', '1.6 GB', 1624555275, '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69', 'large.v3.turbo'],
  ['large-v3-turbo-q5_0', 'ggml-large-v3-turbo-q5_0.bin', 'Large v3 Turbo Q5 (Multilingual)', '574 MB', 574041195, '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2', 'large.v3.turbo'],
  ['large-v3-q5_0', 'ggml-large-v3-q5_0.bin', 'Large v3 Q5 (Multilingual)', '1.1 GB', 1081140203, 'd75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1', 'large.v3'],
];

const WHISPER_DESCRIPTIONS = Object.freeze({
  'tiny.en': 'A 75 MB English-only Whisper model with word timing.',
  tiny: 'A 75 MB multilingual Whisper model with word timing and translation to English.',
  'base.en': 'A 142 MB English-only Whisper model with word timing.',
  base: 'A 142 MB multilingual Whisper model with word timing and translation to English.',
  'small.en': 'A 466 MB English-only Whisper model with word timing.',
  small: 'The recommended multilingual default, with word timing and translation to English.',
  'medium.en': 'A 1.5 GB English-only Whisper model with word timing.',
  medium: 'A 1.5 GB multilingual Whisper model with word timing and translation to English.',
  'large-v3': 'The recommended choice for accuracy-first transcription and translation to English.',
  'large-v3-turbo': 'A 1.6 GB multilingual Whisper model with word timing and translation to English.',
  'large-v3-turbo-q5_0': 'A 574 MB Q5 version of Whisper Large v3 Turbo, with word timing and translation to English.',
  'large-v3-q5_0': 'A 1.1 GB Q5 version of Whisper Large v3, with word timing and translation to English.',
});

function whisperRecord([id, fileName, label, size, sizeBytes, sha256, dtwPreset]) {
  const englishOnly = id.endsWith('.en');
  const quantisation = id.endsWith('q5_0') ? 'Q5_0' : 'F16';
  const task = id === 'small' ? 'general-purpose'
    : id === 'large-v3' ? 'accuracy-first'
      : 'other';
  return {
    id, fileName, label, displayName: label, size, sizeBytes, sha256, dtwPreset,
    task,
    status: 'recommended',
    engine: 'whisper.cpp',
    family: 'whisper',
    repository: WHISPER_REPO,
    revision: WHISPER_REVISION,
    sourceUrl: 'https://huggingface.co/ggerganov/whisper.cpp',
    licence: 'MIT',
    licenceUrl: 'https://github.com/ggerganov/whisper.cpp/blob/master/LICENSE',
    attribution: 'OpenAI Whisper model converted for whisper.cpp',
    gated: false,
    accessUrl: null,
    languages: englishOnly ? ['en'] : ['multilingual'],
    languageSelection: englishOnly ? 'fixed' : 'select-or-auto',
    translationPairs: englishOnly ? [] : [{ source: '*', target: 'en' }],
    timestampLevel: 'word',
    pyannoteValidated: true,
    expectedSpeakersSupported: true,
    builtInSpeakers: false,
    audioLimitSeconds: null,
    memoryGuidance: id.startsWith('large-v3') ? 'High memory use; 4 GB or more free RAM is recommended.' : 'Memory use grows with model size and recording length.',
    backends: ['cpu', 'vulkan'],
    repetitionControl: true,
    quantisation,
    runtimeAvailable: true,
    practicalDescription: WHISPER_DESCRIPTIONS[id],
    knownIssues: [],
  };
}

function externalModel(spec) {
  return {
    accessUrl: null,
    gated: false,
    audioLimitSeconds: null,
    backends: ['cpu', 'vulkan'],
    builtInSpeakers: false,
    pyannoteValidated: false,
    expectedSpeakersSupported: false,
    repetitionControl: false,
    runtimeAvailable: true,
    translationPairs: [],
    ...spec,
    engine: 'transcribe.cpp',
    sourceUrl: `https://huggingface.co/${spec.repository}`,
  };
}

const EXTERNAL_MODELS = [
  externalModel({
    id: 'parakeet-tdt-ctc-110m', fileName: 'parakeet-tdt_ctc-110m-Q8_0.gguf', label: 'Parakeet 110M', displayName: 'Parakeet TDT-CTC 110M', size: '135 MB', sizeBytes: 135373280,
    sha256: '7dd44c74a331d788a4e5f8b16913b3feb29ced22cf5613aad0e0f6cd30516296', task: 'fast-english', status: 'candidate', family: 'parakeet', repository: 'handy-computer/parakeet-tdt_ctc-110m-gguf', revision: '9d66d34f9e1594075c5dd72c90c0f4c321b29f21',
    licence: 'CC BY 4.0', licenceUrl: 'https://huggingface.co/nvidia/parakeet-tdt_ctc-110m', attribution: 'NVIDIA Parakeet TDT-CTC 110M', languages: ['en'], languageSelection: 'fixed', timestampLevel: 'word', quantisation: 'Q8_0', memoryGuidance: 'At least 1 GB of free RAM is recommended.', practicalDescription: 'A Candidate for fast English transcription with word timing; tests for silent omissions are pending.', knownIssues: ['Tests for silent omissions and pyannote word timing are pending.'],
  }),
  externalModel({
    id: 'moonshine-tiny', fileName: 'moonshine-tiny-Q8_0.gguf', label: 'Moonshine Tiny', displayName: 'Moonshine Tiny', size: '34 MB', sizeBytes: 35466912,
    sha256: '2fd348d7b38f97d309cc3ec6848f3f57f537b80244950f07d2637e463f95a3a1', task: 'small-download', status: 'candidate', family: 'moonshine', repository: 'handy-computer/moonshine-tiny-gguf', revision: 'f5c11906eba3f44cf305eed30feb9cbfb0b4b9d0',
    licence: 'MIT', licenceUrl: 'https://huggingface.co/UsefulSensors/moonshine', attribution: 'Useful Sensors Moonshine Tiny', languages: ['en'], languageSelection: 'fixed', timestampLevel: 'none', quantisation: 'Q8_0', memoryGuidance: 'Low memory use.', practicalDescription: 'A 34 MB English Candidate for plain text only; long-recording tests are pending.', knownIssues: ['Does not return timestamps, detect language or support translation.'],
  }),
  externalModel({
    id: 'nemotron-3.5-0.6b', fileName: 'nemotron-3.5-asr-streaming-0.6b-Q5_K_M.gguf', label: 'Nemotron 3.5 ASR 0.6B', displayName: 'Nemotron 3.5 ASR Streaming 0.6B', size: '534 MB', sizeBytes: 559647200,
    sha256: '86429e8c4f7fdcf9b3312269ad1ca6669478ba7805331c4aea7a2e33e9910d65', task: 'multilingual', status: 'candidate', family: 'nemotron', repository: 'handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf', revision: '6d44e540bc31b0de1dbe174a3cea87f53a7f22fb',
    licence: 'OpenMDW-1.1', licenceUrl: 'https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b', attribution: 'NVIDIA Nemotron 3.5 ASR Streaming 0.6B', languages: ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'es-ES', 'multilingual'], languageSelection: 'select-or-auto', timestampLevel: 'word', quantisation: 'Q5_K_M', memoryGuidance: 'At least 2 GB of free RAM is recommended.', practicalDescription: 'A multilingual Candidate with word timing; language and long-recording tests are pending.', knownIssues: ['Tests of language coverage, timing, memory use and long recordings are pending.'],
  }),
  externalModel({
    id: 'qwen3-asr-0.6b', fileName: 'Qwen3-ASR-0.6B-Q4_K_M.gguf', label: 'Qwen3-ASR 0.6B', displayName: 'Qwen3-ASR 0.6B', size: '654 MB', sizeBytes: 589560480,
    sha256: '5b58f32a58ffa2c8783e0b0963485623e286e6272d953dfc9e28bc3447dee0c0', task: 'other', status: 'experimental', family: 'qwen3-asr', repository: 'handy-computer/Qwen3-ASR-0.6B-gguf', revision: 'e4e16599b900eb0cb36e524514756bb92eb092b7',
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/Qwen/Qwen3-ASR-0.6B', attribution: 'Alibaba Qwen3-ASR 0.6B', languages: ['multilingual'], languageSelection: 'auto-only', timestampLevel: 'none', quantisation: 'Q4_K_M', memoryGuidance: 'At least 2 GB of free RAM is recommended.', practicalDescription: 'An Experimental multilingual model with automatic language detection and no timing output.', knownIssues: ['Does not accept language hints or return timing output.'],
  }),
  externalModel({
    id: 'canary-180m-flash', fileName: 'canary-180m-flash-Q5_K_M.gguf', label: 'Canary 180M Flash', displayName: 'Canary 180M Flash', size: '151 MB', sizeBytes: 158704320,
    sha256: 'a87992d84aea5329fa5d70f2eb440d3ae4fe47bd774875374ec381472d348299', task: 'other', status: 'experimental', family: 'canary', repository: 'handy-computer/canary-180m-flash-gguf', revision: 'b147f9dc52b59f0998e410540a84727bd86457fd',
    licence: 'CC BY 4.0', licenceUrl: 'https://huggingface.co/nvidia/canary-180m-flash', attribution: 'NVIDIA Canary 180M Flash', languages: ['en', 'de', 'es', 'fr'], languageSelection: 'required', translationPairs: [{ source: 'en', target: 'de' }, { source: 'de', target: 'en' }, { source: 'en', target: 'es' }, { source: 'es', target: 'en' }, { source: 'en', target: 'fr' }, { source: 'fr', target: 'en' }], timestampLevel: 'none', quantisation: 'Q5_K_M', memoryGuidance: 'At least 1 GB of free RAM is recommended.', practicalDescription: 'An Experimental model for English, German, Spanish and French transcription and translation.', knownIssues: ['Does not return timing output.'],
  }),
  externalModel({
    id: 'medasr', fileName: 'medasr-Q8_0.gguf', label: 'MedASR', displayName: 'MedASR', size: '122 MB', sizeBytes: 127712448,
    sha256: '5a391a2154416b96241b829ac2c7eed8b64d197f00372512c9bbf63f4849c978', task: 'other', status: 'experimental', family: 'medasr', repository: 'handy-computer/medasr-gguf', revision: '6f481df085bb50ae922cea918fb578e664237126',
    licence: 'Health AI Developer Foundations terms', licenceUrl: 'https://developers.google.com/health-ai-developer-foundations/terms', attribution: 'Google Health AI MedASR', gated: true, accessUrl: 'https://huggingface.co/google/medasr', languages: ['en'], languageSelection: 'fixed', timestampLevel: 'word', quantisation: 'Q8_0', audioLimitSeconds: 400, memoryGuidance: 'At least 1 GB of free RAM is recommended.', practicalDescription: 'An Experimental English medical-dictation model for recordings up to about 400 seconds.', knownIssues: ['Requires gated access. It is a specialist medical English dictation model and is not intended or validated for general speech.'],
  }),
  externalModel({
    id: 'moss-transcribe-diarize', fileName: 'MOSS-Transcribe-Diarize-Q5_K_M.gguf', label: 'MOSS Transcribe-Diarize', displayName: 'MOSS Transcribe-Diarize', size: '700 MB', sizeBytes: 700313760,
    sha256: '52deaeff931272f3d49eb437f0f4916e42fce9f42e68db250047408241cf473c', task: 'other', status: 'experimental', family: 'moss', repository: 'handy-computer/MOSS-Transcribe-Diarize-gguf', revision: '6fdfa33aed776bbb0ac11a1a9835634fe6d75dd7',
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/OpenMOSS-Team/MOSS-Transcribe-Diarize', attribution: 'OpenMOSS MOSS Transcribe-Diarize', languages: ['en', 'zh'], languageSelection: 'select-or-auto', timestampLevel: 'segment', builtInSpeakers: true, quantisation: 'Q5_K_M', audioLimitSeconds: 7200, runtimeAvailable: false, memoryGuidance: 'Memory grows by about 85 MB per minute, in addition to the model.', practicalDescription: 'A deferred Experimental model for English and Chinese transcripts with built-in speaker labels.', knownIssues: ['Speaker labels cannot be turned off.', 'transcribe.cpp v0.1.3 does not support MOSS.'],
  }),
];

const MODELS = deepFreeze([...WHISPER_FILES.map(whisperRecord), ...EXTERNAL_MODELS]);

function getCatalogueModel(id) {
  const model = MODELS.find((entry) => entry.id === id);
  if (!model) throw new Error(`Unknown model: ${id}`);
  return model;
}

function listCatalogueModels() {
  return deepFreeze(MODELS.map((entry) => ({ ...entry })));
}

function toPresentationModel(model) {
  const { sha256, repository, revision, fileName, dtwPreset, ...safe } = model;
  return deepFreeze({ ...safe, sourceRevision: revision });
}

function listPresentationModels() {
  return deepFreeze(MODELS.map(toPresentationModel));
}

function optionError(code, field, message) {
  return { code, field, message };
}

function validateJobOptions(modelId, options = {}) {
  const model = getCatalogueModel(modelId);
  const effective = {
    jobMode: options.jobMode || 'transcribe',
    sourceLanguage: options.sourceLanguage || (model.languageSelection === 'fixed' ? model.languages[0] : 'auto'),
    targetLanguage: options.targetLanguage || null,
    speakerLabels: options.speakerLabels != null ? !!options.speakerLabels : !!options.diarization,
    expectedSpeakers: options.expectedSpeakers != null ? options.expectedSpeakers : options.numSpeakers || null,
    reduceRepeatedText: options.reduceRepeatedText != null ? !!options.reduceRepeatedText : !!options.antiCorruption,
  };
  const errors = [];

  if (!['transcribe', 'translate'].includes(effective.jobMode)) {
    errors.push(optionError('INVALID_JOB_MODE', 'jobMode', 'Job mode must be Transcribe or Translate.'));
  } else if (effective.jobMode === 'translate' && model.translationPairs.length === 0) {
    errors.push(optionError('TRANSLATION_UNSUPPORTED', 'jobMode', `${model.displayName} does not support translation.`));
  }

  if (model.languageSelection === 'auto-only' && effective.sourceLanguage !== 'auto') {
    errors.push(optionError('SOURCE_LANGUAGE_AUTO_ONLY', 'sourceLanguage', `${model.displayName} detects language automatically and does not accept a language choice.`));
  } else if (model.languageSelection === 'fixed' && effective.sourceLanguage !== model.languages[0]) {
    errors.push(optionError('SOURCE_LANGUAGE_FIXED', 'sourceLanguage', `${model.displayName} only supports ${model.languages[0]}.`));
  } else if (model.languageSelection === 'required' && effective.sourceLanguage === 'auto') {
    errors.push(optionError('SOURCE_LANGUAGE_REQUIRED', 'sourceLanguage', `${model.displayName} requires a source language.`));
  } else if (!['auto', 'multilingual'].includes(effective.sourceLanguage)
    && !model.languages.includes('multilingual')
    && !model.languages.includes(effective.sourceLanguage)) {
    errors.push(optionError('SOURCE_LANGUAGE_UNSUPPORTED', 'sourceLanguage', `${model.displayName} does not support ${effective.sourceLanguage}.`));
  }

  if (effective.jobMode === 'translate' && model.translationPairs.length > 0) {
    if (!effective.targetLanguage) {
      errors.push(optionError('TARGET_LANGUAGE_REQUIRED', 'targetLanguage', 'Choose a target language for translation.'));
    } else {
      const pairAllowed = model.translationPairs.some((pair) =>
        (pair.source === '*' || pair.source === effective.sourceLanguage) && pair.target === effective.targetLanguage);
      if (!pairAllowed) errors.push(optionError('TRANSLATION_PAIR_UNSUPPORTED', 'targetLanguage', `${model.displayName} cannot translate from ${effective.sourceLanguage} to ${effective.targetLanguage}.`));
    }
  }

  if (effective.speakerLabels && !model.pyannoteValidated && !model.builtInSpeakers) {
    errors.push(optionError('SPEAKER_LABELS_UNSUPPORTED', 'speakerLabels', `${model.displayName} has not been validated for speaker labels in Transcriber.`));
  }
  if (!effective.speakerLabels && model.builtInSpeakers) {
    errors.push(optionError('SPEAKER_LABELS_REQUIRED', 'speakerLabels', `${model.displayName} always generates speaker labels.`));
  }
  if (effective.expectedSpeakers && !effective.speakerLabels) {
    errors.push(optionError('EXPECTED_SPEAKERS_REQUIRES_LABELS', 'expectedSpeakers', 'Expected speakers is available only when speaker labels are enabled.'));
  } else if (effective.expectedSpeakers && !model.expectedSpeakersSupported) {
    errors.push(optionError('EXPECTED_SPEAKERS_UNSUPPORTED', 'expectedSpeakers', `${model.displayName} does not accept an expected speaker count.`));
  }
  if (effective.reduceRepeatedText && !model.repetitionControl) {
    errors.push(optionError('REPETITION_CONTROL_UNSUPPORTED', 'reduceRepeatedText', `${model.displayName} does not have a tested Reduce repeated text option.`));
  }

  return { valid: errors.length === 0, modelId, effective, errors };
}

module.exports = {
  MODELS,
  getCatalogueModel,
  listCatalogueModels,
  listPresentationModels,
  toPresentationModel,
  validateJobOptions,
};
