import fs from 'node:fs';
import readline from 'node:readline';
import { TranscribeModel } from 'transcribe-cpp';

let model = null;
let loaded = null;
let activeJob = null;
let shuttingDown = false;

function write(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function normalizeErrorCode(code) {
  if (code === 'BackendError') return 'BACKEND_FAILURE';
  if (code === 'OutOfMemory') return 'OUT_OF_MEMORY';
  return code || 'WORKER_ERROR';
}

function fail(id, error) {
  const code = normalizeErrorCode(error && (error.code || error.name));
  write({ id, ok: false, error: { code, message: error && error.message || String(error) } });
}

function readWav(path) {
  const data = fs.readFileSync(path);
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
    throw Object.assign(new Error('Input must be a RIFF WAVE file'), { code: 'INVALID_AUDIO' });
  }
  let offset = 12;
  let format = null;
  let payload = null;
  while (offset + 8 <= data.length) {
    const kind = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (kind === 'fmt ') {
      format = {
        encoding: data.readUInt16LE(start),
        channels: data.readUInt16LE(start + 2),
        sampleRate: data.readUInt32LE(start + 4),
        bits: data.readUInt16LE(start + 14),
      };
    } else if (kind === 'data') {
      payload = data.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!format || !payload || format.channels !== 1 || format.sampleRate !== 16000) {
    throw Object.assign(new Error('Input must be 16 kHz mono WAV'), { code: 'INVALID_AUDIO' });
  }
  if (format.encoding === 1 && format.bits === 16) {
    const pcm = new Float32Array(payload.length / 2);
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = payload.readInt16LE(i * 2) / 32768;
    return pcm;
  }
  if (format.encoding === 3 && format.bits === 32) {
    const pcm = new Float32Array(payload.length / 4);
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = payload.readFloatLE(i * 4);
    return pcm;
  }
  throw Object.assign(new Error('Input WAV must contain PCM16 or float32 samples'), { code: 'INVALID_AUDIO' });
}

async function unload() {
  if (activeJob) activeJob.controller.abort();
  if (model) model.dispose();
  model = null;
  loaded = null;
}

async function handle(frame) {
  const { id, op } = frame;
  if (!id || !op) throw Object.assign(new Error('Frame requires id and op'), { code: 'INVALID_FRAME' });
  if (shuttingDown) throw Object.assign(new Error('Worker is shutting down'), { code: 'SHUTTING_DOWN' });

  if (op === 'load') {
    const key = `${frame.modelPath}\n${frame.backend || 'cpu'}`;
    if (loaded && loaded.key === key) return write({ id, ok: true, result: { reused: true, backend: loaded.backend } });
    await unload();
    model = await TranscribeModel.load(frame.modelPath, { backend: frame.backend || 'cpu' });
    loaded = { key, modelPath: frame.modelPath, backend: frame.backend || 'cpu' };
    return write({ id, ok: true, result: { reused: false, backend: loaded.backend } });
  }

  if (op === 'transcribe') {
    if (!model || !loaded) throw Object.assign(new Error('No model is loaded'), { code: 'MODEL_NOT_LOADED' });
    if (activeJob) throw Object.assign(new Error('A transcription is already running'), { code: 'BUSY' });
    const controller = new AbortController();
    activeJob = { jobId: frame.jobId, controller };
    try {
      const result = await model.transcribe(readWav(frame.wavPath), {
        ...frame.options,
        signal: controller.signal,
      });
      return write({ id, ok: true, result: { ...result, backend: loaded.backend } });
    } finally {
      activeJob = null;
    }
  }

  if (op === 'cancel') {
    const cancelled = !!activeJob && (!frame.jobId || activeJob.jobId === frame.jobId);
    if (cancelled) activeJob.controller.abort();
    return write({ id, ok: true, result: { cancelled } });
  }

  if (op === 'unload') {
    await unload();
    return write({ id, ok: true, result: { unloaded: true } });
  }

  if (op === 'shutdown') {
    shuttingDown = true;
    await unload();
    write({ id, ok: true, result: { shutdown: true } });
    process.exitCode = 0;
    return;
  }

  throw Object.assign(new Error(`Unknown worker operation: ${op}`), { code: 'UNKNOWN_OPERATION' });
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch (error) {
    process.stderr.write(`Invalid worker frame: ${error.message}\n`);
    return;
  }
  Promise.resolve(handle(frame)).catch((error) => fail(frame.id, error));
});
input.on('close', async () => {
  await unload();
});

process.on('uncaughtException', (error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
