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

const models = require('./lib/models');
const Capabilities = require('./lib/capabilities');
const { createTranscriptionRunner } = require('./lib/transcription-runner');

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
  --diarize               enable pyannote speaker diarization
  --anti-corruption       enable anti-corruption sampling flags
  --hf-token <token>      Hugging Face token (or set HF_TOKEN env var)
  --num-speakers <n>      hint diarizer to expect this many speakers
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
  const quiet = !!flags['--quiet'];
  const outputPath = flags['--output'];

  let hfToken;
  if (diarize) {
    hfToken = flags['--hf-token'] || process.env.HF_TOKEN;
    if (!hfToken) {
      die('transcribe: --diarize requires --hf-token <token> or $HF_TOKEN');
    }
  }

  let numSpeakers;
  if (flags['--num-speakers'] != null) {
    numSpeakers = parseInt(flags['--num-speakers'], 10);
    if (!Number.isFinite(numSpeakers) || numSpeakers < 1) {
      die(`transcribe: --num-speakers must be a positive integer (got "${flags['--num-speakers']}")`);
    }
  }

  // Validate model id early so unknown ids fail before any subprocess
  try {
    models.getModel(modelId);
  } catch (err) {
    die(`transcribe: ${err.message}`);
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
  process.on('SIGINT', () => {
    if (sigintReceived) return;
    sigintReceived = true;
    if (!quiet) process.stderr.write('\nReceived SIGINT, cancelling...\n');
    abortController.abort();
  });

  const stderrLine = (s) => { if (!quiet) process.stderr.write(s + '\n'); };

  try {
    const result = await runner.runTranscription({
      filePath,
      modelId,
      options: {
        diarization: diarize,
        antiCorruption: !!flags['--anti-corruption'],
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
      process.exit(130);
    }
    die(`transcribe failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: download-model
// ---------------------------------------------------------------------------

const DOWNLOAD_SPEC = {
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

  let destPath;
  try {
    destPath = models.getModelPath(id);
  } catch (err) {
    die(`download-model: ${err.message}`);
  }

  if (fs.existsSync(destPath)) {
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
    });
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

  const all = models.listModels();
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
