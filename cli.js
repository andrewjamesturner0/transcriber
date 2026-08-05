#!/usr/bin/env node
// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

/**
 * Command-line interface for Transcriber.
 *
 * Runs the same local transcription pipeline as the
 * Electron GUI without opening a window. Reuses the lib/
 * factories unchanged. Never requires('electron'); never reads or writes the
 * GUI's settings.json.
 *
 * Subcommands:
 *   transcribe <file>     run the full pipeline on one input file
 *   download-model <id>   fetch a model into writable per-user storage
 *   list-models           print the canonical model list
 *   gpu-status            print detected backend and DTW support
 *
 * See docs/cli.md for the full reference.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const paths = require('./lib/paths');
paths.initPaths({
  isPackaged: false,
  resourcesPath: __dirname,
  modelDirectory: paths.getStandaloneModelDirectory(),
});

const models = require('./lib/models');
const Capabilities = require('./lib/capabilities');
const { createTranscriptionRunner } = require('./lib/transcription-runner');

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const TOP_HELP = `Usage: node cli.js <subcommand> [options]

Subcommands:
  transcribe <file>        run the full pipeline on one input file
  download-model <id>      fetch a model into writable per-user storage
  list-models              print the canonical model list
  gpu-status               print detected backend and DTW support

Run "node cli.js <subcommand> --help" for subcommand-specific options.
`;

const TRANSCRIBE_HELP = `Usage: node cli.js transcribe <file> [options]

Run the full transcription pipeline on one audio or video file.

Options:
  --model <id>            model id (default: tiny.en); see "list-models"
  --backend auto|cpu|vulkan
                          local inference backend (default: auto)
  --format txt|json       output format (default: txt)
  --output <path>         write output to file instead of stdout
  --job-mode transcribe|translate
                          job mode (default: transcribe)
  --source-language <id>  source language id or auto
  --target-language <id>  target language id for translation
  --diarize               enable pyannote speaker diarisation
  --reduce-repeated-text  reduce repeated transcript text where supported
  --anti-corruption       compatibility alias for --reduce-repeated-text
  --hf-token <token>      Hugging Face token (or set HF_TOKEN env var)
  --num-speakers <n>      tell the diariser how many speakers to expect
  --quiet                 suppress progress output on stderr
  -h, --help              show this help and exit
`;

const DOWNLOAD_HELP = `Usage: node cli.js download-model <id> [options]

Fetch a model from Hugging Face into writable per-user storage. If a matching
writable or bundled model is already present this is a no-op.

Options:
  --hf-token <token>  Hugging Face token (or set HF_TOKEN env var)
  --quiet             suppress progress output on stderr
  -h, --help          show this help and exit
`;

const LIST_HELP = `Usage: node cli.js list-models [options]

Print the canonical model list, marking which are already on disk.

Options:
  --json      emit machine-readable JSON instead of a table
  -h, --help  show this help and exit
`;

const GPU_HELP = `Usage: node cli.js gpu-status [options]

Print detected GPU backend, device name, and available backends.

Options:
  --json      emit machine-readable JSON instead of human-readable text
  -h, --help  show this help and exit
`;

// ---------------------------------------------------------------------------
// Hand-rolled argument parser
// ---------------------------------------------------------------------------

/**
 * Parse a flag list against a spec. Returns { positional, flags }.
 *
 * Spec maps flag name (with leading --/-) to { takesValue: boolean }.
 * Unknown flags throw.
 */
function parseArgs(argv, spec) {
  const flags = {};
  const positional = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('-')) {
      const flagSpec = spec[arg];
      if (!flagSpec) {
        throw new Error(`Unknown flag: ${arg}`);
      }
      if (flagSpec.takesValue) {
        if (i + 1 >= argv.length) {
          throw new Error(`Flag ${arg} requires a value`);
        }
        flags[arg] = argv[i + 1];
        i += 2;
      } else {
        flags[arg] = true;
        i += 1;
      }
    } else {
      positional.push(arg);
      i += 1;
    }
  }
  return { positional, flags };
}

function die(msg, code) {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
  process.exit(code != null ? code : 1);
}

// ---------------------------------------------------------------------------
// Subcommand: transcribe
// ---------------------------------------------------------------------------

