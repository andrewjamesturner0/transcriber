// Transcriber — local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { autoUpdater } = require('electron-updater');
const paths = require('./lib/paths');
const Capabilities = require('./lib/capabilities');

// Initialize path resolver at module load time so it's available for
// all requires and function calls that follow.
paths.initPaths({
  isPackaged: app.isPackaged,
  resourcesPath: app.isPackaged ? process.resourcesPath : __dirname,
});

// --- Constants ---
const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'webm', 'wma', 'aac'];
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', '3gp'];
const MEDIA_EXTENSIONS = [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS];
const MAX_THREADS = Math.max(1, Math.min(os.cpus().length - 1, 8));
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB

const MODELS = [
  { id: 'tiny.en',    fileName: 'ggml-tiny.en.bin',    label: 'Tiny (English)',       size: '75 MB' },
  { id: 'tiny',       fileName: 'ggml-tiny.bin',       label: 'Tiny (Multilingual)',  size: '75 MB' },
  { id: 'base.en',    fileName: 'ggml-base.en.bin',    label: 'Base (English)',       size: '142 MB' },
  { id: 'base',       fileName: 'ggml-base.bin',       label: 'Base (Multilingual)',  size: '142 MB' },
  { id: 'small.en',   fileName: 'ggml-small.en.bin',   label: 'Small (English)',      size: '466 MB' },
  { id: 'small',      fileName: 'ggml-small.bin',      label: 'Small (Multilingual)', size: '466 MB' },
  { id: 'small.en-tdrz', fileName: 'ggml-small.en-tdrz.bin', label: 'Small (English) + Speaker ID', size: '488 MB', tdrz: true, hfRepo: 'akashmjn/tinydiarize-whisper.cpp' },
  { id: 'medium.en',  fileName: 'ggml-medium.en.bin',  label: 'Medium (English)',     size: '1.5 GB' },
  { id: 'medium',     fileName: 'ggml-medium.bin',     label: 'Medium (Multilingual)',size: '1.5 GB' },
  { id: 'large-v3',   fileName: 'ggml-large-v3.bin',   label: 'Large v3 (Multilingual)', size: '3.1 GB' },
  { id: 'large-v3-turbo',      fileName: 'ggml-large-v3-turbo.bin',      label: 'Large v3 Turbo (Multilingual)', size: '1.6 GB' },
  { id: 'large-v3-turbo-q5_0', fileName: 'ggml-large-v3-turbo-q5_0.bin', label: 'Large v3 Turbo Q5 (Multilingual)', size: '574 MB' },
  { id: 'large-v3-q5_0',       fileName: 'ggml-large-v3-q5_0.bin',       label: 'Large v3 Q5 (Multilingual)', size: '1.1 GB' },
];

const DTW_PRESETS = {
  'tiny':                 'tiny',
  'tiny.en':              'tiny.en',
  'base':                 'base',
  'base.en':              'base.en',
  'small':                'small',
  'small.en':             'small.en',
  'medium':               'medium',
  'medium.en':            'medium.en',
  'large-v3':             'large.v3',
  'large-v3-turbo':       'large.v3.turbo',
  'large-v3-turbo-q5_0':  'large.v3.turbo',
  'large-v3-q5_0':        'large.v3',
};

const settingsFile = path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try {
    if (fs.existsSync(settingsFile)) return JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
  } catch (_) {}
  return {};
}

function writeSettings(data) {
  try {
    const existing = readSettings();
    fs.writeFileSync(settingsFile, JSON.stringify({ ...existing, ...data }, null, 2));
  } catch (_) {}
}

function getModelsDir() {
  return paths.getResourcePath('models');
}

function getModelPath(modelId) {
  const model = MODELS.find((m) => m.id === modelId);
  if (!model) throw new Error(`Unknown model: ${modelId}`);
  return path.join(getModelsDir(), model.fileName);
}

let mainWindow;
let transcriptionAbort = null;
let capabilities;

// --- Debug logging ---
const logDir = path.join(app.getPath('userData'), 'logs');
const logFile = path.join(logDir, 'transcriber.log');

