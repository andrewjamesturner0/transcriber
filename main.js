const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const https = require('https');

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

ipcMain.handle('transcribe', async (event, filePath, modelId) => {
  const ffmpeg = getFfmpegBinary();
  const whisper = getWhisperBinary();
  const modelConfig = MODELS.find((m) => m.id === (modelId || 'tiny.en'));
  const modelPath = getModelPath(modelId || 'tiny.en');

  // Validate binaries exist
  for (const [name, p] of [['whisper-cli', whisper], ['ffmpeg', ffmpeg], ['model', modelPath]]) {
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
    const args = [
      '-m', modelPath,
      '-f', tmpWav,
      '-t', String(threads),
    ];

    // TinyDiarize models require timestamps and the --tinydiarize flag
    if (modelConfig && modelConfig.tdrz) {
      args.push('--tinydiarize');
    } else {
      args.push('--no-timestamps');
    }

    const output = await runProcess(whisper, args);

    return output.trim();
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(tmpWav); } catch (_) {}
  }
});

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
