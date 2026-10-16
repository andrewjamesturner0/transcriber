// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0

const path = require('path');
const nodeFs = require('fs');
const models = require('./models');

/** Own model discovery and installation without assuming an application layout. */
function createModelStore({ bundledDir, writableDir, fs = nodeFs, install } = {}) {
  if (!bundledDir && !writableDir) throw new Error('A model directory is required');
  const downloading = new Set();

  function usable(file) {
    if (!file) return false;
    try {
      const stat = fs.statSync(file);
      return stat.isFile() && stat.size > 0;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    }
  }

  function locations(id) {
    const { fileName } = models.getModel(id);
    return {
      writable: writableDir ? path.join(writableDir, fileName) : null,
      bundled: bundledDir ? path.join(bundledDir, fileName) : null,
    };
  }

  function availablePath(id) {
    const { writable, bundled } = locations(id);
    if (usable(writable)) return writable;
    if (usable(bundled)) return bundled;
    return null;
  }

  function getModelPath(id) {
    const found = availablePath(id);
    if (found) return found;
    const { writable, bundled } = locations(id);
    return writable || bundled;
  }

  function listModels() {
    return models.getCatalogue().map((model) => ({
      ...model,
      downloaded: availablePath(model.id) !== null,
    }));
  }

  async function downloadModel(id, { onProgress, signal } = {}) {
    models.getModel(id); // Validate before touching directories or the transport.
    if (signal && signal.aborted) throw new Error('Cancelled');
    if (availablePath(id)) return true;
    if (!writableDir) throw new Error('Model store is read-only');
    if (typeof install !== 'function') throw new Error('Model installer is unavailable');
    if (downloading.has(id)) throw new Error(`Already downloading model: ${id}`);

    downloading.add(id);
    try {
      const destPath = locations(id).writable;
      fs.mkdirSync(writableDir, { recursive: true });
      await install({
        url: models.getDownloadUrl(id), destPath, signal,
        onProgress: onProgress ? (progress) => onProgress({ ...progress, modelId: id }) : undefined,
      });
      if (!usable(destPath)) throw new Error('Download finished without a usable model');
      return true;
    } finally {
      downloading.delete(id);
    }
  }

  return { getModel: models.getModel, getModelPath, listModels, downloadModel };
}

module.exports = { createModelStore };
