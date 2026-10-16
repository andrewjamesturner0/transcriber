// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

const https = require('https');
const nodeFs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Transform, pipeline } = require('stream');

function abortError() {
  const error = new Error('Download cancelled');
  error.name = 'AbortError';
  return error;
}

function secureUrl(value, base) {
  const url = new URL(value, base);
  if (url.protocol !== 'https:') throw new Error('Model downloads require HTTPS');
  return url.href;
}

function usableFile(fs, filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function createModelDownloader({
  get = https.get,
  fs = nodeFs,
  timeoutMs = 30000,
  maxRedirects = 5,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid download timeout');
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) throw new Error('Invalid redirect limit');
  const active = new Set();

  return async function download({ url, destPath, signal, onProgress }) {
    let nextUrl = secureUrl(url);
    const destination = path.resolve(destPath);
    if (signal && signal.aborted) throw abortError();
    if (active.has(destination)) throw new Error(`Already downloading: ${destination}`);
    if (usableFile(fs, destination)) return true;
    active.add(destination);
    let stagingPath;
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      for (let redirects = 0; ; redirects += 1) {
        const result = await transfer(nextUrl, redirects);
        if (result.redirect) {
          nextUrl = result.redirect;
          continue;
        }
        if (signal && signal.aborted) throw abortError();
        // A different installer may have published while this transfer ran.
        if (!usableFile(fs, destination)) fs.renameSync(stagingPath, destination);
        return true;
      }
    } finally {
      try {
        if (stagingPath) {
          try { fs.unlinkSync(stagingPath); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
      } finally {
        active.delete(destination);
      }
    }

    function transfer(downloadUrl, redirects) {
      return new Promise((resolve, reject) => {
        let request;
        let response;
        let file;
        let timer;
        let started = false;
        let settled = false;
        let failure;
        let received = 0;

        function settle(error, result) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', cancel);
          if (error) reject(error);
          else resolve(result);
        }

        function fail(error) {
          if (settled || failure) return;
          failure = error;
          clearTimeout(timer);
          // Keep error listeners installed: destroyed streams can emit later.
          if (response) response.destroy(error);
          if (file) file.destroy(error);
          if (request) request.destroy(error);
          if (!started) settle(error);
        }

        function cancel() { fail(abortError()); }
        function touch() {
          clearTimeout(timer);
          timer = setTimeout(() => {
            const error = new Error(`Download timed out after ${timeoutMs}ms of inactivity`);
            error.code = 'ETIMEDOUT';
            fail(error);
          }, timeoutMs);
        }

        if (signal) {
          signal.addEventListener('abort', cancel, { once: true });
          if (signal.aborted) return cancel();
        }
        touch();
        try {
          request = get(downloadUrl, (res) => {
            response = res;
            res.on('error', fail);
            res.on('aborted', () => fail(new Error('Download response aborted')));
            if (settled) {
              res.destroy();
              return;
            }
            touch();
            try {
              if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                if (!res.headers.location) throw new Error('Download redirect has no location');
                if (redirects >= maxRedirects) throw new Error('Too many download redirects');
                const redirect = secureUrl(res.headers.location, downloadUrl);
                res.destroy();
                settle(null, { redirect });
                return;
              }
              if (res.statusCode !== 200) throw new Error(`Download failed: HTTP ${res.statusCode}`);
              const declared = res.headers['content-length'];
              let total = 0;
              if (declared !== undefined) {
                if (typeof declared !== 'string' || !/^\d+$/.test(declared)) {
                  throw new Error('Invalid download Content-Length');
                }
                total = Number(declared);
                if (!Number.isSafeInteger(total)) throw new Error('Invalid download Content-Length');
              }
              const staging = `${destination}.${randomUUID()}.download`;
              const fd = fs.openSync(staging, 'wx', 0o600);
              stagingPath = staging;
              try {
                file = fs.createWriteStream(staging, { fd, autoClose: true });
              } catch (error) {
                fs.closeSync(fd);
                throw error;
              }
              file.on('error', fail);
              const counter = new Transform({
                transform(chunk, encoding, callback) {
                  touch();
                  received += chunk.length;
                  try {
                    if (declared !== undefined && received > total) {
                      throw new Error('Download length does not match Content-Length');
                    }
                    if (onProgress) onProgress({
                      percent: total ? Math.round(received / total * 100) : 0,
                      received,
                      total,
                    });
                    callback(null, chunk);
                  } catch (error) { callback(error); }
                },
                flush(callback) {
                  if (!received) return callback(new Error('Download body is empty'));
                  if (declared !== undefined && received !== total) {
                    return callback(new Error('Download length does not match Content-Length'));
                  }
                  callback();
                },
              });
              started = true;
              pipeline(res, counter, file, (error) => {
                if (error && !failure) fail(error);
                settle(failure || error, {});
              });
            } catch (error) { fail(error); }
          });
          request.on('error', fail);
          // Also covers injected transports that invoke the callback synchronously.
          if (failure) request.destroy(failure);
        } catch (error) { fail(error); }
      });
    }
  };
}

module.exports = { createModelDownloader };
