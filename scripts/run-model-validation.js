#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createTranscribeWorkerClient } = require('../lib/transcribe-worker-client');
const { createTranscribeRunner } = require('../lib/transcribe-runner');
const { getCatalogueModel } = require('../lib/model-catalogue');

const REPO_ROOT = path.resolve(__dirname, '..');
const VALIDATION_CONTRACT = path.join(__dirname, 'fixtures', 'model-validation.json');
const DEFAULT_WORKER = path.join(REPO_ROOT, 'worker', 'transcribe-worker.mjs');

function round(value) {
  return value == null ? null : Math.round(value * 1000) / 1000;
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', resolve);
  });
  return hash.digest('hex');
}

async function checksum(filePath, expected) {
  try {
    const actual = await sha256(filePath);
    return {
      path: filePath,
      expected: expected || null,
      actual,
      matches: expected ? actual.toLowerCase() === expected.toLowerCase() : null,
      checked: true,
    };
  } catch (error) {
    return {
      path: filePath,
      expected: expected || null,
      actual: null,
      matches: false,
      checked: false,
      error: error.message,
    };
  }
}

function tokenize(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9]+(?:'[a-z0-9]+)*/g) || [];
}

function characters(text) {
  return Array.from(String(text || '').toLowerCase().replace(/\s+/g, ' ').trim());
}

function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function transcriptMetrics(reference, transcript) {
  if (typeof reference !== 'string') {
    return { available: false, wordErrorRate: null, characterErrorRate: null };
  }
  const referenceWords = tokenize(reference);
  const transcriptWords = tokenize(transcript);
  const referenceCharacters = characters(reference);
  const transcriptCharacters = characters(transcript);
  return {
    available: true,
    referenceWordCount: referenceWords.length,
    transcriptWordCount: transcriptWords.length,
    wordErrorRate: referenceWords.length
      ? round(editDistance(referenceWords, transcriptWords) / referenceWords.length)
      : (transcriptWords.length ? 1 : 0),
    characterErrorRate: referenceCharacters.length
      ? round(editDistance(referenceCharacters, transcriptCharacters) / referenceCharacters.length)
      : (transcriptCharacters.length ? 1 : 0),
  };
}

function measuredAnnotations(reference, transcript) {
  if (typeof reference !== 'string') return null;
  const wanted = new Map();
  const found = new Map();
  for (const word of tokenize(reference)) wanted.set(word, (wanted.get(word) || 0) + 1);
  for (const word of tokenize(transcript)) found.set(word, (found.get(word) || 0) + 1);
  const missingWords = [];
  const inventedWords = [];
  for (const [word, count] of wanted) {
    const missing = Math.max(0, count - (found.get(word) || 0));
    if (missing) missingWords.push({ text: word, count: missing, startMs: null, endMs: null });
  }
  for (const [word, count] of found) {
    const invented = Math.max(0, count - (wanted.get(word) || 0));
    if (invented) inventedWords.push({ text: word, count: invented, startMs: null, endMs: null });
  }
  const words = tokenize(transcript);
  const repeatedWords = [];
  for (let index = 1; index < words.length; index += 1) {
    if (words[index] === words[index - 1]) {
      repeatedWords.push({ text: words[index], wordIndex: index, startMs: null, endMs: null });
    }
  }
  return { missingWords, inventedWords, repeatedWords, timingAvailable: false };
}

async function countFiles(targets) {
  let total = 0;
  async function visit(target) {
    let stat;
    try { stat = await fs.promises.lstat(target); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (!stat.isDirectory()) {
      total += 1;
      return;
    }
    for (const entry of await fs.promises.readdir(target)) await visit(path.join(target, entry));
  }
  for (const target of targets) await visit(target);
  return total;
}

function readWorkerRss(pid) {
  if (!pid || process.platform !== 'linux') return null;
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) * 1024 : null;
  } catch (_) {
    return null;
  }
}

