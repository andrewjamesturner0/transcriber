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
const { createModelStore } = require('./lib/model-store');
const { createModelDownloader } = require('./lib/model-download');
const { createLogger } = require('./lib/logging');
const { createOperationManager } = require('./lib/operation-manager');
const { createTranscriptionRunner } = require('./lib/transcription-runner');
const { createDiarizationSetup } = require('./lib/diarization-setup');

// Initialize path resolver at module load time so it's available for
// all requires and function calls that follow.
paths.initPaths({
  isPackaged: app.isPackaged,
  resourcesPath: app.isPackaged ? process.resourcesPath : __dirname,
});

// --- Constants ---
const MEDIA_EXTENSIONS = [
  'mp3', 'wav', 'flac', 'm4a', 'ogg', 'webm', 'wma', 'aac', 'dss',
  'mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', '3gp',
];


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
let diarizationSetup = null;

// --- Debug logging ---
const logDir = path.join(app.getPath('userData'), 'logs');
const logFile = path.join(logDir, 'transcriber.log');

const logger = createLogger({ logFile });
const logWrite = logger.write;
const operations = createOperationManager();
const modelStore = createModelStore({
  bundledDir: paths.getResourcePath('models'),
  writableDir: path.join(app.getPath('userData'), 'models'),
  install: createModelDownloader(),
});
let shutdownPromise;
let shutdownComplete = false;
let installOnClose = false;

function send(sender, channel, data) {
  if (sender && !sender.isDestroyed()) sender.send(channel, data);
}

function sendToWindow(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) send(mainWindow.webContents, channel, data);
}

// Stop admission synchronously, then let owned work remove temporary files.
function shutdown(install = false) {
  installOnClose = installOnClose || install;
  if (!shutdownPromise) {
    const probes = capabilities ? capabilities.dispose() : Promise.resolve();
    shutdownPromise = operations.close({
      flush: async () => {
        await probes;
        await logger.close();
      },
    }).then((result) => {
      if (result.timedOut) logWrite('Shutdown timed out: ' + result.pending.join(', '));
    }).catch((error) => {
      logWrite('Shutdown failed: ' + error.message);
    }).finally(() => {
      shutdownComplete = true;
      if (installOnClose) autoUpdater.quitAndInstall();
      else app.quit();
    });
  }
  return shutdownPromise;
}

app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  shutdown();
});

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
  if (operations.isClosing()) return;
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
    modelStore,
    paths,
    spawn,
    log: logWrite,
  });
  diarizationSetup = createDiarizationSetup({ capabilities, paths, spawn, log: logWrite });

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
        sendToWindow('update-available', { version: info.version });
      } else {
        autoUpdater.autoDownload = false;
      }
    });

    autoUpdater.on('update-not-available', () => {
      logWrite('[UPDATE] No update available (already latest)');
    });

    autoUpdater.on('update-downloaded', (info) => {
      logWrite(`[UPDATE] Update downloaded: v${info.version}`);
      sendToWindow('update-downloaded');
    });

    autoUpdater.on('error', (err) => {
      logWrite(`[UPDATE] Error: ${err.message}`);
    });

    Promise.resolve(autoUpdater.checkForUpdates()).catch((error) => logWrite('[UPDATE] ' + error.message));
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
  return modelStore.listModels();
});

ipcMain.handle('download-model', (event, modelId) => {
  modelStore.getModel(modelId);
  return operations.run('download:' + modelId, (signal) => modelStore.downloadModel(modelId, {
    signal,
    onProgress: (data) => send(event.sender, 'download-progress', data),
  }), { exclusive: true });
});

ipcMain.handle('transcribe', (event, filePath, modelId, options, resultFormat) =>
  operations.run('transcription', async (signal) => {
    await capabilities.detectGpu();
    if (signal.aborted) throw new Error('Cancelled');
    logWrite('=== Transcription started: model=' + modelId + ', backend=' + capabilities.getActiveBackend() + ' ===');
    const result = await transcriptionRunner.runTranscription({
      filePath, modelId, options, signal,
      onProgress: (msg) => send(event.sender, 'transcribe-status', msg),
      onDiarizeProgress: (data) => send(event.sender, 'diarize-status', data),
    });
    return resultFormat === 'structured-v1' ? result : result.text;
  })
);

ipcMain.handle('cancel-transcription', () => operations.cancel());

// Re-probe every time: the Re-check button and a finished setup must see the
// current Python packages and model cache.
ipcMain.handle('check-python', async () => capabilities.getPythonInfo({ refresh: true }));

// User-directed download of the speaker model (D2). Jobs never download.
ipcMain.handle('check-alignment', async () => capabilities.getAlignmentInfo({ language: 'en', refresh: true }));

ipcMain.handle('prepare-diarization', (event, token, opts) =>
  operations.run('setup', (signal) => diarizationSetup.prepare({
    token, signal,
    alignment: !!(opts && opts.alignment),
    onProgress: (data) => send(event.sender, 'diarize-status', data),
  }))
);

ipcMain.handle('get-gpu-status', async () => {
  await capabilities.detectGpu();
  return capabilities.getStatus();
});

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
  await logger.flush();
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

ipcMain.handle('install-update', () => shutdown(true));

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

