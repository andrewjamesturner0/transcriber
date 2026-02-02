const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFile: () => ipcRenderer.invoke('select-file'),
  transcribe: (filePath) => ipcRenderer.invoke('transcribe', filePath),
  saveTranscript: (text) => ipcRenderer.invoke('save-transcript', text),
  onStatus: (callback) => ipcRenderer.on('transcribe-status', (_, msg) => callback(msg)),
});
