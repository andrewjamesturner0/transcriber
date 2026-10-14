// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

/**
 * Shared subprocess spawn helper.
 *
 * Used by lib/transcription-runner.js (FFmpeg, diarization) and
 * lib/whisper-runner.js (whisper transcription).
 */

const path = require('path');

/**
 * Spawn a subprocess and return its stdout. Handles logging, abort signals,
 * env setup (plus optional extraEnv), and optional stderr callback. Throws on
 * non-zero exit or error.
 */
function _runProcess(cmd, args, { signal, onStderr, spawn, makeEnvWithLibPath, log, extraEnv }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      return reject(new Error('Cancelled'));
    }

    const cmdName = path.basename(cmd);
    const safeArgs = args.map((a, i) => {
      if (args[i - 1] === '--hf-token' || (typeof a === 'string' && a.startsWith('hf_'))) return 'hf_***';
      return a.includes(' ') ? `"${a}"` : a;
    });
    log(`[RUN] ${cmdName} ${safeArgs.join(' ')}`);

    // extraEnv carries secrets (e.g. HF_TOKEN) so they never appear in argv or logs.
    const env = { ...makeEnvWithLibPath(path.dirname(cmd)), ...(extraEnv || {}) };
    const proc = spawn(cmd, args, { env });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      const chunk = d.toString();
      stdout += chunk;
      log(`[STDOUT:${cmdName}] ${chunk.trimEnd()}`);
    });
    proc.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      log(`[STDERR:${cmdName}] ${chunk.trimEnd()}`);
      if (onStderr) onStderr(chunk);
    });
    proc.on('close', (code) => {
      log(`[EXIT:${cmdName}] code=${code}`);
      if (signal && signal.aborted) reject(new Error('Cancelled'));
      else if (code === 0) resolve(stdout);
      else reject(new Error(`Process exited with code ${code}: ${stderr}`));
    });
    proc.on('error', (err) => {
      log(`[ERROR:${cmdName}] ${err.message}`);
      reject(err);
    });

    if (signal) {
      const onAbort = () => {
        proc.kill();
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort);
      proc.on('close', () => signal.removeEventListener('abort', onAbort));
    }
  });
}

/**
 * Run one of the Python helpers (lib/diarize.py, lib/align.py,
 * scripts/setup-diarization.py). They print one JSON object per stderr
 * line: progress { message, percent } or a failure { error, code }. Lines
 * can arrive split across chunks, so they are buffered. Each parsed object
 * goes to onMessage. If the helper fails after reporting an error, that
 * message is thrown instead of the bare exit code. Returns stdout.
 */
async function runJsonHelper(cmd, args, { onMessage = () => {}, ...opts }) {
  let pending = '';
  let helperError = null;
  try {
    return await _runProcess(cmd, args, {
      ...opts,
      onStderr: (chunk) => {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let parsed;
          try { parsed = JSON.parse(line); } catch (_) { continue; } // not JSON
          if (parsed && parsed.error) helperError = parsed.error;
          onMessage(parsed);
        }
      },
    });
  } catch (err) {
    if (err.message !== 'Cancelled' && helperError) throw new Error(helperError);
    throw err;
  }
}

module.exports = { _runProcess, runJsonHelper };
