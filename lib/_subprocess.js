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
 * env setup, and optional stderr callback. Throws on non-zero exit or error.
 */
function _runProcess(cmd, args, { signal, onStderr, spawn, makeEnvWithLibPath, log }) {
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

    const env = makeEnvWithLibPath(path.dirname(cmd));
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

module.exports = { _runProcess };
