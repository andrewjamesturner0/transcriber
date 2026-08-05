// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const paths = require('./lib/paths');
const Capabilities = require('./lib/capabilities');
const models = require('./lib/models');
const { createTranscriptionRunner, createTranscriptionJobController } = require('./lib/transcription-runner');
const JobOptions = require('./renderer/job-options');

// Initialize path resolver at module load time so it's available for
// all requires and function calls that follow.
paths.initPaths({
  isPackaged: app.isPackaged,
  resourcesPath: app.isPackaged ? process.resourcesPath : __dirname,
  modelDirectory: path.join(app.getPath('userData'), 'models'),
});

// --- Constants ---
const MEDIA_EXTENSIONS = [
  'mp3', 'wav', 'flac', 'm4a', 'ogg', 'webm', 'wma', 'aac', 'dss',
  'mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', '3gp',
];
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB

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

let mainWindow;
let capabilities;
let transcriptionRunner;
const transcriptionJobs = createTranscriptionJobController();
let nextFileId = 1;
const selectedFiles = new Map();

function ipcError(code, message, field) {
  const error = new Error(message);
  error.code = code;
  if (field) error.field = field;
  return error;
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ipcError('INVALID_REQUEST', `${name} must be an object.`);
  }
  return value;
}

function rejectUnknownKeys(payload, allowed, name) {
  const unknown = Object.keys(payload).find((key) => !allowed.has(key));
  if (unknown) throw ipcError('INVALID_REQUEST', `Unknown ${name}: ${unknown}`, unknown);
}

function validateJobRequestOptions(options) {
  const stringFields = ['jobMode', 'sourceLanguage', 'targetLanguage'];
  for (const field of stringFields) {
    if (options[field] != null && typeof options[field] !== 'string') {
      throw ipcError('INVALID_REQUEST', `${field} must be a string.`, field);
    }
  }
  for (const field of ['speakerLabels', 'reduceRepeatedText']) {
    if (options[field] != null && typeof options[field] !== 'boolean') {
      throw ipcError('INVALID_REQUEST', `${field} must be true or false.`, field);
    }
  }
  if (options.expectedSpeakers != null
    && (!Number.isInteger(options.expectedSpeakers) || options.expectedSpeakers < 1)) {
    throw ipcError('INVALID_REQUEST', 'expectedSpeakers must be a positive whole number.', 'expectedSpeakers');
  }
}

function registerMediaFiles(filePaths) {
  return filePaths.map((filePath) => {
    const id = `file-${nextFileId++}`;
    selectedFiles.set(id, filePath);
    return { id, name: path.basename(filePath) };
  });
}

function resolveSelectedFile(fileId) {
  if (typeof fileId !== 'string' || !selectedFiles.has(fileId)) {
    throw ipcError('INVALID_FILE', 'Choose the audio or video file again.', 'fileId');
  }
  return selectedFiles.get(fileId);
}

function getModelForIpc(modelId) {
  if (typeof modelId !== 'string' || !modelId) {
    throw ipcError('INVALID_MODEL_ID', 'Choose a model.', 'modelId');
  }
  let model;
  try {
    model = models.getModel(modelId);
  } catch (_) {
    throw ipcError('INVALID_MODEL_ID', `Unknown model: ${modelId}`, 'modelId');
  }
  if (!model.runtimeAvailable) {
    throw ipcError('MODEL_UNAVAILABLE', `${model.displayName} is deferred because the pinned local runtime does not support it.`, 'modelId');
  }
  return model;
}

function safeGpuStatus(status) {
  return {
    backend: status.backend,
    detected: status.detected,
    deviceName: status.deviceName,
    setting: status.setting,
    available: Array.isArray(status.available) ? [...status.available] : [],
  };
}

function safePyannoteSetup(info) {
  return {
    pythonFound: !!info.pythonFound,
    pythonVersion: info.pythonVersion || null,
    pyannoteInstalled: !!info.pyannoteInstalled,
    pyannoteVersion: info.pyannoteVersion || null,
    gpuAvailable: !!info.gpuAvailable,
  };
}

async function getPresentationSettings() {
  const saved = readSettings();
  const pythonInfo = await capabilities.getPythonInfo();
  return {
    hfTokenConfigured: typeof saved.hfToken === 'string' && saved.hfToken.length > 0,
    gpu: safeGpuStatus(capabilities.getStatus()),
    pyannote: safePyannoteSetup(pythonInfo),
  };
}

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

