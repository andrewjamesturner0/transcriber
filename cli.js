#!/usr/bin/env node
// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

/**
 * Command-line interface for Transcriber.
 *
 * Runs the same FFmpeg -> whisper-cli -> (optional pyannote) pipeline as the
 * Electron GUI, without launching any window subsystem. Reuses the lib/
 * factories unchanged. Never requires('electron'); never reads or writes the
 * GUI's settings.json.
 *
 * Subcommands:
 *   transcribe <file>     run the full pipeline on one input file
 *   download-model <id>   fetch a model from Hugging Face into models/
 *   list-models           print the canonical model list
 *   gpu-status            print detected backend and DTW support
 *
 * See docs/cli.md for the full reference.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const paths = require('./lib/paths');
paths.initPaths({ isPackaged: false, resourcesPath: __dirname });

const { createModelStore } = require('./lib/model-store');
const { createModelDownloader } = require('./lib/model-download');
const modelStore = createModelStore({
  bundledDir: paths.getResourcePath('models'),
  writableDir: paths.getResourcePath('models'),
  install: createModelDownloader(),
});
const Capabilities = require('./lib/capabilities');
const { createTranscriptionRunner } = require('./lib/transcription-runner');
const { isEnglishOnlyModel } = require('./lib/transcript-timing');

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const TOP_HELP = `Usage: node cli.js <subcommand> [options]

Subcommands:
  transcribe <file>        run the full pipeline on one input file
  download-model <id>      fetch a model from Hugging Face into models/
  list-models              print the canonical model list
  gpu-status               print detected backend and DTW support

Run "node cli.js <subcommand> --help" for subcommand-specific options.
`;

const TRANSCRIBE_HELP = `Usage: node cli.js transcribe <file> [options]

Run the full transcription pipeline on one audio or video file.

Options:
  --model <id>            model id (default: tiny.en); see "list-models"
  --backend auto|cpu|vulkan
                          whisper backend (default: auto)
  --format txt|json       output format (default: txt)
  --output <path>         write output to file instead of stdout
  --diarize               label speakers: pyannote diarization plus word
                          alignment, as in the app. Needs the setup in
                          docs/diarization-setup.md
  --anti-corruption       enable anti-corruption sampling flags
  --hf-token <token>      ignored (kept for old scripts); the speaker model is
                          prepared once with scripts/setup-diarization.py
  --num-speakers <n>      hint diarizer to expect this many speakers
  --alignment forced|whisper
                          evaluation only: word timing for speaker assignment
                          (default with --diarize: forced, i.e. word
                          alignment). "whisper" skips alignment and uses
                          Whisper's own word timing
  --dtw                   evaluation only: experimental DTW timing; needs
                          --diarize and --alignment whisper; disables flash
                          attention
  --quiet                 suppress progress output on stderr
  -h, --help              show this help and exit
`;

const DOWNLOAD_HELP = `Usage: node cli.js download-model <id> [options]

Fetch a whisper model from Hugging Face into models/. If the model is already
on disk this is a no-op.

Options:
  --quiet     suppress progress output on stderr
  -h, --help  show this help and exit
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

// Parse all flags before honouring help, preserving unknown-flag errors.
const HELP_FLAGS = { '--help': { takesValue: false }, '-h': { takesValue: false } };
function parseCommand(argv, spec, help) {
  let parsed;
  try { parsed = parseArgs(argv, spec); }
  catch (error) { die(error.message + '\n\n' + help); }
  if (parsed.flags['--help'] || parsed.flags['-h']) {
    process.stdout.write(help);
    process.exit(0);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Subcommand: transcribe
// ---------------------------------------------------------------------------

const TRANSCRIBE_SPEC = {
  '--model': { takesValue: true },
  '--backend': { takesValue: true },
  '--format': { takesValue: true },
  '--output': { takesValue: true },
  '--diarize': { takesValue: false },
  '--anti-corruption': { takesValue: false },
  '--hf-token': { takesValue: true },
  '--num-speakers': { takesValue: true },
  '--alignment': { takesValue: true },
  '--dtw': { takesValue: false },
  '--quiet': { takesValue: false },
  ...HELP_FLAGS,
};

/** Plain-language fix for a diarisation setup status (design decision D2). */
function _diarizeFix(info) {
  switch (info.diarizationStatus) {
    case 'python-missing':
      return 'Install Python 3.10 or later, or set TRANSCRIBER_PYTHON to its path.';
    case 'python-unsupported':
      return `Python ${info.pythonVersion} is too old; install Python 3.10 or later.`;
    case 'pyannote-missing':
    case 'pyannote-unsupported':
      return 'Install the supported packages: pip install -r lib/requirements.txt';
    case 'model-not-prepared':
      return 'Download the speaker model once: HF_TOKEN=<token> python scripts/setup-diarization.py';
    default:
      return info.diarizationMessage || 'Run: python scripts/setup-diarization.py --check';
  }
}