const TRANSCRIBE_SPEC = {
  '--model': { takesValue: true },
  '--backend': { takesValue: true },
  '--format': { takesValue: true },
  '--output': { takesValue: true },
  '--job-mode': { takesValue: true },
  '--source-language': { takesValue: true },
  '--target-language': { takesValue: true },
  '--diarize': { takesValue: false },
  '--reduce-repeated-text': { takesValue: false },
  '--anti-corruption': { takesValue: false },
  '--hf-token': { takesValue: true },
  '--num-speakers': { takesValue: true },
  '--quiet': { takesValue: false },
  '--help': { takesValue: false },
  '-h': { takesValue: false },
};

async function cmdTranscribe(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv, TRANSCRIBE_SPEC);
  } catch (err) {
    die(`${err.message}\n\n${TRANSCRIBE_HELP}`);
  }
  const { positional, flags } = parsed;
  if (flags['--help'] || flags['-h']) {
    process.stdout.write(TRANSCRIBE_HELP);
    process.exit(0);
  }
  if (positional.length === 0) {
    die(`transcribe: missing <file> argument\n\n${TRANSCRIBE_HELP}`);
  }
  if (positional.length > 1) {
    die(`transcribe: only one input file is supported per invocation; got ${positional.length}\n${TRANSCRIBE_HELP}`);
  }

  const filePath = positional[0];
  if (!fs.existsSync(filePath)) {
    die(`transcribe: input file not found: ${filePath}`);
  }

  const modelId = flags['--model'] || 'tiny.en';
  const backendArg = flags['--backend'] || 'auto';
  if (!['auto', 'cpu', 'vulkan'].includes(backendArg)) {
    die(`transcribe: --backend must be auto, cpu, or vulkan (got "${backendArg}")`);
  }
  const format = flags['--format'] || 'txt';
  if (!['txt', 'json'].includes(format)) {
    die(`transcribe: --format must be txt or json (got "${format}")`);
  }
  const diarize = !!flags['--diarize'];
  const jobMode = flags['--job-mode'] || 'transcribe';
  const sourceLanguage = flags['--source-language'];
  const targetLanguage = flags['--target-language'];
  const reduceRepeatedText = !!(flags['--reduce-repeated-text'] || flags['--anti-corruption']);
  const quiet = !!flags['--quiet'];
  const outputPath = flags['--output'];

  let numSpeakers;
  if (flags['--num-speakers'] != null) {
    const value = flags['--num-speakers'];
    numSpeakers = Number(value);
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(numSpeakers) || numSpeakers < 1) {
      die(`transcribe: --num-speakers must be a positive integer (got "${flags['--num-speakers']}")`);
    }
  }

  let modelSpec;
  try {
    modelSpec = models.getModel(modelId);
  } catch (err) {
    die(`transcribe: ${err.message}`);
  }

  if (modelSpec.runtimeAvailable === false) {
    die(`transcribe: ${modelSpec.displayName} is deferred until a compatible ${modelSpec.engine} release is available.`);
  }

  const optionValidation = models.validateJobOptions(modelId, {
    jobMode,
    sourceLanguage,
    targetLanguage,
    diarization: diarize,
    numSpeakers,
    reduceRepeatedText,
  });
  if (!optionValidation.valid) {
    const first = optionValidation.errors[0];
    die(`transcribe: ${first.message} (${first.code})`);
  }

  let hfToken;
  if (diarize) {
    hfToken = flags['--hf-token'] || process.env.HF_TOKEN;
    if (!hfToken) {
      die('transcribe: --diarize requires --hf-token <token> or $HF_TOKEN');
    }
  }

  // Build capabilities with lazy detection appropriate for the flags
  const capabilities = new Capabilities({
    getPreference: () => undefined,
    setPreference: () => {},
    logWrite: () => {},
  });
  capabilities.setBackendPreference(backendArg);

  const probes = [];
  if (backendArg !== 'cpu') {
    probes.push(capabilities._detectGpu());
  }
  if (diarize) {
    probes.push(capabilities._detectDtw().then((s) => { capabilities._dtwSupported = s; }));
    probes.push(capabilities.getPythonInfo());
  } else {
    // DTW is only consulted when diarization is on; mark as supported
    // to avoid an unneeded probe.
    capabilities._dtwSupported = true;
  }
  await Promise.allSettled(probes);

  if (diarize) {
    const pyInfo = await capabilities.getPythonInfo();
    if (!pyInfo.pythonFound) {
      die('transcribe: --diarize requires Python 3.9+ on PATH');
    }
    if (!pyInfo.pyannoteInstalled) {
      die('transcribe: --diarize requires pyannote.audio (run: pip install pyannote.audio torch)');
    }
  }

  const runner = createTranscriptionRunner({
    capabilities,
    paths,
    spawn,
    log: () => {},
  });

  const abortController = new AbortController();
  let sigintReceived = false;
  const handleSigint = () => {
    if (sigintReceived) return;
    sigintReceived = true;
    if (!quiet) process.stderr.write('\nReceived SIGINT, cancelling...\n');
    abortController.abort();
  };
  process.on('SIGINT', handleSigint);

  const stderrLine = (s) => { if (!quiet) process.stderr.write(s + '\n'); };

  let commandError = null;
  try {
    const result = await runner.runTranscription({
      filePath,
      modelId,
      options: {
        diarization: diarize,
        antiCorruption: reduceRepeatedText,
        reduceRepeatedText,
        jobMode: optionValidation.effective.jobMode,
        sourceLanguage: optionValidation.effective.sourceLanguage,
        targetLanguage: optionValidation.effective.targetLanguage,
        hfToken,
        numSpeakers,
        outputJson: format === 'json',
      },
      signal: abortController.signal,
      onProgress: stderrLine,
      onDiarizeProgress: (data) => {
        if (quiet) return;
        if (data.error) process.stderr.write(`diarize error: ${data.error}\n`);
        else if (data.message) {
          const pct = data.percent != null ? ` (${data.percent}%)` : '';
          process.stderr.write(`${data.message}${pct}\n`);
        }
      },
    });

    let output;
    if (format === 'json') {
      const payload = result.result != null ? result.result : { text: result.text };
      const compactPayload = Object.fromEntries(Object.entries(payload)
        .filter(([, value]) => value != null && (!Array.isArray(value) || value.length > 0)));
      output = JSON.stringify(compactPayload, null, 2);
    } else {
      output = result.text;
    }

    if (outputPath) {
      fs.writeFileSync(outputPath, output);
    } else {
      process.stdout.write(output);
      if (!output.endsWith('\n')) process.stdout.write('\n');
    }
  } catch (err) {
    commandError = err;
  } finally {
    process.removeListener('SIGINT', handleSigint);
    await runner.shutdown();
  }

  if (commandError) {
    if (sigintReceived || commandError.message === 'Cancelled') process.exit(130);
    die(`transcribe failed: ${commandError.message}`);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: download-model
// ---------------------------------------------------------------------------

const DOWNLOAD_SPEC = {
  '--hf-token': { takesValue: true },
  '--quiet': { takesValue: false },
  '--help': { takesValue: false },
  '-h': { takesValue: false },
};

async function cmdDownloadModel(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv, DOWNLOAD_SPEC);
  } catch (err) {
    die(`${err.message}\n\n${DOWNLOAD_HELP}`);
  }
  const { positional, flags } = parsed;
  if (flags['--help'] || flags['-h']) {
    process.stdout.write(DOWNLOAD_HELP);
    process.exit(0);
  }
  if (positional.length === 0) {
    die(`download-model: missing <id> argument\n\n${DOWNLOAD_HELP}`);
  }
  if (positional.length > 1) {
    die(`download-model: expected exactly one <id>; got ${positional.length}\n${DOWNLOAD_HELP}`);
  }

  const id = positional[0];
  const quiet = !!flags['--quiet'];
  const hfToken = flags['--hf-token'] || process.env.HF_TOKEN;

  let destPath;
  let existingPath;
  let modelSpec;
  try {
    modelSpec = models.getModel(id);
    existingPath = models.getModelPath(id);
    destPath = models.getModelDownloadPath(id);
  } catch (err) {
    die(`download-model: ${err.message}`);
  }

  if (modelSpec.runtimeAvailable === false) {
    die(`download-model: ${modelSpec.displayName} is deferred until a compatible ${modelSpec.engine} release is available.`);
  }

  if (modelSpec.gated && !hfToken) {
    die(`download-model: ${modelSpec.displayName} requires --hf-token <token> or $HF_TOKEN. Request access at ${modelSpec.accessUrl}.`);
  }

  if (fs.existsSync(existingPath)) {
    if (!quiet) process.stderr.write(`model ${id} already downloaded\n`);
    process.exit(0);
  }

  let lastPercent = -1;
  try {
    await models.downloadModel(id, destPath, (data) => {
      if (quiet) return;
      if (data.percent !== lastPercent) {
        lastPercent = data.percent;
        process.stderr.write(`\rdownloading ${id}: ${data.percent}%`);
      }
    }, { hfToken });
    if (!quiet) process.stderr.write('\n');
  } catch (err) {
    if (!quiet) process.stderr.write('\n');
    die(`download-model: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: list-models
// ---------------------------------------------------------------------------

const LIST_SPEC = {
  '--json': { takesValue: false },
  '--help': { takesValue: false },
  '-h': { takesValue: false },
};

function cmdListModels(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv, LIST_SPEC);
  } catch (err) {
    die(`${err.message}\n\n${LIST_HELP}`);
  }
  const { flags } = parsed;
  if (flags['--help'] || flags['-h']) {
    process.stdout.write(LIST_HELP);
    process.exit(0);
  }

  const downloaded = new Map(models.listModels().map((model) => [model.id, model.downloaded]));
  const all = models.listPresentationModels().map((model) => ({
    id: model.id,
    label: model.displayName,
    task: model.task,
    status: model.status,
    availability: model.availability || (model.runtimeAvailable === false ? 'deferred' : 'available'),
    languages: model.languages,
    size: model.size,
    licence: model.licence,
    capabilities: {
      jobModes: model.translationPairs.length > 0 ? ['transcribe', 'translate'] : ['transcribe'],
      languageSelection: model.languageSelection,
      timestamps: model.timestampLevel,
      speakerLabels: model.builtInSpeakers ? 'built-in' : model.pyannoteValidated ? 'pyannote' : 'unavailable',
      expectedSpeakers: model.pyannoteValidated,
      reduceRepeatedText: model.repetitionControl,
      runtimeAvailable: model.runtimeAvailable,
    },
    gated: model.gated,
    downloaded: downloaded.get(model.id) || false,
  }));
  if (flags['--json']) {
    process.stdout.write(JSON.stringify(all, null, 2) + '\n');
    return;
  }

  const headers = ['ID', 'Label', 'Task', 'Status', 'Languages', 'Size', 'Licence', 'Capabilities', 'Downloaded'];
  const rows = all.map((m) => {
    const capabilities = [
      ...m.capabilities.jobModes,
      `${m.capabilities.timestamps}-timestamps`,
      m.capabilities.speakerLabels,
      m.capabilities.expectedSpeakers ? 'expected-speakers' : null,
      m.capabilities.reduceRepeatedText ? 'reduce-repeated-text' : null,
      m.capabilities.runtimeAvailable ? null : 'unavailable',
    ].filter(Boolean).join(',');
    return [m.id, m.label, m.task, m.status, m.languages.join(','), m.size, m.licence, capabilities, m.downloaded ? 'yes' : 'no'];
  });
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  process.stdout.write(fmt(headers) + '\n');
  process.stdout.write(widths.map((w) => '-'.repeat(w)).join('  ') + '\n');
  for (const row of rows) process.stdout.write(fmt(row) + '\n');
}

// ---------------------------------------------------------------------------
// Subcommand: gpu-status
// ---------------------------------------------------------------------------

const GPU_SPEC = {
  '--json': { takesValue: false },
  '--help': { takesValue: false },
  '-h': { takesValue: false },
};

async function cmdGpuStatus(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv, GPU_SPEC);
  } catch (err) {
    die(`${err.message}\n\n${GPU_HELP}`);
  }
  const { flags } = parsed;
  if (flags['--help'] || flags['-h']) {
    process.stdout.write(GPU_HELP);
    process.exit(0);
  }

  const capabilities = new Capabilities({ logWrite: () => {} });
  await capabilities._detectGpu();
  const dtwSupported = await capabilities._detectDtw();
  capabilities._dtwSupported = dtwSupported;
  const status = capabilities.getStatus();
  status.dtwSupported = dtwSupported;

  if (flags['--json']) {
    process.stdout.write(JSON.stringify(status, null, 2) + '\n');
    return;
  }

  process.stdout.write(`Backend (active):    ${status.backend}\n`);
  process.stdout.write(`Backend (setting):   ${status.setting}\n`);
  process.stdout.write(`Detected:            ${status.detected || 'none'}\n`);
  process.stdout.write(`Device:              ${status.deviceName || 'n/a'}\n`);
  process.stdout.write(`Available backends:  ${status.available.join(', ')}\n`);
  process.stdout.write(`DTW supported:       ${dtwSupported ? 'yes' : 'no'}\n`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(TOP_HELP);
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case 'transcribe':
      await cmdTranscribe(rest);
      break;
    case 'download-model':
      await cmdDownloadModel(rest);
      break;
    case 'list-models':
      cmdListModels(rest);
      break;
    case 'gpu-status':
      await cmdGpuStatus(rest);
      break;
    default:
      die(`Unknown subcommand: ${sub}\n\n${TOP_HELP}`);
  }
}

main().catch((err) => {
  die(err.stack || err.message);
});