function logRunnerMessage(message) {
  let safeMessage = String(message);
  const saved = readSettings();
  if (typeof saved.hfToken === 'string' && saved.hfToken) {
    safeMessage = safeMessage.split(saved.hfToken).join('[REDACTED]');
  }
  logWrite(safeMessage);
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
    width: 820,
    height: 900,
    minWidth: 390,
    minHeight: 640,
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

  // Create the transcription runner singleton (long-lived deps bound once)
  transcriptionRunner = createTranscriptionRunner({
    capabilities,
    paths,
    spawn,
    log: logRunnerMessage,
  });

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
let appShutdownFinished = false;
let appShutdownPromise = null;
app.on('before-quit', (event) => {
  if (appShutdownFinished) return;
  event.preventDefault();
  transcriptionJobs.cancel();
  if (appShutdownPromise) return;
  appShutdownPromise = Promise.resolve(transcriptionRunner && transcriptionRunner.shutdown())
    .catch((error) => logRunnerMessage(`[WORKER-SHUTDOWN-FAIL] ${error.message}`))
    .finally(() => {
      appShutdownFinished = true;
      app.quit();
    });
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
  return registerMediaFiles(result.filePaths);
});

ipcMain.handle('register-dropped-files', async (event, request) => {
  const payload = requireObject(request, 'register-dropped-files request');
  if (!Array.isArray(payload.filePaths) || payload.filePaths.some((value) => typeof value !== 'string')) {
    throw ipcError('INVALID_REQUEST', 'filePaths must be an array of file paths.', 'filePaths');
  }
  return registerMediaFiles(payload.filePaths);
});

ipcMain.handle('get-models', async (event, request) => {
  const payload = requireObject(request, 'get-models request');
  rejectUnknownKeys(payload, new Set(), 'get-models field');
  return models.listPresentationModels();
});

ipcMain.handle('derive-job-options', async (event, request) => {
  const payload = requireObject(request, 'derive-job-options request');
  rejectUnknownKeys(payload, new Set(['modelId', 'state']), 'derive-job-options field');
  if (typeof payload.modelId !== 'string') {
    throw ipcError('INVALID_MODEL_ID', 'Choose a model.', 'modelId');
  }
  let model;
  try {
    model = models.getModel(payload.modelId);
  } catch (_) {
    throw ipcError('INVALID_MODEL_ID', `Unknown model: ${payload.modelId}`, 'modelId');
  }
  const rawState = payload.state == null ? {} : requireObject(payload.state, 'job option state');
  rejectUnknownKeys(rawState, new Set(['optionsOpen', 'advancedOpen', 'requested']), 'job option state field');
  const requested = rawState.requested == null ? {} : requireObject(rawState.requested, 'requested job options');
  rejectUnknownKeys(requested, new Set([
    'jobMode', 'sourceLanguage', 'targetLanguage', 'speakerLabels',
    'expectedSpeakers', 'reduceRepeatedText',
  ]), 'requested job option');
  validateJobRequestOptions(requested);
  const state = JobOptions.createJobOptionsState({
    ...requested,
    optionsOpen: !!rawState.optionsOpen,
    advancedOpen: !!rawState.advancedOpen,
  });
  return JobOptions.deriveJobOptions(model, state, models.validateJobOptions);
});

ipcMain.handle('download-model', async (event, request) => {
  const payload = requireObject(request, 'download-model request');
  rejectUnknownKeys(payload, new Set(['modelId']), 'download-model field');
  const model = getModelForIpc(payload.modelId);
  const saved = readSettings();
  const hfToken = typeof saved.hfToken === 'string' && saved.hfToken ? saved.hfToken : null;
  if (model.gated && !hfToken) {
    throw ipcError('HF_TOKEN_REQUIRED', `${model.displayName} requires a saved Hugging Face token.`, 'modelId');
  }
  try {
    await models.downloadModel(model.id, models.getModelDownloadPath(model.id), (data) => {
      event.sender.send('download-progress', data);
    }, model.gated ? { hfToken } : {});
  } catch (error) {
    logRunnerMessage(`[DOWNLOAD-FAIL] model=${model.id} ${error.message}`);
    const httpFailure = /^Download failed: HTTP \d+$/.test(error.message);
    throw ipcError('DOWNLOAD_FAILED', httpFailure ? error.message : `Could not download ${model.displayName}.`);
  }
  return { modelId: model.id, downloaded: true };
});

ipcMain.handle('transcribe', async (event, request) => {
  const payload = requireObject(request, 'transcribe request');
  const filePath = resolveSelectedFile(payload.fileId);
  const model = getModelForIpc(payload.modelId);
  const options = payload.options == null ? {} : requireObject(payload.options, 'transcribe options');
  const allowedOptions = new Set([
    'jobMode', 'sourceLanguage', 'targetLanguage', 'speakerLabels',
    'expectedSpeakers', 'reduceRepeatedText',
  ]);
  rejectUnknownKeys(payload, new Set(['fileId', 'modelId', 'options']), 'transcribe field');
  rejectUnknownKeys(options, allowedOptions, 'transcribe option');
  validateJobRequestOptions(options);
  const validation = models.validateJobOptions(model.id, options);
  if (!validation.valid) {
    const first = validation.errors[0];
    throw ipcError(first.code, first.message, first.field);
  }
  if (!fs.existsSync(models.getModelPath(model.id))) {
    throw ipcError('MODEL_NOT_DOWNLOADED', `${model.displayName} must be downloaded before transcription.`, 'modelId');
  }

  const backend = capabilities.getActiveBackend();
  logWrite(`=== Transcription started: model=${model.id}, backend=${backend}, speakerLabels=${validation.effective.speakerLabels} ===`);

  const job = transcriptionJobs.begin();

  try {
    const saved = readSettings();
    const run = await transcriptionRunner.runTranscription({
      filePath,
      modelId: model.id,
      options: {
        ...validation.effective,
        diarization: validation.effective.speakerLabels,
        numSpeakers: validation.effective.expectedSpeakers,
        hfToken: validation.effective.speakerLabels ? saved.hfToken : undefined,
      },
      signal: job.controller.signal,
      onProgress: (msg) => event.sender.send('transcribe-status', msg),
      onDiarizeProgress: (data) => event.sender.send('diarize-status', data),
    });
    return run.result || {
      text: run.text,
      model: model.id,
      engine: model.engine,
      backend,
    };
  } catch (error) {
    logRunnerMessage(`[TRANSCRIPTION-FAIL] ${error.message}\n${error.stack || ''}`);
    if (error.message === 'Cancelled') throw ipcError('CANCELLED', 'Cancelled');
    if (error.code === 'AUDIO_LIMIT_EXCEEDED') {
      throw ipcError(error.code, error.message, 'fileId');
    }
    throw ipcError('TRANSCRIPTION_FAILED', 'Transcription failed. Check the application log for details.');
  } finally {
    job.finish();
  }
});

ipcMain.handle('cancel-transcription', () => {
  return transcriptionJobs.cancel();
});

ipcMain.handle('get-settings', async (event, request) => {
  const payload = requireObject(request, 'get-settings request');
  rejectUnknownKeys(payload, new Set(['refreshPyannote']), 'get-settings field');
  if (payload.refreshPyannote != null && typeof payload.refreshPyannote !== 'boolean') {
    throw ipcError('INVALID_REQUEST', 'refreshPyannote must be true or false.', 'refreshPyannote');
  }
  return getPresentationSettings();
});

ipcMain.handle('update-settings', async (event, request) => {
  const payload = requireObject(request, 'update-settings request');
  const allowed = new Set(['hfToken', 'gpuPreference']);
  rejectUnknownKeys(payload, allowed, 'setting');
  if (Object.prototype.hasOwnProperty.call(payload, 'hfToken')) {
    if (typeof payload.hfToken !== 'string' || payload.hfToken.length > 8192) {
      throw ipcError('INVALID_SETTING', 'Hugging Face token must be a string of at most 8192 characters.', 'hfToken');
    }
    writeSettings({ hfToken: payload.hfToken || null });
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'gpuPreference')) {
    if (!['auto', 'cpu', 'vulkan'].includes(payload.gpuPreference)) {
      throw ipcError('INVALID_SETTING', 'GPU preference must be auto, cpu or vulkan.', 'gpuPreference');
    }
    await capabilities.setBackendPreference(payload.gpuPreference);
  }
  const saved = readSettings();
  return { hfTokenConfigured: typeof saved.hfToken === 'string' && saved.hfToken.length > 0 };
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
