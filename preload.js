// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFiles: () => ipcRenderer.invoke('select-files'),
  registerDroppedFiles: (files) => ipcRenderer.invoke('register-dropped-files', {
    filePaths: Array.from(files, (file) => webUtils.getPathForFile(file)),
  }),
  transcribe: (request) => ipcRenderer.invoke('transcribe', request),
  saveTranscript: (text) => ipcRenderer.invoke('save-transcript', text),
  getModels: () => ipcRenderer.invoke('get-models', {}),
  deriveJobOptions: (request) => ipcRenderer.invoke('derive-job-options', request),
  downloadModel: (request) => ipcRenderer.invoke('download-model', request),
  getSettings: (request = {}) => ipcRenderer.invoke('get-settings', request),
  updateSettings: (request) => ipcRenderer.invoke('update-settings', request),
  onStatus: (callback) => ipcRenderer.on('transcribe-status', (_, msg) => callback(msg)),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (_, data) => callback(data)),
  getLicenses: () => ipcRenderer.invoke('get-licenses'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getVersion: () => ipcRenderer.invoke('get-version'),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_, info) => cb(info)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', () => cb()),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  cancelTranscription: () => ipcRenderer.invoke('cancel-transcription'),
  onDiarizeStatus: (callback) => ipcRenderer.on('diarize-status', (_, data) => callback(data)),
  isDebugBuild: () => ipcRenderer.invoke('is-debug-build'),
  openLogFile: () => ipcRenderer.invoke('open-log-file'),
  openLogFolder: () => ipcRenderer.invoke('open-log-folder'),
});