function logWrite(message) {
  try {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
  } catch (_) { /* ignore logging errors */ }
}

function logRotate() {
  try {
    if (!fs.existsSync(logFile)) return;
    const stats = fs.statSync(logFile);
    if (stats.size > MAX_LOG_SIZE) {
      const old = logFile + '.old';
      if (fs.existsSync(old)) fs.unlinkSync(old);
      fs.renameSync(logFile, old);
    }
  } catch (_) { /* ignore */ }
}

logRotate();
logWrite('=== Application started ===');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 700,
    height: 800,
    resizable: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(async () => {
  // Create capabilities module with injected settings callbacks
  capabilities = new Capabilities({
    getPreference: (key) => readSettings()[key],
    setPreference: (key, value) => writeSettings({ [key]: value }),
    logWrite,
  });

  // Eagerly probe all capabilities (non-blocking for window creation)
  capabilities.detect();

  createWindow();

  // Auto-update setup
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => {
      logWrite('[UPDATE] Checking for updates...');
    });

    autoUpdater.on('update-available', (info) => {
      logWrite(`[UPDATE] Update available: v${info.version}`);
      // Only notify if remote version is actually newer
      const r = info.version.split('.').map(Number);
      const c = app.getVersion().split('.').map(Number);
      const isNewer = r[0] > c[0] || (r[0] === c[0] && r[1] > c[1]) || (r[0] === c[0] && r[1] === c[1] && r[2] > c[2]);
      if (isNewer) {
        mainWindow.webContents.send('update-available', { version: info.version });
      } else {
        autoUpdater.autoDownload = false;
      }
    });

    autoUpdater.on('update-not-available', () => {
      logWrite('[UPDATE] No update available (already latest)');
    });

    autoUpdater.on('update-downloaded', (info) => {
      logWrite(`[UPDATE] Update downloaded: v${info.version}`);
      mainWindow.webContents.send('update-downloaded');
    });

    autoUpdater.on('error', (err) => {
      logWrite(`[UPDATE] Error: ${err.message}`);
    });

    autoUpdater.checkForUpdates();
  } catch (err) {
    logWrite(`[UPDATE] Failed to initialize: ${err.message}`);
  }
});
app.on('window-all-closed', () => app.quit());

// --- IPC Handlers ---

ipcMain.handle('select-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Audio or Video Files',
    filters: [
      { name: 'Media Files', extensions: MEDIA_EXTENSIONS },
    ],
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled) return [];
  return result.filePaths;
});

ipcMain.handle('get-models', async () => {
  const dir = getModelsDir();
  return MODELS.map((m) => ({
    ...m,
    downloaded: fs.existsSync(path.join(dir, m.fileName)),
  }));
});

ipcMain.handle('download-model', async (event, modelId) => {
  const model = MODELS.find((m) => m.id === modelId);
  if (!model) throw new Error(`Unknown model: ${modelId}`);

  const dest = path.join(getModelsDir(), model.fileName);
  if (fs.existsSync(dest)) return true;

  fs.mkdirSync(getModelsDir(), { recursive: true });
  const baseUrl = model.hfRepo
    ? `https://huggingface.co/${model.hfRepo}/resolve/main`
    : HF_BASE;
  const url = `${baseUrl}/${model.fileName}`;
  const tmpDest = dest + '.download';

  await new Promise((resolve, reject) => {
    const download = (downloadUrl) => {
      https.get(downloadUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return download(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }
        const total = parseInt(res.headers['content-length'], 10) || 0;
        let received = 0;
        const file = fs.createWriteStream(tmpDest);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total > 0) {
            event.sender.send('download-progress', {
              modelId,
              percent: Math.round((received / total) * 100),
              received,
              total,
            });
          }
        });
        res.pipe(file);
        file.on('finish', () => { file.close(resolve); });
        file.on('error', (err) => { fs.unlinkSync(tmpDest); reject(err); });
      }).on('error', reject);
    };
    download(url);
  });

  fs.renameSync(tmpDest, dest);
  return true;
});