/** Plain-language fix for an alignment setup status (design decisions D3, D4). */
function _alignmentFix(info) {
  switch (info.alignmentStatus) {
    case 'alignment-missing':
    case 'alignment-unsupported':
      return 'Install the speaker labelling packages: pip install -r lib/requirements.txt';
    case 'model-not-prepared':
      return 'Download the word alignment model once: python scripts/setup-diarization.py --alignment';
    default:
      return info.alignmentMessage || 'Run: python lib/align.py --check';
  }
}

async function cmdTranscribe(argv) {
  const { positional, flags } = parseCommand(argv, TRANSCRIBE_SPEC, TRANSCRIBE_HELP);
  if (positional.length === 0) die('transcribe: missing <file> argument\n\n' + TRANSCRIBE_HELP);
  if (positional.length > 1) die('transcribe: only one input file is supported per invocation; got ' + positional.length + '\n' + TRANSCRIBE_HELP);

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
  // Speaker labelling always includes word alignment, as in the app;
  // --alignment whisper exists only to compare timing sources.
  const alignmentFlag = flags['--alignment'];
  if (alignmentFlag != null && !['whisper', 'forced'].includes(alignmentFlag)) {
    die(`transcribe: --alignment must be forced or whisper (got "${alignmentFlag}")`);
  }
  if (alignmentFlag && !diarize) {
    die(`transcribe: --alignment ${alignmentFlag} needs --diarize`);
  }
  const alignment = alignmentFlag || (diarize ? 'forced' : 'whisper');
  const dtw = !!flags['--dtw'];
  if (dtw && (!diarize || alignment === 'forced')) {
    die('transcribe: --dtw needs --diarize and --alignment whisper');
  }
  const quiet = !!flags['--quiet'];
  const outputPath = flags['--output'];

  let numSpeakers;
  if (flags['--num-speakers'] != null) {
    numSpeakers = parseInt(flags['--num-speakers'], 10);
    if (!Number.isFinite(numSpeakers) || numSpeakers < 1) {
      die(`transcribe: --num-speakers must be a positive integer (got "${flags['--num-speakers']}")`);
    }
  }

  // Validate model id early so unknown ids fail before any subprocess
  try {
    modelStore.getModel(modelId);
  } catch (err) {
    die(`transcribe: ${err.message}`);
  }

  // Build capabilities with lazy detection appropriate for the flags
  const capabilities = new Capabilities({
    getPreference: () => undefined,
    setPreference: () => {},
    logWrite: () => {},
  });
  const abortController = new AbortController();
  let sigintReceived = false;
  const onInterrupt = () => {
    if (sigintReceived) return;
    sigintReceived = true;
    if (!quiet) process.stderr.write('\nReceived SIGINT, cancelling...\n');
    abortController.abort();
    capabilities.dispose();
  };
  process.on('SIGINT', onInterrupt);

  try {
    capabilities.setBackendPreference(backendArg);

    const probes = [];
    if (backendArg !== 'cpu') {
      probes.push(capabilities.detectGpu());
    }
    if (diarize) {
      // Probes the CPU binary and, if present, the Vulkan binary.
      probes.push(capabilities.detectDtw());
      probes.push(capabilities.getPythonInfo());
    }
    // Without diarization DTW is never consulted, so no probe is needed.
    await Promise.allSettled(probes);
    if (abortController.signal.aborted) throw new Error('Cancelled');

    if (diarize) {
      const pyInfo = await capabilities.getPythonInfo();
      if (abortController.signal.aborted) throw new Error('Cancelled');
      if (pyInfo.diarizationStatus !== 'ready') {
        throw new Error(`transcribe: --diarize is not ready (${pyInfo.diarizationStatus}). ${_diarizeFix(pyInfo)}`);
      }
      if (alignment === 'forced') {
        // English-only models are checked fully. For other models the language
        // is only known after Whisper runs, so only the packages are checked
        // here; a missing language model falls back to Whisper timing.
        const englishOnly = isEnglishOnlyModel(modelId);
        const alignInfo = await capabilities.getAlignmentInfo({ language: 'en' });
        if (abortController.signal.aborted) throw new Error('Cancelled');
        const okStatuses = englishOnly ? ['ready'] : ['ready', 'model-not-prepared'];
        if (!okStatuses.includes(alignInfo.alignmentStatus)) {
          throw new Error(`transcribe: --diarize needs word alignment, which is not ready (${alignInfo.alignmentStatus}). ${_alignmentFix(alignInfo)}`);
        }
      }
    }

    const runner = createTranscriptionRunner({
      capabilities,
      modelStore,
      paths,
      spawn,
      log: () => {},
    });

    const stderrLine = (s) => { if (!quiet) process.stderr.write(s + '\n'); };

    const result = await runner.runTranscription({
      filePath,
      modelId,
      options: {
        diarization: diarize,
        antiCorruption: !!flags['--anti-corruption'],
        numSpeakers,
        alignment,
        dtw,
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
      const payload = result.json != null ? result.json : { text: result.text };
      output = JSON.stringify(payload, null, 2);
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
    if (sigintReceived || err.message === 'Cancelled') {
      process.exitCode = 130;
      return;
    }
    process.stderr.write((err.message.startsWith('transcribe:') ? err.message : 'transcribe failed: ' + err.message) + '\n');
    process.exitCode = 1;
  } finally {
    try { await capabilities.dispose(); }
    finally { process.removeListener('SIGINT', onInterrupt); }
  }
}

// ---------------------------------------------------------------------------
// Subcommand: download-model
// ---------------------------------------------------------------------------

const DOWNLOAD_SPEC = {
  '--quiet': { takesValue: false },
  ...HELP_FLAGS,
};

async function cmdDownloadModel(argv) {
  const { positional, flags } = parseCommand(argv, DOWNLOAD_SPEC, DOWNLOAD_HELP);
  if (positional.length === 0) die('download-model: missing <id> argument\n\n' + DOWNLOAD_HELP);
  if (positional.length > 1) die('download-model: expected exactly one <id>; got ' + positional.length + '\n' + DOWNLOAD_HELP);

  const id = positional[0];
  const quiet = !!flags['--quiet'];

  try { modelStore.getModel(id); }
  catch (error) { die('download-model: ' + error.message); }
  if (modelStore.listModels().find((model) => model.id === id).downloaded) {
    if (!quiet) process.stderr.write('model ' + id + ' already downloaded\n');
    return;
  }
  const abort = new AbortController();
  const onInterrupt = () => abort.abort();
  process.on('SIGINT', onInterrupt);

  let lastPercent = -1;
  try {
    await modelStore.downloadModel(id, { signal: abort.signal, onProgress: (data) => {
      if (quiet) return;
      if (data.percent !== lastPercent) {
        lastPercent = data.percent;
        process.stderr.write(`\rdownloading ${id}: ${data.percent}%`);
      }
    } });
    if (!quiet) process.stderr.write('\n');
  } catch (err) {
    if (!quiet) process.stderr.write('\n');
    if (abort.signal.aborted) process.exit(130);
    die(`download-model: ${err.message}`);
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: list-models
// ---------------------------------------------------------------------------

const LIST_SPEC = {
  '--json': { takesValue: false },
  ...HELP_FLAGS,
};

function cmdListModels(argv) {
  const { flags } = parseCommand(argv, LIST_SPEC, LIST_HELP);

  const all = modelStore.listModels();
  if (flags['--json']) {
    process.stdout.write(JSON.stringify(all, null, 2) + '\n');
    return;
  }

  const headers = ['ID', 'Label', 'Size', 'Downloaded'];
  const rows = all.map((m) => [m.id, m.label, m.size, m.downloaded ? 'yes' : 'no']);
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
  ...HELP_FLAGS,
};

async function cmdGpuStatus(argv) {
  const { flags } = parseCommand(argv, GPU_SPEC, GPU_HELP);

  const capabilities = new Capabilities({ logWrite: () => {} });
  let interrupted = false;
  const onInterrupt = () => { interrupted = true; capabilities.dispose(); };
  process.on('SIGINT', onInterrupt);
  try {
    await capabilities.detectGpu();
    if (interrupted) throw new Error('Cancelled');
    await capabilities.detectDtw();
    if (interrupted) throw new Error('Cancelled');
    // dtwSupported is for the active backend; dtwSupport is per backend.
    const status = capabilities.getStatus();
    const dtwSupported = status.dtwSupported;

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
    const perBackend = status.available
      .map((b) => `${b}=${status.dtwSupport[b] == null ? 'unknown' : (status.dtwSupport[b] ? 'yes' : 'no')}`)
      .join(', ');
    process.stdout.write(`DTW per backend:     ${perBackend}\n`);
  } catch (error) {
    if (interrupted) process.exitCode = 130;
    else throw error;
  } finally {
    try { await capabilities.dispose(); }
    finally { process.removeListener('SIGINT', onInterrupt); }
  }
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