function startMemorySampler(workerClient) {
  let peak = null;
  const sample = () => {
    const value = readWorkerRss(workerClient.getState().pid);
    if (value != null) peak = peak == null ? value : Math.max(peak, value);
  };
  const timer = setInterval(sample, 25);
  sample();
  return () => {
    clearInterval(timer);
    sample();
    return peak;
  };
}

function resolveFrom(base, value) {
  if (!value || path.isAbsolute(value)) return value;
  return path.resolve(base, value);
}

function resolveCommand(base, value) {
  if (!value || path.isAbsolute(value)) return value;
  if (!value.includes('/') && !value.includes('\\')) return value;
  return path.resolve(base, value);
}

function defaultRuntimeFiles() {
  const files = [{ path: process.execPath }, { path: DEFAULT_WORKER }];
  try {
    files.push({ path: require.resolve('transcribe-cpp') });
  } catch (_) {}
  return files;
}

function getCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch (_) {
    return null;
  }
}

function normalizeManifest(manifest, manifestPath) {
  const base = path.dirname(manifestPath);
  const models = new Map((manifest.models || []).map((model) => [model.id, {
    ...model,
    path: resolveFrom(base, model.path),
  }]));
  const fixtures = new Map((manifest.fixtures || manifest.corpus || []).map((fixture) => [fixture.id, {
    ...fixture,
    audioPath: resolveFrom(base, fixture.audioPath || fixture.path),
    tempDirectories: (fixture.tempDirectories || []).map((item) => resolveFrom(base, item)),
  }]));
  let runs = manifest.runs || [];
  if (runs.length === 0) {
    runs = [];
    for (const model of models.values()) {
      for (const fixture of fixtures.values()) runs.push({ modelId: model.id, fixtureId: fixture.id });
    }
  }
  const cases = runs.map((run, index) => {
    const fixture = fixtures.get(run.fixtureId) || {};
    const model = models.get(run.modelId);
    if (!model) throw new Error(`Run ${index + 1} refers to unknown model ${run.modelId}`);
    return {
      ...fixture,
      ...run,
      id: run.id || `${run.modelId}:${run.fixtureId}`,
      model,
      audioPath: resolveFrom(base, run.audioPath || fixture.audioPath),
      tempDirectories: (run.tempDirectories || fixture.tempDirectories || []).map((item) => resolveFrom(base, item)),
      evidenceIds: run.evidenceIds || fixture.evidenceIds || [],
      annotations: run.annotations || fixture.annotations || null,
      assessment: run.assessment || fixture.assessment || null,
    };
  });
  const runtime = manifest.runtime || {};
  const command = runtime.command
    ? resolveCommand(base, runtime.command)
    : process.execPath;
  const args = runtime.args
    ? runtime.args.map((value) => value.startsWith('.') ? resolveFrom(base, value) : value)
    : [DEFAULT_WORKER];
  return {
    cases,
    runtime: {
      command,
      args,
      env: runtime.env ? { ...process.env, ...runtime.env } : process.env,
      files: (runtime.files || defaultRuntimeFiles()).map((file) => ({
        ...file,
        path: resolveFrom(base, file.path),
      })),
    },
  };
}

function requiredEvidenceFor(modelId, contract) {
  return [...(contract.taskChoices || []), ...(contract.expandedModels || [])]
    .filter((entry) => entry.modelId === modelId)
    .flatMap((entry) => entry.evidenceIds || []);
}

function summarizeEvidence(modelIds, runs, contract) {
  const models = {};
  for (const modelId of modelIds) {
    const required = requiredEvidenceFor(modelId, contract);
    const evidence = {};
    for (const evidenceId of required) {
      const matching = runs.filter((run) => run.evidenceIds.includes(evidenceId));
      let state = 'missing';
      if (matching.length > 0 && matching.some((run) => run.assessment.passed === false)) state = 'failed';
      else if (matching.length > 0 && matching.some((run) => !run.ok)) state = 'failed-run';
      else if (matching.length > 0 && matching.every((run) => run.ok && run.assessment.passed === true)) state = 'passed';
      else if (matching.length > 0) state = 'missing-assessment';
      evidence[evidenceId] = { state, runIds: matching.map((run) => run.id) };
    }
    models[modelId] = {
      requiredEvidenceIds: required,
      evidence,
      missingEvidenceIds: required.filter((id) => evidence[id].state !== 'passed'),
      promotionPerformed: false,
      catalogueStatusChanged: false,
    };
  }
  return models;
}