async function runWhisperWithFallbacks(whisperBin, args, signal, backend, logWrite, event) {
  try {
    const output = await runProcess(whisperBin, args, { signal });
    return { output, backend };
  } catch (err) {
    if (err.message !== 'Cancelled' && /unknown DTW preset|unrecognized .*--dtw|DTW .* not (?:built|enabled|supported)|whisper_full.*dtw/i.test(err.message)) {
      // --dtw not supported by this build (or flag not recognised); retry without it
      logWrite(`[DTW] DTW not supported (${err.message.trim()}), retrying without --dtw`);
      capabilities.disableDtw();
      const dtw = args.indexOf('--dtw');
      const argsNoDtw = dtw >= 0 ? args.filter((_, i) => i !== dtw && i !== dtw + 1) : args;
      try {
        const output = await runProcess(whisperBin, argsNoDtw, { signal });
        return { output, backend };
      } catch (retryErr) {
        logWrite(`[DTW] Retry without --dtw also failed: ${retryErr.message}`);
        throw err;
      }
    } else if (backend === 'vulkan' && err.message !== 'Cancelled') {
      logWrite(`[GPU] Vulkan transcription failed (${err.message}), falling back to CPU`);
      const isOOM = /OutOfDeviceMemory|failed to allocate/i.test(err.message);
      if (!isOOM) capabilities.disableGpu(); // OOM is model-specific, don't disable GPU for future runs
      const cpuWhisper = paths.getWhisperBinary('cpu');
      const fallbackMsg = isOOM
        ? 'Model too large for GPU memory — retrying with CPU...'
        : 'GPU unavailable — retrying with CPU...';
      event.sender.send('transcribe-status', fallbackMsg);
      try {
        const output = await runProcess(cpuWhisper, args, { signal });
        return { output, backend: 'cpu' };
      } catch (retryErr) {
        logWrite(`[GPU] CPU fallback also failed: ${retryErr.message}`);
        throw err;
      }
    } else {
      throw err;
    }
  }
}

