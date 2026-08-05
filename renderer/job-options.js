// Pure state and presentation helpers for the Job options card.

(function exposeJobOptions(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.JobOptions = api;
  }
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function createJobOptionsApi() {
  const OPTION_FIELDS = Object.freeze([
    'jobMode',
    'sourceLanguage',
    'targetLanguage',
    'speakerLabels',
    'expectedSpeakers',
    'reduceRepeatedText',
  ]);

  const DEFAULT_REQUESTED = Object.freeze({
    jobMode: 'transcribe',
    sourceLanguage: null,
    targetLanguage: null,
    speakerLabels: false,
    expectedSpeakers: null,
    reduceRepeatedText: false,
  });

  const AUTOMATIC_FALLBACKS = Object.freeze({
    INVALID_JOB_MODE: (model, effective) => ({ ...effective, jobMode: 'transcribe' }),
    TRANSLATION_UNSUPPORTED: (model, effective) => ({ ...effective, jobMode: 'transcribe', targetLanguage: null }),
    SOURCE_LANGUAGE_AUTO_ONLY: (model, effective) => ({ ...effective, sourceLanguage: 'auto' }),
    SOURCE_LANGUAGE_FIXED: (model, effective) => ({ ...effective, sourceLanguage: model.languages[0] }),
    SOURCE_LANGUAGE_REQUIRED: (model, effective) => ({ ...effective, sourceLanguage: firstExplicitLanguage(model) }),
    SOURCE_LANGUAGE_UNSUPPORTED: (model, effective) => ({ ...effective, sourceLanguage: defaultSourceLanguage(model) }),
    SPEAKER_LABELS_UNSUPPORTED: (model, effective) => ({ ...effective, speakerLabels: false, expectedSpeakers: null }),
    SPEAKER_LABELS_REQUIRED: (model, effective) => ({ ...effective, speakerLabels: true }),
    EXPECTED_SPEAKERS_REQUIRES_LABELS: (model, effective) => ({ ...effective, expectedSpeakers: null }),
    EXPECTED_SPEAKERS_UNSUPPORTED: (model, effective) => ({ ...effective, expectedSpeakers: null }),
    REPETITION_CONTROL_UNSUPPORTED: (model, effective) => ({ ...effective, reduceRepeatedText: false }),
  });

  const COMMON_MULTILINGUAL_CHOICES = Object.freeze([
    ['en', 'English'], ['de', 'German'], ['es', 'Spanish'], ['fr', 'French'],
    ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'],
    ['ru', 'Russian'], ['uk', 'Ukrainian'], ['ar', 'Arabic'], ['hi', 'Hindi'],
    ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'],
  ]);

  function firstExplicitLanguage(model) {
    return model.languages.find((language) => language !== 'multilingual') || 'auto';
  }

  function defaultSourceLanguage(model) {
    if (model.languageSelection === 'fixed') return model.languages[0];
    if (model.languageSelection === 'required') return firstExplicitLanguage(model);
    return 'auto';
  }

  function createJobOptionsState(initial = {}) {
    const requested = {};
    for (const field of OPTION_FIELDS) {
      requested[field] = Object.prototype.hasOwnProperty.call(initial, field)
        ? initial[field]
        : DEFAULT_REQUESTED[field];
    }
    return {
      optionsOpen: !!initial.optionsOpen,
      advancedOpen: !!initial.advancedOpen,
      requested,
    };
  }

  function setOptionsOpen(state, open) {
    return { ...state, optionsOpen: !!open };
  }

  function setAdvancedOpen(state, open) {
    return { ...state, advancedOpen: !!open };
  }

  function updateJobOption(state, field, value) {
    if (!OPTION_FIELDS.includes(field)) throw new Error(`Unknown job option: ${field}`);
    return { ...state, requested: { ...state.requested, [field]: value } };
  }

  function errorsForField(result, field) {
    return result.errors.filter((error) => error.field === field);
  }

  function findError(result, codes) {
    return result.errors.find((error) => codes.includes(error.code)) || null;
  }

  function validateProbe(validate, model, requested, changes) {
    return validate(model.id, { ...requested, ...changes });
  }

  function probeReason(validate, model, requested, changes, codes) {
    const error = findError(validateProbe(validate, model, requested, changes), codes);
    return error ? error.message : null;
  }

  function resolveEffectiveOptions(model, requested, validate) {
    let result = validate(model.id, requested);
    const adjustments = [];

    // Two passes cover dependent fixes such as disabling unsupported labels and
    // then clearing an expected speaker count which required those labels.
    for (let pass = 0; pass < 2; pass += 1) {
      let effective = { ...result.effective };
      let changed = false;
      for (const error of result.errors) {
        const fallback = AUTOMATIC_FALLBACKS[error.code];
        if (!fallback) continue;
        const next = fallback(model, effective);
        if (JSON.stringify(next) !== JSON.stringify(effective)) {
          effective = next;
          changed = true;
          adjustments.push(error);
        }
      }
      if (!changed) break;
      result = validate(model.id, effective);
    }

    return {
      effective: result.effective,
      valid: result.valid,
      errors: result.errors,
      adjustments,
    };
  }

  function sourceLanguageChoices(model) {
    const choices = [];
    if (model.languageSelection !== 'fixed' && model.languageSelection !== 'required') {
      choices.push({ value: 'auto', label: 'Automatic' });
    }
    for (const language of model.languages) {
      if (language !== 'multilingual') choices.push({ value: language, label: language });
    }
    if (model.languageSelection === 'select-or-auto' && model.languages.includes('multilingual')) {
      for (const [value, name] of COMMON_MULTILINGUAL_CHOICES) {
        choices.push({ value, label: `${name} (${value})` });
      }
    }
    return choices;
  }

  function targetLanguageChoices(model, sourceLanguage) {
    const targets = model.translationPairs
      .filter((pair) => pair.source === '*' || pair.source === sourceLanguage)
      .map((pair) => pair.target);
    return [...new Set(targets)].map((language) => ({ value: language, label: language }));
  }

  function formatSummary(model, effective) {
    const parts = [effective.jobMode === 'translate' ? 'Translate' : 'Transcribe'];
    parts.push(effective.sourceLanguage === 'auto' ? 'Detect language' : `Source: ${effective.sourceLanguage}`);
    if (effective.jobMode === 'translate') {
      parts.push(`Target: ${effective.targetLanguage || 'Not selected'}`);
    }
    if (model.pyannoteValidated || model.builtInSpeakers) {
      parts.push(effective.speakerLabels ? 'Speaker labels' : 'No speaker labels');
    }
    if (effective.speakerLabels && effective.expectedSpeakers) {
      parts.push(`Expected speakers: ${effective.expectedSpeakers}`);
    }
    if (model.repetitionControl && effective.reduceRepeatedText) parts.push('Reduce repeated text');
    return parts.join(' - ');
  }

  function deriveJobOptions(model, state, validate) {
    if (!model || !model.id) throw new Error('A catalogue model is required.');
    if (typeof validate !== 'function') throw new Error('A job option validator is required.');

    const resolved = resolveEffectiveOptions(model, state.requested, validate);
    const effective = resolved.effective;
    const coreVisible = !!state.optionsOpen;
    const advancedVisible = coreVisible && !!state.advancedOpen;
    const translationReason = probeReason(validate, model, state.requested,
      { jobMode: 'translate' }, ['TRANSLATION_UNSUPPORTED']);
    const fixedSourceReason = model.languageSelection === 'fixed'
      ? probeReason(validate, model, state.requested, { sourceLanguage: 'auto' }, ['SOURCE_LANGUAGE_FIXED'])
      : null;
    const automaticSourceReason = model.languageSelection === 'auto-only'
      ? probeReason(validate, model, state.requested,
        { sourceLanguage: model.languages.find((language) => language !== 'multilingual') || 'en' },
        ['SOURCE_LANGUAGE_AUTO_ONLY'])
      : null;
    const labelsOnReason = probeReason(validate, model, state.requested,
      { speakerLabels: true }, ['SPEAKER_LABELS_UNSUPPORTED']);
    const labelsOffReason = probeReason(validate, model, state.requested,
      { speakerLabels: false }, ['SPEAKER_LABELS_REQUIRED']);
    const expectedSpeakersReason = !effective.speakerLabels
      ? probeReason(validate, model, state.requested,
        { speakerLabels: false, expectedSpeakers: 2 }, ['EXPECTED_SPEAKERS_REQUIRES_LABELS'])
      : probeReason(validate, model, state.requested,
        { speakerLabels: true, expectedSpeakers: 2 }, ['EXPECTED_SPEAKERS_UNSUPPORTED']);
    const repetitionReason = probeReason(validate, model, state.requested,
      { reduceRepeatedText: true }, ['REPETITION_CONTROL_UNSUPPORTED']);
    const targetErrors = errorsForField(resolved, 'targetLanguage');

    return {
      modelId: model.id,
      optionsOpen: !!state.optionsOpen,
      advancedOpen: !!state.advancedOpen,
      effective,
      valid: resolved.valid,
      errors: resolved.errors,
      adjustments: resolved.adjustments,
      summary: formatSummary(model, effective),
      controls: {
        jobMode: {
          layer: 'core',
          visible: coreVisible,
          enabled: !translationReason,
          value: effective.jobMode,
          reason: translationReason,
          choices: [
            { value: 'transcribe', label: 'Transcribe', enabled: true },
            { value: 'translate', label: 'Translate', enabled: !translationReason },
          ],
        },
        sourceLanguage: {
          layer: 'core',
          visible: coreVisible,
          enabled: !fixedSourceReason && !automaticSourceReason,
          value: effective.sourceLanguage,
          reason: fixedSourceReason || automaticSourceReason,
          choices: sourceLanguageChoices(model),
          acceptsAnyLanguage: model.languages.includes('multilingual'),
        },
        targetLanguage: {
          layer: 'core',
          visible: coreVisible && effective.jobMode === 'translate',
          enabled: !translationReason,
          value: effective.targetLanguage,
          reason: targetErrors.length ? targetErrors[0].message : null,
          choices: targetLanguageChoices(model, effective.sourceLanguage),
        },
        speakerLabels: {
          layer: 'core',
          visible: coreVisible,
          enabled: !labelsOnReason && !labelsOffReason,
          value: effective.speakerLabels,
          reason: labelsOnReason || labelsOffReason,
          required: !!labelsOffReason,
        },
        expectedSpeakers: {
          layer: 'advanced',
          visible: advancedVisible,
          enabled: effective.speakerLabels && !expectedSpeakersReason,
          value: effective.expectedSpeakers,
          reason: expectedSpeakersReason,
        },
        reduceRepeatedText: {
          layer: 'advanced',
          visible: advancedVisible,
          enabled: !repetitionReason,
          value: effective.reduceRepeatedText,
          reason: repetitionReason,
          help: 'Helps with repetition loops. It does not prevent silent omissions or other errors.',
        },
      },
    };
  }

  function formatDuration(seconds) {
    const wholeSeconds = Math.ceil(seconds);
    const minutes = Math.floor(wholeSeconds / 60);
    const remainingSeconds = wholeSeconds % 60;
    const parts = [];
    if (minutes) parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
    if (remainingSeconds || !minutes) {
      parts.push(`${remainingSeconds} ${remainingSeconds === 1 ? 'second' : 'seconds'}`);
    }
    return parts.join(' ');
  }

  function getAudioLimitMessageData(model, durationSeconds) {
    if (!model || !model.audioLimitSeconds || !Number.isFinite(durationSeconds)
      || durationSeconds <= model.audioLimitSeconds) {
      return null;
    }
    const limitLabel = formatDuration(model.audioLimitSeconds);
    const durationLabel = formatDuration(durationSeconds);
    return {
      code: 'AUDIO_DURATION_LIMIT_EXCEEDED',
      modelId: model.id,
      modelName: model.displayName,
      limitSeconds: model.audioLimitSeconds,
      durationSeconds,
      limitLabel,
      durationLabel,
      message: `${model.displayName} supports recordings up to ${limitLabel}. This file is ${durationLabel}.`,
    };
  }

  return Object.freeze({
    createJobOptionsState,
    setOptionsOpen,
    setAdvancedOpen,
    updateJobOption,
    resolveEffectiveOptions,
    deriveJobOptions,
    getAudioLimitMessageData,
  });
}));
