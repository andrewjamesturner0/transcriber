// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

/**
 * Canonical model metadata.
 *
 * Owns the list of available whisper models and every per-model fact
 * (filename, label, size, DTW preset, tdrz flag, Hugging Face repo).
 * All callers consult this module - no parallel data structures.
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const paths = require('./paths');
const catalogue = require('./model-catalogue');

// ---------------------------------------------------------------------------
// Model definitions
// ---------------------------------------------------------------------------

const MODELS = catalogue.MODELS;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return every model with its download status.
 * @returns {Array<{ id, fileName, label, size, tdrz?, hfRepo?, dtwPreset?, downloaded: boolean }>}
 */
function listModels() {
  return MODELS.map((m) => ({
    ...m,
    downloaded: fs.existsSync(getModelPath(m.id)),
  }));
}

/**
 * Return the raw spec for a model, or throw.
 * @param {string} id
 * @returns {{ id, fileName, label, size, tdrz?, hfRepo?, dtwPreset? }}
 */
function getModel(id) {
  return catalogue.getCatalogueModel(id);
}

/**
 * Return the absolute filesystem path to a model's .bin file.
 * @param {string} id
 * @returns {string}
 */
function getModelPath(id) {
  const model = getModel(id);
  const downloadedPath = paths.getModelDownloadPath(model.fileName);
  if (fs.existsSync(downloadedPath)) return downloadedPath;
  const bundledPath = paths.getBundledModelPath(model.fileName);
  if (fs.existsSync(bundledPath)) return bundledPath;
  return downloadedPath;
}

function getModelDownloadPath(id) {
  return paths.getModelDownloadPath(getModel(id).fileName);
}

/**
 * Return the Hugging Face download URL for a model.
 * @param {string} id
 * @returns {string}
 */
function getDownloadUrl(id) {
  const model = getModel(id);
  return `https://huggingface.co/${model.repository}/resolve/${model.revision}/${model.fileName}`;
}

/**
 * Download a model file from Hugging Face to the given destination path.
 *
 * Follows redirects, writes to a `.download` temp file, renames on success.
 * No-ops if the destination already exists.
 *
 * @param {string}   modelId
 * @param {string}   destPath - target absolute path for the .bin file
 * @param {Function} [onProgress] - called with ({ modelId, percent, received, total })
 * @returns {Promise<boolean>} true on success (or when already present)
 */
function isApprovedHuggingFaceHost(url) {
  let hostname;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    hostname = parsed.hostname.toLowerCase();
  } catch (_) {
    return false;
  }
  return hostname === 'huggingface.co' || hostname.endsWith('.huggingface.co')
    || hostname === 'hf.co' || hostname.endsWith('.hf.co');
}

function removePartial(tmpDest) {
  try { fs.unlinkSync(tmpDest); } catch (_) {}
}

function downloadToPath({
  modelId,
  url,
  destPath,
  expectedSha256,
  hfToken = null,
  onProgress,
  request = https.get,
  maxRedirects = 8,
}) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpDest = destPath + '.download';
  removePartial(tmpDest);

  return new Promise((resolve, reject) => {
    let settled = false;
    let activeFile = null;

    function fail(error) {
      if (settled) return;
      settled = true;
      const finish = () => {
        removePartial(tmpDest);
        reject(error);
      };
      if (activeFile && !activeFile.closed) {
        activeFile.once('close', finish);
        activeFile.destroy();
      } else {
        finish();
      }
    }
    function succeed() {
      if (settled) return;
      settled = true;
      resolve(true);
    }

    function parseDownloadUrl(downloadUrl) {
      let parsed;
      try {
        parsed = new URL(downloadUrl);
      } catch (_) {
        throw new Error('Download failed: invalid redirect URL');
      }
      if (parsed.protocol !== 'https:') {
        throw new Error('Download failed: redirects must use HTTPS');
      }
      return parsed;
    }

    function followRedirect(response, parsed, redirectCount) {
      if (redirectCount >= maxRedirects) {
        response.resume();
        fail(new Error('Download failed: too many redirects'));
        return;
      }

      let nextUrl;
      try {
        nextUrl = new URL(response.headers.location, parsed.href).href;
      } catch (_) {
        response.resume();
        fail(new Error('Download failed: invalid redirect URL'));
        return;
      }

      response.resume();
      download(nextUrl, redirectCount + 1);
    }

    function installDownloadedFile(file, hash) {
      file.close((closeError) => {
        activeFile = null;
        if (closeError) return fail(closeError);
        const actualSha256 = hash.digest('hex');
        if (actualSha256 !== expectedSha256) {
          const error = new Error('Download failed: checksum mismatch');
          error.code = 'CHECKSUM_MISMATCH';
          return fail(error);
        }
        try {
          fs.renameSync(tmpDest, destPath);
          succeed();
        } catch (error) {
          fail(error);
        }
      });
    }

    function writeResponse(response) {
      const total = parseInt(response.headers['content-length'], 10) || 0;
      let received = 0;
      const hash = crypto.createHash('sha256');
      const file = fs.createWriteStream(tmpDest, { flags: 'wx' });
      activeFile = file;
      response.on('data', (chunk) => {
        received += chunk.length;
        hash.update(chunk);
        if (total > 0 && onProgress) {
          onProgress({ modelId, percent: Math.round((received / total) * 100), received, total });
        }
      });
      response.on('aborted', () => fail(new Error('Download interrupted')));
      response.on('error', fail);
      file.on('error', fail);
      file.on('finish', () => installDownloadedFile(file, hash));
      response.pipe(file);
    }

    function handleResponse(response, parsed, redirectCount) {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        followRedirect(response, parsed, redirectCount);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        fail(new Error(`Download failed: HTTP ${response.statusCode}`));
        return;
      }
      writeResponse(response);
    }

    function download(downloadUrl, redirectCount) {
      let parsed;
      try {
        parsed = parseDownloadUrl(downloadUrl);
      } catch (error) {
        fail(error);
        return;
      }

      const requestOptions = hfToken && isApprovedHuggingFaceHost(parsed.href)
        ? { headers: { Authorization: `Bearer ${hfToken}` } }
        : {};
      let outgoing;
      try {
        outgoing = request(parsed.href, requestOptions, (response) => {
          handleResponse(response, parsed, redirectCount);
        });
      } catch (error) {
        fail(error);
        return;
      }
      outgoing.on('error', fail);
    }

    download(url, 0);
  });
}

function downloadModel(modelId, destPath, onProgress, options = {}) {
  const model = getModel(modelId);
  if (model.runtimeAvailable === false) {
    const error = new Error(`${model.displayName} does not have an available local runtime.`);
    error.code = 'MODEL_UNAVAILABLE';
    return Promise.reject(error);
  }
  if (fs.existsSync(destPath)) return Promise.resolve(true);
  return downloadToPath({
    modelId,
    url: getDownloadUrl(modelId),
    destPath,
    expectedSha256: model.sha256,
    hfToken: options.hfToken || null,
    onProgress,
  });
}

function listPresentationModels() {
  return catalogue.listPresentationModels().map((model) => ({
    ...model,
    downloaded: fs.existsSync(getModelPath(model.id)),
    availability: model.runtimeAvailable ? 'available' : 'deferred',
  }));
}

module.exports = {
  listModels,
  getModel,
  getModelPath,
  getModelDownloadPath,
  getDownloadUrl,
  downloadModel,
  downloadToPath,
  isApprovedHuggingFaceHost,
  listPresentationModels,
  validateJobOptions: catalogue.validateJobOptions,
};
