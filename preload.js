// Transcriber — local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFile: () => ipcRenderer.invoke('select-file'),
  selectFiles: () => ipcRenderer.invoke('select-files'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  transcribe: (filePath, modelId) => ipcRenderer.invoke('transcribe', filePath, modelId),
  saveTranscript: (text) => ipcRenderer.invoke('save-transcript', text),
  getModels: () => ipcRenderer.invoke('get-models'),
  downloadModel: (modelId) => ipcRenderer.invoke('download-model', modelId),
  onStatus: (callback) => ipcRenderer.on('transcribe-status', (_, msg) => callback(msg)),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (_, data) => callback(data)),
  getLicenses: () => ipcRenderer.invoke('get-licenses'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getVersion: () => ipcRenderer.invoke('get-version'),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_, info) => cb(info)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', () => cb()),
  installUpdate: () => ipcRenderer.invoke('install-update'),
});
