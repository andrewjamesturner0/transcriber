const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

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

function getModelPath() {
  return getResourcePath(path.join('models', 'ggml-tiny.en.bin'));
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 700,
    height: 600,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);
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

ipcMain.handle('transcribe', async (event, filePath) => {
  const ffmpeg = getFfmpegBinary();
  const whisper = getWhisperBinary();
  const model = getModelPath();

  // Validate binaries exist
  for (const [name, p] of [['whisper-cli', whisper], ['ffmpeg', ffmpeg], ['model', model]]) {
    if (!fs.existsSync(p)) {
      throw new Error(`${name} not found at ${p}. Run "npm run setup" first.`);
    }
  }

  const tmpWav = path.join(os.tmpdir(), `whisper_input_${Date.now()}.wav`);

  try {
    // Step 1: Convert to 16kHz mono WAV
    event.sender.send('transcribe-status', 'Converting audio...');
    await runProcess(ffmpeg, ['-i', filePath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', tmpWav]);

    // Step 2: Run whisper
    event.sender.send('transcribe-status', 'Transcribing (this may take a while)...');
    const threads = Math.max(1, Math.min(os.cpus().length - 1, 8));
    const output = await runProcess(whisper, [
      '-m', model,
      '-f', tmpWav,
      '-t', String(threads),
      '--no-timestamps',
    ]);

    return output.trim();
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(tmpWav); } catch (_) {}
  }
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

function runProcess(cmd, args) {
  return new Promise((resolve, reject) => {
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
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Process exited with code ${code}: ${stderr}`));
    });
    proc.on('error', (err) => reject(err));
  });
}
