// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

const path = require('path');
const { StringDecoder } = require('string_decoder');
const childProcess = require('child_process');

const DIAGNOSTIC_BYTES = 64 * 1024;

// Bound an unfinished line as well as the retained stderr tail. Oversized
// non-JSON lines are delivered in bounded fragments for diagnostic matching.
function createLineReader(onLine, maxBytes = DIAGNOSTIC_BYTES) {
  let pending = '';
  return {
    write(chunk) {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.length) onLine('');
        for (let i = 0; i < line.length; i += maxBytes - 256) onLine(line.slice(i, i + maxBytes));
      }
      while (pending.length > maxBytes) {
        onLine(pending.slice(0, maxBytes));
        // A small overlap preserves diagnostic words split at the bound.
        pending = pending.slice(maxBytes - 256);
      }
    },
    end() { if (pending) onLine(pending); pending = ''; },
  };
}

const terminations = new WeakMap();

/**
 * Terminate one owned process tree. POSIX callers must spawn detached so the
 * child's PID is its process group ID. PID-less test doubles use kill().
 * Windows taskkill forcibly handles the tree in one request: waiting for the
 * parent first would lose the PID needed to find surviving descendants.
 */
function terminateProcess(proc, { spawn = childProcess.spawn, platform = process.platform, graceMs = 5000, forceMs = 2000 } = {}) {
  if (terminations.has(proc)) return terminations.get(proc);
  const promise = new Promise((resolve) => {
    let closed = proc.exitCode != null || proc.signalCode != null;
    let forced = false;
    let timer;
    const onClose = () => { closed = true; };
    proc.on('close', onClose);
    const finish = (timedOut) => {
      clearTimeout(timer);
      proc.removeListener('close', onClose);
      resolve({ forced, timedOut });
    };
    const pid = Number.isInteger(proc.pid) && proc.pid > 0 ? proc.pid : null;
    if (platform === 'win32' && pid) {
      forced = true;
      let killer;
      try { killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
      catch (_) { try { proc.kill('SIGKILL'); } catch (_) {} }
      let treeDone = !killer;
      let treeSucceeded = false;
      if (killer) {
        killer.once('close', (code) => { treeDone = true; treeSucceeded = code === 0; });
        killer.once('error', () => { treeDone = true; });
      }
      const deadline = Date.now() + forceMs;
      const poll = () => {
        if (closed && treeDone) return finish(!treeSucceeded);
        if (Date.now() >= deadline) {
          try { if (killer && !treeDone) killer.kill(); } catch (_) {}
          return finish(true);
        }
        timer = setTimeout(poll, 10);
      };
      poll();
      return;
    }
    let group = !!pid && platform !== 'win32';
    const send = (signal) => {
      if (group) {
        try { process.kill(-pid, signal); return; }
        catch (err) { if (err.code !== 'ESRCH') return; group = false; }
      }
      if (!closed) { try { proc.kill(signal); } catch (_) {} }
    };
    const alive = () => {
      if (group) {
        try { process.kill(-pid, 0); return true; }
        catch (err) { return err.code !== 'ESRCH'; }
      }
      return !closed;
    };
    send('SIGTERM');
    const graceDeadline = Date.now() + graceMs;
    let forceDeadline;
    const poll = () => {
      if (!alive()) return finish(false);
      if (!forced && Date.now() >= graceDeadline) {
        forced = true;
        send('SIGKILL');
        forceDeadline = Date.now() + forceMs;
      }
      if (forced && Date.now() >= forceDeadline) return finish(true);
      timer = setTimeout(poll, 10);
    };
    poll();
  });
  terminations.set(proc, promise);
  return promise;
}

/** Full stdout is result data; only stderr diagnostics have a size bound. */
function _runProcess(cmd, args, { signal, onStderr, spawn, makeEnvWithLibPath, log, extraEnv, terminationOptions }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('Cancelled'));
    const cmdName = path.basename(cmd);
    const safeArgs = args.map((a, i) => {
      if (args[i - 1] === '--hf-token' || (typeof a === 'string' && a.startsWith('hf_'))) return 'hf_***';
      return a.includes(' ') ? `"${a}"` : a;
    });
    log(`[RUN] ${cmdName} ${safeArgs.join(' ')}`);
    const env = { ...makeEnvWithLibPath(path.dirname(cmd)), ...(extraEnv || {}) };
    let proc;
    try { proc = spawn(cmd, args, { env, detached: process.platform !== 'win32', windowsHide: true }); }
    catch (err) { reject(err); return; }
    let stdout = '';
    let stderrTail = Buffer.alloc(0);
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let settled = false;
    let cancellation;
    const removeAbort = () => { if (signal) signal.removeEventListener('abort', onAbort); };
    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      removeAbort();
      if (err) reject(err); else resolve(value);
    };
    const cancelled = async () => {
      const outcome = await cancellation;
      log(`[TERMINATE:${cmdName}] forced=${outcome.forced} timedOut=${outcome.timedOut}`);
      const err = new Error('Cancelled');
      err.termination = outcome;
      settle(err);
    };
    const onAbort = () => {
      if (cancellation || settled) return;
      cancellation = Promise.resolve().then(() => terminateProcess(proc, { spawn, ...terminationOptions }));
      cancelled();
    };
    const acceptStderr = (chunk) => {
      if (!chunk) return;
      // Encode at most a bounded suffix, even if one incoming chunk is huge.
      const bytes = Buffer.from(chunk.slice(-DIAGNOSTIC_BYTES));
      stderrTail = bytes.length >= DIAGNOSTIC_BYTES
        ? Buffer.from(bytes.subarray(-DIAGNOSTIC_BYTES))
        : Buffer.from(Buffer.concat([stderrTail, bytes]).subarray(-DIAGNOSTIC_BYTES));
      log(`[STDERR:${cmdName}] ${chunk.trimEnd()}`);
      if (onStderr) onStderr(chunk);
    };
    proc.stdout.on('data', (d) => {
      const chunk = stdoutDecoder.write(Buffer.isBuffer(d) ? d : Buffer.from(d));
      stdout += chunk;
      log(`[STDOUT:${cmdName}] ${chunk.trimEnd()}`);
    });
    proc.stderr.on('data', (d) => acceptStderr(stderrDecoder.write(Buffer.isBuffer(d) ? d : Buffer.from(d))));
    proc.on('close', (code) => {
      stdout += stdoutDecoder.end();
      acceptStderr(stderrDecoder.end());
      log(`[EXIT:${cmdName}] code=${code}`);
      if (cancellation) return;
      if (signal && signal.aborted) { onAbort(); return; }
      if (code === 0) settle(null, stdout);
      else {
        // The byte tail may start inside a UTF-8 code point. Drop its
        // incomplete prefix rather than introducing replacement characters.
        let start = 0;
        while (start < stderrTail.length && (stderrTail[start] & 0xc0) === 0x80) start++;
        const diagnostic = stderrTail.subarray(start).toString('utf8');
        const err = new Error(`Process exited with code ${code}: ${diagnostic}`);
        err.stderrTail = diagnostic;
        settle(err);
      }
    });
    proc.on('error', (err) => {
      log(`[ERROR:${cmdName}] ${err.message}`);
      if (!cancellation) settle(err);
    });
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
}

/** Keep helper errors independently of the bounded diagnostic tail. */
async function runJsonHelper(cmd, args, { onMessage = () => {}, ...opts }) {
  let helperError = null;
  const lines = createLineReader((line) => {
    let parsed;
    try { parsed = JSON.parse(line); } catch (_) { return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    if (parsed.error) helperError = parsed.error;
    onMessage(parsed);
  });
  try {
    const stdout = await _runProcess(cmd, args, { ...opts, onStderr: (chunk) => lines.write(chunk) });
    lines.end();
    return stdout;
  } catch (err) {
    lines.end();
    if (err.message !== 'Cancelled' && helperError) throw new Error(helperError);
    throw err;
  }
}

module.exports = { _runProcess, runJsonHelper, terminateProcess, createLineReader, DIAGNOSTIC_BYTES };