async function runCancellation(runner, params, cancellation) {
  if (!cancellation || cancellation.enabled === false) return { requested: false, available: false };
  const controller = new AbortController();
  const delayMs = cancellation.cancelAfterMs == null ? 100 : cancellation.cancelAfterMs;
  let abortAt;
  const timer = setTimeout(() => {
    abortAt = process.hrtime.bigint();
    controller.abort();
  }, delayMs);
  try {
    await runner.transcribe({ ...params, signal: controller.signal });
    clearTimeout(timer);
    return {
      requested: abortAt != null,
      available: true,
      stoppedUsefulWork: false,
      latencyMs: abortAt == null ? null : round(Number(process.hrtime.bigint() - abortAt) / 1e6),
      passed: false,
      error: 'Transcription completed instead of being cancelled',
    };
  } catch (error) {
    clearTimeout(timer);
    const latencyMs = abortAt == null ? null : Number(process.hrtime.bigint() - abortAt) / 1e6;
    const maxLatencyMs = cancellation.maxLatencyMs == null ? 2000 : cancellation.maxLatencyMs;
    return {
      requested: abortAt != null,
      available: abortAt != null,
      stoppedUsefulWork: abortAt != null,
      latencyMs: round(latencyMs),
      maxLatencyMs,
      passed: abortAt != null && latencyMs <= maxLatencyMs,
      errorCode: error.code || error.name || 'ERROR',
      error: error.message,
    };
  }
}

