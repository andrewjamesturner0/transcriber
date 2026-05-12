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
const paths = require('./paths');

// ---------------------------------------------------------------------------
// Model definitions
// ---------------------------------------------------------------------------

const MODELS = [
  { id: 'tiny.en',            fileName: 'ggml-tiny.en.bin',            label: 'Tiny (English)',              size: '75 MB',   dtwPreset: 'tiny.en' },
  { id: 'tiny',               fileName: 'ggml-tiny.bin',               label: 'Tiny (Multilingual)',         size: '75 MB',   dtwPreset: 'tiny' },
  { id: 'base.en',            fileName: 'ggml-base.en.bin',            label: 'Base (English)',              size: '142 MB',  dtwPreset: 'base.en' },
  { id: 'base',               fileName: 'ggml-base.bin',               label: 'Base (Multilingual)',         size: '142 MB',  dtwPreset: 'base' },
  { id: 'small.en',           fileName: 'ggml-small.en.bin',           label: 'Small (English)',             size: '466 MB',  dtwPreset: 'small.en' },
  { id: 'small',              fileName: 'ggml-small.bin',              label: 'Small (Multilingual)',        size: '466 MB',  dtwPreset: 'small' },
  { id: 'small.en-tdrz',      fileName: 'ggml-small.en-tdrz.bin',      label: 'Small (English) + Speaker ID', size: '488 MB',  tdrz: true, hfRepo: 'akashmjn/tinydiarize-whisper.cpp' },
  { id: 'medium.en',          fileName: 'ggml-medium.en.bin',          label: 'Medium (English)',            size: '1.5 GB',  dtwPreset: 'medium.en' },
  { id: 'medium',             fileName: 'ggml-medium.bin',             label: 'Medium (Multilingual)',       size: '1.5 GB',  dtwPreset: 'medium' },
  { id: 'large-v3',           fileName: 'ggml-large-v3.bin',           label: 'Large v3 (Multilingual)',     size: '3.1 GB',  dtwPreset: 'large.v3' },
  { id: 'large-v3-turbo',     fileName: 'ggml-large-v3-turbo.bin',     label: 'Large v3 Turbo (Multilingual)', size: '1.6 GB', dtwPreset: 'large.v3.turbo' },
  { id: 'large-v3-turbo-q5_0',fileName: 'ggml-large-v3-turbo-q5_0.bin',label: 'Large v3 Turbo Q5 (Multilingual)', size: '574 MB', dtwPreset: 'large.v3.turbo' },
  { id: 'large-v3-q5_0',      fileName: 'ggml-large-v3-q5_0.bin',      label: 'Large v3 Q5 (Multilingual)',  size: '1.1 GB',  dtwPreset: 'large.v3' },
];

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
  const model = MODELS.find((m) => m.id === id);
  if (!model) throw new Error(`Unknown model: ${id}`);
  return model;
}

/**
 * Return the absolute filesystem path to a model's .bin file.
 * @param {string} id
 * @returns {string}
 */
function getModelPath(id) {
  const model = getModel(id);
  return paths.getResourcePath(path.join('models', model.fileName));
}

/**
 * Return the Hugging Face download URL for a model.
 * @param {string} id
 * @returns {string}
 */
function getDownloadUrl(id) {
  const model = getModel(id);
  const repo = model.hfRepo || 'ggerganov/whisper.cpp';
  return `https://huggingface.co/${repo}/resolve/main/${model.fileName}`;
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
function downloadModel(modelId, destPath, onProgress) {
  if (fs.existsSync(destPath)) return Promise.resolve(true);

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const url = getDownloadUrl(modelId);
  const tmpDest = destPath + '.download';

  return new Promise((resolve, reject) => {
    const download = (downloadUrl) => {
      https.get(downloadUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return download(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }
        const total = parseInt(res.headers['content-length'], 10) || 0;
        let received = 0;
        const file = fs.createWriteStream(tmpDest);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total > 0 && onProgress) {
            onProgress({
              modelId,
              percent: Math.round((received / total) * 100),
              received,
              total,
            });
          }
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            try {
              fs.renameSync(tmpDest, destPath);
              resolve(true);
            } catch (err) {
              reject(err);
            }
          });
        });
        file.on('error', (err) => {
          try { fs.unlinkSync(tmpDest); } catch (_) {}
          reject(err);
        });
      }).on('error', reject);
    };
    download(url);
  });
}

module.exports = {
  listModels,
  getModel,
  getModelPath,
  getDownloadUrl,
  downloadModel,
};