ipcMain.handle('transcribe', async (event, filePath, modelId, options) => {
  let backend = capabilities.getActiveBackend();
  logWrite(`=== Transcription started: model=${modelId}, backend=${backend}, diarization=${!!(options && options.diarization)}, file=${filePath} ===`);
  const ffmpeg = paths.getFfmpegBinary();
  let whisper = paths.getWhisperBinary(backend);
  const modelConfig = MODELS.find((m) => m.id === (modelId || 'tiny.en'));
  const modelPath = getModelPath(modelId || 'tiny.en');
  const diarization = options && options.diarization;

  // Validate binaries exist (fall back to CPU if chosen backend missing)
  if (!fs.existsSync(whisper) && backend === 'vulkan') {
    logWrite(`[GPU] Vulkan binary not found, falling back to CPU`);
    backend = 'cpu';
    whisper = paths.getWhisperBinary('cpu');
  }
  for (const [name, p] of [['whisper-cli', whisper], ['ffmpeg', ffmpeg], ['model', modelPath]]) {
    if (!fs.existsSync(p)) {
      throw new Error(`${name} not found at ${p}. Run "npm run setup" first.`);
    }
  }

  const abort = new AbortController();
  transcriptionAbort = abort;

  const tmpWav = path.join(os.tmpdir(), `whisper_input_${Date.now()}.wav`);
  const whisperJsonPrefix = path.join(os.tmpdir(), `whisper_out_${Date.now()}`);

  try {
    // Step 1: Convert to 16kHz mono WAV
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const isVideo = VIDEO_EXTENSIONS.includes(ext);
    event.sender.send('transcribe-status', isVideo ? 'Extracting audio...' : 'Converting audio...');
    await runProcess(ffmpeg, ['-i', filePath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', tmpWav], { signal: abort.signal });

    // Step 2: Run whisper
    const backendLabel = backend === 'vulkan' ? 'Transcribing with GPU...' : 'Transcribing (CPU)...';
    event.sender.send('transcribe-status', backendLabel);
    const threads = MAX_THREADS;
    const args = [
      '-m', modelPath,
      '-f', tmpWav,
      '-t', String(threads),
    ];

    // TinyDiarize models require timestamps and the --tinydiarize flag
    if (modelConfig && modelConfig.tdrz) {
      args.push('--tinydiarize');
    } else if (diarization) {
      // Diarization needs timestamped JSON output for alignment
      args.push('--output-json-full', '-of', whisperJsonPrefix);
      if (capabilities.isDtwSupported()) {
        const dtwPreset = DTW_PRESETS[modelId];
        if (dtwPreset) args.push('--dtw', dtwPreset);
      }
    } else {
      args.push('--no-timestamps');
    }

    // Anti-corruption: disable context window + adjusted sampling to prevent hallucination loops
    if (options && options.antiCorruption) {
      args.push('-mc', '0', '--temperature', '0.4', '--entropy-thold', '1.8');
    }

    const result = await runWhisperWithFallbacks(whisper, args, abort.signal, backend, logWrite, event);
    const output = result.output;
    if (result.backend !== backend) {
      backend = result.backend;
      whisper = paths.getWhisperBinary(backend);
    }

    // Step 3: If diarization enabled, run pyannote and merge
    if (diarization && !modelConfig?.tdrz) {
      try {
        // Parse whisper JSON for timestamped segments
        const whisperJsonPath = whisperJsonPrefix + '.json';
        const whisperJson = JSON.parse(fs.readFileSync(whisperJsonPath, 'utf-8'));

        // Run diarization
        event.sender.send('transcribe-status', 'Identifying speakers...');
        const diarizeSegments = await runDiarization(event, tmpWav, options, abort.signal);

        // Merge and return speaker-labeled transcript
        return mergeTranscriptWithDiarization(whisperJson, diarizeSegments);
      } catch (err) {
        // Fall back to plain whisper output if diarization fails
        logWrite(`[DIARIZE-FAIL] ${err.message}\n${err.stack || ''}`);
        const fallbackMsg = err.message === 'Cancelled' ? 'Cancelled' : err.message;
        if (err.message === 'Cancelled') throw err;
        event.sender.send('transcribe-status', `Diarization failed (${fallbackMsg}), using plain transcript`);
        return output.trim();
      }
    }

    return output.trim();
  } finally {
    transcriptionAbort = null;
    try { fs.unlinkSync(tmpWav); } catch (_) {}
    try { fs.unlinkSync(whisperJsonPrefix + '.json'); } catch (_) {}
  }
});

/**
 * Run pyannote diarization on a WAV file. Used internally by the transcribe handler.
 */
async function runDiarization(event, wavPath, options, signal) {
  const { hfToken, numSpeakers } = options;

  const pythonCmd = await capabilities.getPythonCommand();
  if (!pythonCmd) throw new Error('Python not found');

  const scriptPath = paths.getResourcePath(path.join('lib', 'diarize.py'));
  if (!fs.existsSync(scriptPath)) throw new Error('Diarization script not found');

  const outputJson = path.join(os.tmpdir(), `diarize_${Date.now()}.json`);
  const pyPrefix = pythonCmd === 'py' ? ['-3'] : [];
  const args = [...pyPrefix, scriptPath, '--audio', wavPath, '--output', outputJson];
  if (hfToken) args.push('--hf-token', hfToken);
  if (numSpeakers) args.push('--num-speakers', String(numSpeakers));

  try {
    await runProcess(pythonCmd, args, {
      signal,
      onStderr: (data) => {
        for (const line of data.split('\n')) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.error) {
              event.sender.send('diarize-status', { error: parsed.error });
            } else if (parsed.message) {
              event.sender.send('diarize-status', { message: parsed.message, percent: parsed.percent });
            }
          } catch (_) { /* not JSON */ }
        }
      },
    });
    return JSON.parse(fs.readFileSync(outputJson, 'utf-8'));
  } finally {
    try { fs.unlinkSync(outputJson); } catch (_) {}
  }
}