async function runValidation(options) {
  const manifestPath = path.resolve(options.manifestPath);
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  const normalized = normalizeManifest(manifest, manifestPath);
  const contractPath = options.contractPath || VALIDATION_CONTRACT;
  const contract = JSON.parse(await fs.promises.readFile(contractPath, 'utf8'));
  const selected = options.modelIds && options.modelIds.length
    ? new Set(options.modelIds)
    : null;
  const cases = normalized.cases.filter((entry) => !selected || selected.has(entry.modelId));
  if (cases.length === 0) throw new Error('No validation runs match the selected model IDs');
  const modelIds = [...new Set(cases.map((entry) => entry.modelId))];
  const unknownSelections = selected ? [...selected].filter((id) => !modelIds.includes(id)) : [];
  if (unknownSelections.length) throw new Error(`Selected model IDs have no runs: ${unknownSelections.join(', ')}`);

  const runtimeChecks = [];
  for (const file of normalized.runtime.files) runtimeChecks.push(await checksum(file.path, file.sha256));
  const manifestCheck = await checksum(manifestPath, null);
  const loadEvents = [];
  const workerClient = createTranscribeWorkerClient({
    launch: normalized.runtime,
    timeoutMs: manifest.timeoutMs || 24 * 60 * 60 * 1000,
    log: options.log || (() => {}),
    onEvent: (event) => loadEvents.push(event),
  });
  const runner = createTranscribeRunner({ workerClient });
  const allTempDirectories = [...new Set(cases.flatMap((entry) => entry.tempDirectories))];
  const tempBefore = await countFiles(allTempDirectories);
  const workerBefore = workerClient.getState().running ? 1 : 0;
  const runs = [];
  let tempAfterRuns = tempBefore;
  let workerAfterRuns = workerBefore;

  try {
    for (const entry of cases) {
      const catalogueResolver = options.catalogueResolver || getCatalogueModel;
      const modelSpec = catalogueResolver(entry.modelId);
      const modelCheck = await checksum(entry.model.path, modelSpec.sha256);
      const sourceCheck = await checksum(entry.audioPath, entry.sha256);
      const blockingChecks = [modelCheck, sourceCheck, ...runtimeChecks]
        .filter((check) => check.checked === false || check.matches === false);
      const record = {
        id: entry.id,
        fixtureId: entry.fixtureId,
        sourceId: entry.sourceId || null,
        durationRole: entry.durationRole || null,
        modelId: entry.modelId,
        modelRevision: modelSpec.revision || null,
        evidenceIds: entry.evidenceIds,
        checksums: { source: sourceCheck, model: modelCheck, runtime: runtimeChecks },
        options: entry.options || {},
        assessment: typeof (entry.assessment && entry.assessment.passed) === 'boolean'
          ? { passed: entry.assessment.passed, source: 'manifest', notes: entry.assessment.notes || null }
          : { passed: null, source: 'missing', notes: 'No explicit promotion assessment was supplied.' },
      };
      const caseTempBefore = await countFiles(entry.tempDirectories);
      record.temporaryFiles = {
        directories: entry.tempDirectories,
        before: caseTempBefore,
        after: null,
        delta: null,
      };
      if (blockingChecks.length) {
        record.ok = false;
        record.skipped = true;
        record.error = 'Checksum verification failed';
        record.cancellation = { requested: false, available: false };
        record.transcript = null;
        record.metrics = { available: false, wordErrorRate: null, characterErrorRate: null };
        record.annotations = {
          supplied: entry.annotations || null,
          measured: null,
          missingPromotionAnnotation: !entry.annotations,
        };
        record.temporaryFiles.after = await countFiles(entry.tempDirectories);
        record.temporaryFiles.delta = record.temporaryFiles.after - caseTempBefore;
        runs.push(record);
        continue;
      }

      const loadEventStart = loadEvents.length;
      const wallStartedAt = process.hrtime.bigint();
      const stopMemorySampler = startMemorySampler(workerClient);
      try {
        const transcribed = await runner.transcribe({
          modelSpec,
          modelPath: entry.model.path,
          wavPath: entry.audioPath,
          options: entry.options || {},
          onProgress: () => {},
        });
        record.ok = true;
        record.backend = transcribed.backend;
        record.transcript = transcribed.result;
        record.metrics = transcriptMetrics(entry.referenceTranscript, transcribed.output);
        record.annotations = {
          supplied: entry.annotations || null,
          measured: measuredAnnotations(entry.referenceTranscript, transcribed.output),
          missingPromotionAnnotation: !entry.annotations,
        };
      } catch (error) {
        record.ok = false;
        record.errorCode = error.code || error.name || 'ERROR';
        record.error = error.message;
        record.transcript = null;
        record.metrics = { available: false, wordErrorRate: null, characterErrorRate: null };
        record.annotations = {
          supplied: entry.annotations || null,
          measured: null,
          missingPromotionAnnotation: !entry.annotations,
        };
      } finally {
        record.timing = {
          wallTimeMs: round(Number(process.hrtime.bigint() - wallStartedAt) / 1e6),
          modelLoadTimeMs: round(loadEvents.slice(loadEventStart).reduce((sum, event) => sum + event.durationMs, 0)),
          loadEvents: loadEvents.slice(loadEventStart),
        };
        record.memory = {
          peakWorkerRamBytes: stopMemorySampler(),
          peakGpuMemoryBytes: null,
          gpuMeasurementAvailable: false,
        };
      }
      record.cancellation = await runCancellation(runner, {
        modelSpec,
        modelPath: entry.model.path,
        wavPath: entry.audioPath,
        options: entry.options || {},
        onProgress: () => {},
      }, entry.cancellation);
      record.temporaryFiles.after = await countFiles(entry.tempDirectories);
      record.temporaryFiles.delta = record.temporaryFiles.after - caseTempBefore;
      runs.push(record);
    }
    tempAfterRuns = await countFiles(allTempDirectories);
    workerAfterRuns = workerClient.getState().running ? 1 : 0;
  } finally {
    await runner.shutdown();
  }

  const tempAfterShutdown = await countFiles(allTempDirectories);
  const workerAfterShutdown = workerClient.getState().running ? 1 : 0;
  const evidence = summarizeEvidence(modelIds, runs, contract);
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    applicationCommit: getCommit(),
    manifest: manifestCheck,
    platform: {
      platform: process.platform,
      architecture: process.arch,
      release: os.release(),
      node: process.version,
      cpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    runtime: {
      command: normalized.runtime.command,
      args: normalized.runtime.args,
      checksums: runtimeChecks,
    },
    checksumSummary: {
      allReadable: [manifestCheck, ...runtimeChecks, ...runs.flatMap((run) => [run.checksums.source, run.checksums.model])]
        .every((check) => check.checked),
      allInputsPinned: [...runtimeChecks, ...runs.flatMap((run) => [run.checksums.source, run.checksums.model])]
        .every((check) => !!check.expected),
      allPinnedInputsMatch: [...runtimeChecks, ...runs.flatMap((run) => [run.checksums.source, run.checksums.model])]
        .filter((check) => !!check.expected)
        .every((check) => check.matches === true),
    },
    runs,
    leakChecks: {
      workerCounts: {
        before: workerBefore,
        afterRuns: workerAfterRuns,
        afterShutdown: workerAfterShutdown,
        leaked: workerAfterShutdown > workerBefore,
      },
      temporaryFileCounts: {
        directories: allTempDirectories,
        before: tempBefore,
        afterRuns: tempAfterRuns,
        afterShutdown: tempAfterShutdown,
        delta: tempAfterShutdown - tempBefore,
        leaked: tempAfterShutdown > tempBefore,
      },
    },
    evidence,
    promotion: {
      performed: false,
      catalogueChanged: false,
      statement: 'This harness records evidence only. It never promotes a model.',
      missingEvidenceByModel: Object.fromEntries(Object.entries(evidence)
        .map(([id, value]) => [id, value.missingEvidenceIds])),
    },
  };
  const outputPath = path.resolve(options.outputPath || path.join(
    os.tmpdir(),
    'transcriber-model-validation',
    `validation-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  ));
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  return { result, outputPath };
}

function parseArguments(argv) {
  const parsed = { modelIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--manifest') parsed.manifestPath = argv[++index];
    else if (value === '--output') parsed.outputPath = argv[++index];
    else if (value === '--model') parsed.modelIds.push(argv[++index]);
    else if (value === '--help' || value === '-h') parsed.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return parsed;
}

function usage() {
  return [
    'Usage: node scripts/run-model-validation.js --manifest PATH [options]',
    '',
    'Options:',
    '  --model ID     Run only this model ID. May be repeated.',
    '  --output PATH  Write the JSON result here. The default is outside the repo.',
    '  --help         Show this help.',
    '',
    'The manifest contains models, fixtures and optional explicit runs. All paths',
    'are relative to the manifest. Each source needs sha256. Model checks use the',
    'catalogue checksum. Runtime files may include sha256 values to pin the runtime.',
  ].join('\n');
}

if (require.main === module) {
  Promise.resolve().then(async () => {
    const args = parseArguments(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    if (!args.manifestPath) throw new Error('--manifest is required');
    const { outputPath, result } = await runValidation({
      ...args,
      log: (message) => process.stderr.write(`${message}\n`),
    });
    process.stdout.write(`${JSON.stringify({
      outputPath,
      runCount: result.runs.length,
      failedRunCount: result.runs.filter((run) => !run.ok).length,
      promotionPerformed: false,
      missingEvidenceByModel: result.promotion.missingEvidenceByModel,
    })}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  checksum,
  editDistance,
  measuredAnnotations,
  parseArguments,
  runValidation,
  transcriptMetrics,
  usage,
};
