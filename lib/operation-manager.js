// Own asynchronous work without depending on Electron or a concrete logger.
function createOperationManager({ shutdownTimeoutMs = 10000 } = {}) {
  if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs < 0) {
    throw new Error('shutdownTimeoutMs must be a non-negative finite number');
  }
  const records = new Set();
  let closing = false;
  let closePromise;

  function run(kind, work, { exclusive = kind === 'transcription' || kind === 'setup' } = {}) {
    if (closing) return Promise.reject(new Error('Operation manager is closing'));
    if (typeof kind !== 'string' || !kind || typeof work !== 'function') {
      return Promise.reject(new Error('Operation kind and work callback are required'));
    }
    for (const active of records) {
      if (active.kind === kind && (exclusive || active.exclusive)) {
        return Promise.reject(new Error(`Already running: ${kind}`));
      }
    }
    const controller = new AbortController();
    const record = { kind, exclusive, controller, promise: null };
    // Reserve before any callback or await, including work queued in this turn.
    records.add(record);
    record.promise = Promise.resolve().then(() => work(controller.signal)).finally(() => {
      records.delete(record);
    });
    // Ownership must settle even when a caller neglects a cancelled promise.
    record.promise.catch(() => {});
    return record.promise;
  }

  function cancel(kind = 'transcription') {
    let found = false;
    for (const record of records) {
      if (record.kind === kind) {
        found = true;
        record.controller.abort();
      }
    }
    return found;
  }

  function close({ flush = async () => {} } = {}) {
    if (closePromise) return closePromise;
    closing = true;
    let resolveClose;
    let rejectClose;
    closePromise = new Promise((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    const pending = () => [...new Set([...records].map((record) => record.kind))];
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      resolveClose({ timedOut: true, pending: pending() });
    }, shutdownTimeoutMs);
    const owned = [...records];
    for (const record of owned) record.controller.abort();
    // Only the first close call supplies finalisation. A failed flush is explicit.
    (async () => {
      await Promise.allSettled(owned.map((record) => record.promise));
      if (expired) return;
      await flush();
      resolveClose({ timedOut: false, pending: [] });
    })().catch(rejectClose).finally(() => clearTimeout(timer));
    return closePromise;
  }

  return { run, cancel, close, isClosing: () => closing };
}

module.exports = { createOperationManager };