// Diarisation merge pipeline - imported from shared module.
// JS modules in lib/ are inside the asar (only diarize.py and
// requirements.txt are extraResources for Python subprocess access).
const { mergeTranscriptWithDiarization } = require('./lib/diarize-merge');

ipcMain.handle('cancel-transcription', () => {
  if (transcriptionAbort) {
    transcriptionAbort.abort();
    return true;
  }
  return false;
});

ipcMain.handle('check-python', async () => capabilities.getPythonInfo());

ipcMain.handle('get-gpu-status', () => capabilities.getStatus());

ipcMain.handle('set-gpu-backend', (event, backend) => capabilities.setBackendPreference(backend));

ipcMain.handle('diarize', async (event, wavPath, options = {}) => {
  const abort = new AbortController();
  transcriptionAbort = abort;
  try {
    return await runDiarization(event, wavPath, options, abort.signal);
  } finally {
    transcriptionAbort = null;
  }
});

ipcMain.handle('open-external', async (event, url) => {
  // Only allow opening https URLs
  if (typeof url === 'string' && url.startsWith('https://')) {
    await shell.openExternal(url);
  }
});

ipcMain.handle('get-version', () => app.getVersion());

ipcMain.handle('is-debug-build', () => {
  // Debug mode: enabled by --debug build flag (writes .debug-build marker) or DEBUG_BUILD env var
  const markerPath = paths.getResourcePath('.debug-build');
  return fs.existsSync(markerPath) || process.env.DEBUG_BUILD === '1';
});

ipcMain.handle('get-log-path', () => logFile);

ipcMain.handle('open-log-file', async () => {
  if (fs.existsSync(logFile)) {
    await shell.openPath(logFile);
  } else {
    await shell.openPath(logDir);
  }
});

ipcMain.handle('open-log-folder', async () => {
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  await shell.openPath(logDir);
});

ipcMain.handle('install-update', () => autoUpdater.quitAndInstall());

ipcMain.handle('get-licenses', async () => {
  const licensePath = paths.getResourcePath('THIRD-PARTY-LICENSES.json');
  const data = fs.readFileSync(licensePath, 'utf-8');
  return JSON.parse(data);
});

ipcMain.handle('save-transcript', async (event, text) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Transcript',
    defaultPath: 'transcript.txt',
    filters: [{ name: 'Text Files', extensions: ['txt'] }],
  });
  if (result.canceled) return false;
  fs.writeFileSync(result.filePath, text, 'utf-8');
  return true;
});

function runProcess(cmd, args, { signal, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      return reject(new Error('Cancelled'));
    }

    const cmdName = path.basename(cmd);
    const safeArgs = args.map((a, i) => {
      // Mask HF tokens in logged output
      if (args[i - 1] === '--hf-token' || (typeof a === 'string' && a.startsWith('hf_'))) return 'hf_***';
      return a.includes(' ') ? `"${a}"` : a;
    });
    logWrite(`[RUN] ${cmdName} ${safeArgs.join(' ')}`);

    const env = paths.makeEnvWithLibPath(path.dirname(cmd));
    const proc = spawn(cmd, args, { env });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      const chunk = d.toString();
      stdout += chunk;
      logWrite(`[STDOUT:${cmdName}] ${chunk.trimEnd()}`);
    });
    proc.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      logWrite(`[STDERR:${cmdName}] ${chunk.trimEnd()}`);
      if (onStderr) onStderr(chunk);
    });
    proc.on('close', (code) => {
      logWrite(`[EXIT:${cmdName}] code=${code}`);
      if (signal && signal.aborted) reject(new Error('Cancelled'));
      else if (code === 0) resolve(stdout);
      else reject(new Error(`Process exited with code ${code}: ${stderr}`));
    });
    proc.on('error', (err) => {
      logWrite(`[ERROR:${cmdName}] ${err.message}`);
      reject(err);
    });

    if (signal) {
      const onAbort = () => {
        proc.kill();
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort);
      proc.on('close', () => signal.removeEventListener('abort', onAbort));
    }
  });
}
