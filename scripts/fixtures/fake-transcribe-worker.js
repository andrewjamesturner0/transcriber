#!/usr/bin/env node

const readline = require('readline');

let backend = null;
let modelPath = null;
let loadCount = 0;
let active = null;
const transcribeBackends = [];

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function failure(id, code, message) {
  send({ id, ok: false, error: { code, message } });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.op === 'load') {
    backend = frame.backend;
    modelPath = frame.modelPath;
    loadCount += 1;
    process.stderr.write(`loaded ${backend}\n`);
    return send({ id: frame.id, ok: true, result: { backend, reused: false, loadCount } });
  }
  if (frame.op === 'transcribe') {
    transcribeBackends.push(backend);
    if (process.env.FAKE_VALIDATION_SLOW_JOB === frame.jobId) {
      active = {
        id: frame.id,
        jobId: frame.jobId,
        timer: setTimeout(() => {
          send({ id: frame.id, ok: true, result: { text: 'late', backend, modelPath, loadCount } });
          active = null;
        }, 5000),
      };
      return;
    }
    if (frame.options && frame.options.behaviour === 'crash') return process.exit(23);
    if (frame.options && frame.options.behaviour === 'timeout') return;
    if (frame.options && frame.options.behaviour === 'vulkan-fail' && backend === 'vulkan') {
      return failure(frame.id, 'BACKEND_FAILURE', 'forced Vulkan failure');
    }
    if (frame.options && frame.options.behaviour === 'vulkan-oom' && backend === 'vulkan') {
      return failure(frame.id, 'OutOfMemory', 'forced Vulkan out of memory');
    }
    if (frame.options && frame.options.behaviour === 'slow') {
      active = {
        id: frame.id,
        jobId: frame.jobId,
        timer: setTimeout(() => {
          send({ id: frame.id, ok: true, result: { text: 'late', backend, modelPath, loadCount } });
          active = null;
        }, 5000),
      };
      return;
    }
    return send({ id: frame.id, ok: true, result: { text: 'ok', backend, modelPath, loadCount, transcribeBackends } });
  }
  if (frame.op === 'cancel') {
    const cancelled = !!active && (!frame.jobId || frame.jobId === active.jobId);
    if (cancelled) {
      clearTimeout(active.timer);
      failure(active.id, 'Aborted', 'Cancelled');
      active = null;
    }
    return send({ id: frame.id, ok: true, result: { cancelled } });
  }
  if (frame.op === 'unload') {
    backend = null;
    modelPath = null;
    return send({ id: frame.id, ok: true, result: { unloaded: true } });
  }
  if (frame.op === 'shutdown') {
    send({ id: frame.id, ok: true, result: { shutdown: true } });
    return process.exit(0);
  }
  return failure(frame.id, 'UNKNOWN_OPERATION', frame.op);
});
