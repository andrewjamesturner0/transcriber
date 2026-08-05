const { spawn: defaultSpawn } = require('child_process');

function normalizeWorkerErrorCode(code) {
  if (code === 'BackendError') return 'BACKEND_FAILURE';
  if (code === 'OutOfMemory') return 'OUT_OF_MEMORY';
  return code || 'WORKER_ERROR';
}

function workerError(payload) {
  const error = new Error(payload && payload.message || 'Transcribe worker failed');
  error.code = normalizeWorkerErrorCode(payload && payload.code);
  return error;
}

function createTranscribeWorkerClient({
  launch,
  spawn = defaultSpawn,
  timeoutMs,
  controlTimeoutMs = timeoutMs == null ? 30000 : timeoutMs,
  loadTimeoutMs = timeoutMs == null ? 300000 : timeoutMs,
  transcriptionTimeoutMs = timeoutMs == null ? null : timeoutMs,
  cancellationTimeoutMs = 5000,
  log = () => {},
  onEvent = () => {},
}) {
  let child = null;
  let stdoutBuffer = '';
  let nextId = 1;
  let loadedKey = null;
  let vulkanUnavailable = false;
  let closed = false;
  let shutdownPromise = null;
  const pending = new Map();

  function shortControlTimeout() {
    return Math.min(controlTimeoutMs, 5000);
  }

  function elapsedMilliseconds(startedAt) {
    return Number(process.hrtime.bigint() - startedAt) / 1e6;
  }

  function emitLoadEvent(startedAt, modelPath, backend, details) {
    onEvent({
      type: 'load',
      modelPath,
      backend,
      durationMs: elapsedMilliseconds(startedAt),
      ...details,
    });
  }

  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }

  function handleLine(line) {
    if (!line.trim()) return;
    let frame;
    try { frame = JSON.parse(line); } catch (_) {
      log(`[TRANSCRIBE-WORKER] Ignored invalid stdout frame: ${line}`);
      return;
    }
    const request = pending.get(frame.id);
    if (!request) return;
    pending.delete(frame.id);
    clearTimeout(request.timer);
    if (frame.ok) request.resolve(frame.result);
    else request.reject(workerError(frame.error));
  }

  function start() {
    if (child) return child;
    if (closed) throw new Error('Transcribe worker client is closed');
    child = spawn(launch.command, launch.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: launch.env || process.env,
      windowsHide: true,
    });
    stdoutBuffer = '';
    child.stdout.on('data', (data) => {
      stdoutBuffer += data.toString();
      let newline;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleLine(line);
      }
    });
    child.stderr.on('data', (data) => log(`[TRANSCRIBE-WORKER] ${data.toString().trimEnd()}`));
    child.once('error', (error) => rejectPending(error));
    child.once('exit', (code, signal) => {
      const exiting = child;
      child = null;
      loadedKey = null;
      if (exiting) rejectPending(workerError({ code: 'WORKER_EXIT', message: `Transcribe worker exited (${code == null ? signal : code})` }));
    });
    return child;
  }

  function request(op, payload = {}, requestTimeout = controlTimeoutMs) {
    const proc = start();
    const id = String(nextId++);
    return new Promise((resolve, reject) => {
      const timer = requestTimeout == null ? null : setTimeout(() => {
        pending.delete(id);
        const error = workerError({ code: 'WORKER_TIMEOUT', message: `Transcribe worker ${op} timed out` });
        reject(error);
        if (child === proc) proc.kill();
      }, requestTimeout);
      pending.set(id, { resolve, reject, timer });
      proc.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      });
    });
  }

  async function ensureLoaded(modelPath, backend) {
    const key = `${modelPath}\n${backend}`;
    if (child && loadedKey === key) {
      const result = { reused: true, backend };
      onEvent({ type: 'load', modelPath, backend, durationMs: 0, reused: true });
      return result;
    }
    const startedAt = process.hrtime.bigint();
    loadedKey = null;
    try {
      const result = await request('load', { modelPath, backend }, loadTimeoutMs);
      loadedKey = key;
      emitLoadEvent(startedAt, modelPath, result.backend || backend, { reused: !!result.reused });
      return result;
    } catch (error) {
      emitLoadEvent(startedAt, modelPath, backend, {
        reused: false,
        errorCode: error.code || error.name || 'WORKER_ERROR',
      });
      throw error;
    }
  }

  async function runOnce({ modelPath, backend, wavPath, options, jobId, signal }) {
    await ensureLoaded(modelPath, backend);
    if (signal && signal.aborted) throw workerError({ code: 'CANCELLED', message: 'Cancelled' });
    let abortHandler;
    let cancellationTimer;
    if (signal) {
      abortHandler = () => {
        request('cancel', { jobId }, shortControlTimeout()).catch(() => {});
        const proc = child;
        cancellationTimer = setTimeout(() => {
          if (child === proc) proc.kill();
        }, cancellationTimeoutMs);
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }
    try {
      return await request('transcribe', { wavPath, options, jobId }, transcriptionTimeoutMs);
    } finally {
      clearTimeout(cancellationTimer);
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    }
  }

  function selectBackend(params) {
    const requestedBackend = params.backend || 'cpu';
    if (requestedBackend === 'vulkan' && vulkanUnavailable && params.supportsCpu !== false) {
      return 'cpu';
    }
    return requestedBackend;
  }

  function canRetryOnCpu(params, backend, error) {
    return backend === 'vulkan'
      && params.supportsCpu !== false
      && (error.code === 'BACKEND_FAILURE' || error.code === 'OUT_OF_MEMORY');
  }

  async function transcribe(params) {
    const backend = selectBackend(params);
    try {
      return await runOnce({ ...params, backend });
    } catch (error) {
      if (backend === 'vulkan' && error.code === 'BACKEND_FAILURE') vulkanUnavailable = true;
      if (!canRetryOnCpu(params, backend, error)) throw error;
      loadedKey = null;
      return runOnce({ ...params, backend: 'cpu' });
    }
  }

  async function unload() {
    if (!child) return false;
    await request('unload', {}, controlTimeoutMs);
    loadedKey = null;
    return true;
  }

  async function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    closed = true;
    shutdownPromise = (async () => {
      const proc = child;
      if (!proc) return;
      try { await request('shutdown', {}, shortControlTimeout()); } catch (_) {}
      if (child === proc) {
        proc.stdin.end();
        await new Promise((resolve) => {
          if (proc.exitCode != null) resolve();
          else {
            const timer = setTimeout(() => { proc.kill(); resolve(); }, 1000);
            proc.once('exit', () => { clearTimeout(timer); resolve(); });
          }
        });
      }
      child = null;
      loadedKey = null;
    })();
    return shutdownPromise;
  }

  return {
    transcribe,
    unload,
    shutdown,
    cancel: (jobId) => child ? request('cancel', { jobId }, shortControlTimeout()) : Promise.resolve({ cancelled: false }),
    getState: () => ({
      running: !!child,
      pid: child && child.pid || null,
      loadedKey,
      vulkanUnavailable,
      vulkanUnavailableReason: vulkanUnavailable ? 'BACKEND_FAILURE' : null,
      pending: pending.size,
      closed,
    }),
  };
}

module.exports = { createTranscribeWorkerClient };
