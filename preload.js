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
});
