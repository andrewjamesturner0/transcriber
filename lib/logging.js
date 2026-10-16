// Best-effort local diagnostics. Transcript results never pass through this queue.
const nodeFs = require('fs');
const path = require('path');

function createLogger({
  logFile,
  maxFileBytes = 5 * 1024 * 1024,
  maxQueuedBytes = 1024 * 1024,
  fs = nodeFs,
  fsPromises = fs.promises || fs,
  now = () => new Date(),
  onError = () => {},
} = {}) {
  if (typeof logFile !== 'string' || !logFile) throw new Error('logFile is required');
  for (const limit of [maxFileBytes, maxQueuedBytes]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Log limits must be positive integers');
  }
  const recordLimit = Math.min(maxFileBytes, maxQueuedBytes);
  const queue = [];
  let queuedBytes = 0;
  let dropped = 0;
  let size = 0;
  let ready = false;
  let draining = null;
  let closed = false;
  let closePromise;

  function report(error) {
    try { onError(error); } catch (_) { /* Diagnostic callbacks are also best effort. */ }
  }

  function prefixBytes(bytes, limit) {
    let end = Math.min(bytes.length, limit);
    if (end < bytes.length) {
      while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    }
    return bytes.subarray(0, end);
  }

  function record(message) {
    const text = String(message);
    // Slice before encoding so a giant diagnostic does not allocate a giant buffer.
    const bytes = Buffer.from(`[${now().toISOString()}] ${text.slice(0, recordLimit)}\n`);
    if (text.length <= recordLimit && bytes.length <= recordLimit) return bytes;
    const suffix = Buffer.from(' [truncated]\n');
    if (recordLimit <= suffix.length) return suffix.subarray(suffix.length - recordLimit);
    return Buffer.concat([prefixBytes(bytes, recordLimit - suffix.length), suffix]);
  }

  async function statSize(file) {
    try { return (await fsPromises.stat(file)).size; }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  }

  async function append(bytes) {
    try {
      if (!ready) {
        await fsPromises.mkdir(path.dirname(logFile), { recursive: true });
        size = await statSize(logFile);
        if (size > maxFileBytes) {
          await fsPromises.truncate(logFile, maxFileBytes);
          size = maxFileBytes;
        }
        if (await statSize(logFile + '.old') > maxFileBytes) {
          await fsPromises.truncate(logFile + '.old', maxFileBytes);
        }
        ready = true;
      }
      if (size + bytes.length > maxFileBytes) {
        try { await fsPromises.unlink(logFile + '.old'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fsPromises.rename(logFile, logFile + '.old');
        size = 0;
      }
      await fsPromises.appendFile(logFile, bytes);
      size += bytes.length;
    } catch (error) {
      // A failed append might have written some bytes. Recheck bounds next time.
      ready = false;
      report(error);
    }
  }

  function startDrain() {
    if (draining) return draining;
    draining = Promise.resolve().then(async () => {
      while (queue.length || dropped) {
        if (queue.length) {
          const bytes = queue.shift();
          // Keep the in-flight write charged against the queue budget.
          await append(bytes);
          queuedBytes -= bytes.length;
        } else {
          const count = dropped;
          dropped = 0;
          const bytes = record(`Logger dropped ${count} diagnostic records under queue pressure`);
          queuedBytes += bytes.length;
          await append(bytes);
          queuedBytes -= bytes.length;
        }
      }
    }).catch(report).finally(() => {
      draining = null;
      // A write can arrive between the drain resolving and this finalizer.
      if (queue.length || dropped) return startDrain();
    });
    return draining;
  }

  function write(message) {
    if (closed) return false;
    let bytes;
    try { bytes = record(message); } catch (error) { report(error); return false; }
    if (queuedBytes + bytes.length > maxQueuedBytes) {
      dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1);
      startDrain();
      return false;
    }
    queue.push(bytes);
    queuedBytes += bytes.length;
    startDrain();
    return true;
  }

  function flush() { return draining || Promise.resolve(); }

  function close() {
    if (!closePromise) {
      closed = true;
      closePromise = flush();
    }
    return closePromise;
  }

  return { write, flush, close };
}

module.exports = { createLogger };
