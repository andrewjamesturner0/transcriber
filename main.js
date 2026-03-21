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

const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

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
];

function getResourcePath(relativePath) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, relativePath);
  }
  return path.join(__dirname, relativePath);
}

function getPlatformDir() {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

function getWhisperBinary() {
  const name = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  return getResourcePath(path.join('bin', getPlatformDir(), name));
}

function getFfmpegBinary() {
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  return getResourcePath(path.join('bin', getPlatformDir(), name));
}

function getModelsDir() {
  return getResourcePath('models');
}

function getModelPath(modelId) {
  const model = MODELS.find((m) => m.id === modelId);
  if (!model) throw new Error(`Unknown model: ${modelId}`);
  return path.join(getModelsDir(), model.fileName);
}

let mainWindow;
let transcriptionAbort = null;
let cachedPythonCmd = null;

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
    if (stats.size > 5 * 1024 * 1024) { // 5 MB
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

app.whenReady().then(() => {
  createWindow();

  // Auto-update setup
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
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

    autoUpdater.on('update-downloaded', () => {
      mainWindow.webContents.send('update-downloaded');
    });

    autoUpdater.checkForUpdates();
  } catch (_) {
    // Fail silently (e.g. dev mode, no internet)
  }
});
app.on('window-all-closed', () => app.quit());

// --- IPC Handlers ---

ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Audio File',
    filters: [
      { name: 'Audio Files', extensions: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'webm', 'wma', 'aac'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('select-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Audio Files',
    filters: [
      { name: 'Audio Files', extensions: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'webm', 'wma', 'aac'] },
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

ipcMain.handle('transcribe', async (event, filePath, modelId, options) => {
  logWrite(`=== Transcription started: model=${modelId}, diarization=${!!(options && options.diarization)}, file=${filePath} ===`);
  const ffmpeg = getFfmpegBinary();
  const whisper = getWhisperBinary();
  const modelConfig = MODELS.find((m) => m.id === (modelId || 'tiny.en'));
  const modelPath = getModelPath(modelId || 'tiny.en');
  const diarization = options && options.diarization;

  // Validate binaries exist
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
    event.sender.send('transcribe-status', 'Converting audio...');
    await runProcess(ffmpeg, ['-i', filePath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', tmpWav], { signal: abort.signal });

    // Step 2: Run whisper
    event.sender.send('transcribe-status', 'Transcribing (this may take a while)...');
    const threads = Math.max(1, Math.min(os.cpus().length - 1, 8));
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
      args.push('--output-json', '-of', whisperJsonPrefix);
    } else {
      args.push('--no-timestamps');
    }

    // Anti-corruption: disable context window + adjusted sampling to prevent hallucination loops
    if (options && options.antiCorruption) {
      args.push('-mc', '0', '--temperature', '0.4', '--entropy-thold', '1.8');
    }

    const output = await runProcess(whisper, args, { signal: abort.signal });

    // Step 3: If diarization enabled, run pyannote and merge
    if (diarization && !modelConfig?.tdrz) {
      try {
        // Parse whisper JSON for timestamped segments
        const whisperJsonPath = whisperJsonPrefix + '.json';
        const whisperJson = JSON.parse(fs.readFileSync(whisperJsonPath, 'utf-8'));
        const whisperSegments = (whisperJson.transcription || []).map((seg) => ({
          start: seg.offsets.from / 1000,
          end: seg.offsets.to / 1000,
          text: seg.text,
        }));

        // Run diarization
        event.sender.send('transcribe-status', 'Identifying speakers...');
        const diarizeSegments = await runDiarization(event, tmpWav, options, abort.signal);

        // Merge and return speaker-labeled transcript
        return mergeTranscriptWithDiarization(whisperSegments, diarizeSegments);
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

  let pythonCmd = cachedPythonCmd;
  if (!pythonCmd) {
    const candidates = process.platform === 'win32'
      ? ['python3', 'python', 'py']
      : ['python3', 'python'];
    for (const cmd of candidates) {
      try {
        const args = cmd === 'py' ? ['-3', '--version'] : ['--version'];
        await runProcess(cmd, args);
        pythonCmd = cmd;
        cachedPythonCmd = cmd;
        break;
      } catch (_) { /* not found */ }
    }
  }
  if (!pythonCmd) throw new Error('Python not found');

  const scriptPath = getResourcePath(path.join('lib', 'diarize.py'));
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

/**
 * Merge whisper timestamped segments with pyannote speaker segments.
 * For each whisper segment, find the speaker with the most temporal overlap.
 */
function mergeTranscriptWithDiarization(whisperSegments, diarizeSegments) {
  // Assign a readable label to each unique speaker (SPEAKER_00 -> Speaker 1, etc.)
  const speakerIds = [...new Set(diarizeSegments.map((s) => s.speaker))];
  const speakerLabels = {};
  speakerIds.forEach((id, i) => { speakerLabels[id] = `Speaker ${i + 1}`; });

  const labeled = whisperSegments.map((ws) => {
    // Find the diarize speaker with the most overlap
    let bestSpeaker = null;
    let bestOverlap = 0;

    for (const ds of diarizeSegments) {
      const overlapStart = Math.max(ws.start, ds.start);
      const overlapEnd = Math.min(ws.end, ds.end);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestSpeaker = ds.speaker;
      }
    }

    return {
      speaker: bestSpeaker ? speakerLabels[bestSpeaker] : 'Unknown',
      text: ws.text.trim(),
    };
  });

  // Collapse consecutive segments from the same speaker
  const collapsed = [];
  for (const seg of labeled) {
    if (!seg.text) continue;
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.speaker === seg.speaker) {
      prev.text += ' ' + seg.text;
    } else {
      collapsed.push({ ...seg });
    }
  }

  const speakerCount = speakerIds.length;
  const header = `[${speakerCount} speaker${speakerCount !== 1 ? 's' : ''} detected]\n\n`;
  const body = collapsed.map((s) => `[${s.speaker}] ${s.text}`).join('\n\n');
  return header + body;
}

ipcMain.handle('cancel-transcription', () => {
  if (transcriptionAbort) {
    transcriptionAbort.abort();
    return true;
  }
  return false;
});

ipcMain.handle('check-python', async () => {
  const result = { pythonFound: false, pythonVersion: null, pyannoteInstalled: false, pyannoteVersion: null, gpuAvailable: false };

  // Find a working Python >= 3.9
  const candidates = process.platform === 'win32'
    ? ['python3', 'python', 'py']
    : ['python3', 'python'];

  let pythonCmd = null;
  for (const cmd of candidates) {
    try {
      const args = cmd === 'py' ? ['-3', '--version'] : ['--version'];
      const out = await runProcess(cmd, args);
      const match = out.match(/Python (\d+)\.(\d+)\.(\d+)/);
      if (match) {
        const major = parseInt(match[1], 10);
        const minor = parseInt(match[2], 10);
        if (major >= 3 && minor >= 9) {
          result.pythonFound = true;
          result.pythonVersion = `${match[1]}.${match[2]}.${match[3]}`;
          pythonCmd = cmd;
          cachedPythonCmd = cmd;
          break;
        }
      }
    } catch (_) { /* not found or wrong version */ }
  }

  if (!pythonCmd) return result;

  const pyArgs = (code) => pythonCmd === 'py' ? ['-3', '-c', code] : ['-c', code];

  // Check pyannote.audio
  try {
    const out = await runProcess(pythonCmd, pyArgs('import pyannote.audio; print(pyannote.audio.__version__)'));
    result.pyannoteInstalled = true;
    result.pyannoteVersion = out.trim();
  } catch (_) { /* not installed */ }

  // Check GPU (torch + CUDA)
  try {
    const out = await runProcess(pythonCmd, pyArgs('import torch; print(torch.cuda.is_available())'));
    result.gpuAvailable = out.trim() === 'True';
  } catch (_) { /* torch not installed or no GPU */ }

  return result;
});

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
  const markerPath = getResourcePath('.debug-build');
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
  const licensePath = getResourcePath('THIRD-PARTY-LICENSES.json');
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

    const binDir = path.dirname(cmd);
    const env = { ...process.env };
    if (process.platform === 'linux') {
      env.LD_LIBRARY_PATH = binDir + (env.LD_LIBRARY_PATH ? ':' + env.LD_LIBRARY_PATH : '');
    } else if (process.platform === 'darwin') {
      env.DYLD_LIBRARY_PATH = binDir + (env.DYLD_LIBRARY_PATH ? ':' + env.DYLD_LIBRARY_PATH : '');
    }
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
