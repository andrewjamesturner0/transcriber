// Engine-neutral transcript results.

const OPTIONAL_ARRAY_FIELDS = ['segments', 'words', 'tokens'];
const TIMING_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9]*Ms$/;

function assertString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Transcript result ${field} must be a non-empty string`);
  }
}

function copyOptional(target, source, field, predicate) {
  if (source[field] == null) return;
  if (!predicate(source[field])) throw new Error(`Transcript result ${field} is invalid`);
  target[field] = source[field];
}

function normalizeTimings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Transcript result timings is invalid');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Transcript result timings is invalid');
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = Object.entries(descriptors).filter(([, descriptor]) => descriptor.enumerable);
  if (entries.length === 0 || Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error('Transcript result timings is invalid');
  }

  const timings = {};
  for (const [field, descriptor] of entries) {
    const duration = descriptor.value;
    if (!TIMING_FIELD_PATTERN.test(field)
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || typeof duration !== 'number'
      || !Number.isFinite(duration)
      || duration < 0) {
      throw new Error('Transcript result timings is invalid');
    }
    timings[field] = duration;
  }
  return timings;
}

function createTranscriptResult(input) {
  if (!input || typeof input !== 'object') throw new Error('Transcript result must be an object');
  if (typeof input.text !== 'string') throw new Error('Transcript result text must be a string');
  assertString(input.model, 'model');
  assertString(input.engine, 'engine');
  assertString(input.backend, 'backend');

  const result = {
    text: input.text,
    model: input.model,
    engine: input.engine,
    backend: input.backend,
  };

  copyOptional(result, input, 'selectedLanguage', (value) => typeof value === 'string' && value.length > 0);
  copyOptional(result, input, 'detectedLanguage', (value) => typeof value === 'string' && value.length > 0);
  for (const field of OPTIONAL_ARRAY_FIELDS) {
    copyOptional(result, input, field, Array.isArray);
  }
  if (input.timings != null) result.timings = normalizeTimings(input.timings);
  copyOptional(result, input, 'truncated', (value) => typeof value === 'boolean');
  return result;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry != null));
}

function normalizeWhisperJson(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const normalized = {};
  const language = raw.result && raw.result.language ? raw.result.language : raw.language;
  if (typeof language === 'string' && language) normalized.detectedLanguage = language;

  if (Array.isArray(raw.transcription)) {
    normalized.segments = raw.transcription.map((segment) => compactObject({
      text: segment.text,
      startMs: segment.offsets && segment.offsets.from != null ? segment.offsets.from : segment.startMs,
      endMs: segment.offsets && segment.offsets.to != null ? segment.offsets.to : segment.endMs,
    }));
    const tokens = raw.transcription.flatMap((segment) => Array.isArray(segment.tokens) ? segment.tokens : []);
    if (tokens.length > 0) normalized.tokens = tokens;
    const words = [];
    for (const segment of raw.transcription) {
      let current = null;
      let previousEnd = null;
      for (const token of Array.isArray(segment.tokens) ? segment.tokens : []) {
        if (typeof token.text !== 'string' || token.text.startsWith('[_')) continue;
        const startMs = token.offsets ? token.offsets.from : previousEnd;
        const endMs = token.offsets ? token.offsets.to : previousEnd;
        if (!current || token.text.startsWith(' ')) {
          if (current) words.push(current);
          current = { text: token.text.trimStart(), startMs, endMs };
        } else {
          current.text += token.text;
          if (endMs != null) current.endMs = endMs;
        }
        if (token.offsets) previousEnd = token.offsets.to;
      }
      if (current) words.push(current);
    }
    if (words.some((word) => word.startMs != null || word.endMs != null)) normalized.words = words;
  } else if (Array.isArray(raw.segments)) {
    normalized.segments = raw.segments;
  }
  if (Array.isArray(raw.words) && raw.words.length > 0) normalized.words = raw.words;
  if (Array.isArray(raw.tokens) && raw.tokens.length > 0) normalized.tokens = raw.tokens;
  if (raw.timings != null) normalized.timings = normalizeTimings(raw.timings);
  if (typeof raw.truncated === 'boolean') normalized.truncated = raw.truncated;
  return normalized;
}

function withTranscriptDetail(result, detail) {
  return createTranscriptResult({ ...result, ...detail });
}

module.exports = {
  createTranscriptResult,
  normalizeWhisperJson,
  withTranscriptDetail,
};
