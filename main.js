// Transcriber — local audio/video transcription
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
const { createTranscriptionRunner } = require('./lib/transcription-runner');

// Initialize path resolver at module load time so it's available for
// all requires and function calls that follow.
paths.initPaths({
  isPackaged: app.isPackaged,
  resourcesPath: app.isPackaged ? process.resourcesPath : __dirname,
});

// --- Constants ---
const MEDIA_EXTENSIONS = [
  'mp3', 'wav', 'flac', 'm4a', 'ogg', 'webm', 'wma', 'aac',
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
let transcriptionAbort = null;
let capabilities;
let transcriptionRunner;

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

  // Create the transcription runner singleton (long-lived deps bound once)
  transcriptionRunner = createTranscriptionRunner({
    capabilities,
    paths,
    spawn,
    log: logWrite,
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
  return models.listModels();
});

ipcMain.handle('download-model', async (event, modelId) => {
  models.getModel(modelId); // validates id; throws on unknown
  return models.downloadModel(modelId, models.getModelPath(modelId), (data) => {
    event.sender.send('download-progress', data);
  });
});

ipcMain.handle('transcribe', async (event, filePath, modelId, options) => {
  const backend = capabilities.getActiveBackend();
  logWrite(`=== Transcription started: model=${modelId}, backend=${backend}, diarization=${!!(options && options.diarization)}, file=${filePath} ===`);

  const abort = new AbortController();
  transcriptionAbort = abort;

  try {
    const { text } = await transcriptionRunner.runTranscription({
      filePath,
      modelId,
      options,
      signal: abort.signal,
      onProgress: (msg) => event.sender.send('transcribe-status', msg),
      onDiarizeProgress: (data) => event.sender.send('diarize-status', data),
    });
    return text;
  } finally {
    transcriptionAbort = null;
  }
});

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


