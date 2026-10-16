// Load production main.js with only platform boundaries replaced.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { EventEmitter } = require('events');

function loadMain({ directory, electron, capabilities, runner, setup, install, logger } = {}) {
  const root = path.resolve(__dirname, '../..');
  const handlers = new Map();
  const events = [];
  const app = electron ? electron.app : new EventEmitter();
  if (!electron) {
    app.isPackaged = false;
    app.getPath = () => directory;
    app.getVersion = () => '1.0.0';
    app.whenReady = () => Promise.resolve();
    app.quit = () => {
      let prevented = false;
      app.emit('before-quit', { preventDefault: () => { prevented = true; } });
      if (!prevented) events.push('quit');
    };
  }
  const windows = [];
  class Window {
    constructor() {
      this.destroyed = false;
      const contents = { isDestroyed: () => this.destroyed, send() {} };
      Object.defineProperty(this, 'webContents', { get: () => {
        if (this.destroyed) throw new Error('Object has been destroyed');
        return contents;
      } });
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    loadFile() {}
    setMenuBarVisibility() {}
  }
  const platform = {
    app, BrowserWindow: Window,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: {}, shell: {},
  };
  const updater = new EventEmitter();
  updater.checkForUpdates = () => Promise.resolve();
  updater.quitAndInstall = () => events.push('install');
  const requireMain = createRequire(path.join(root, 'main.js'));
  const replacements = {
    electron: platform,
    'electron-updater': { autoUpdater: updater },
    './lib/capabilities': function () { return capabilities; },
  };
  if (runner) replacements['./lib/transcription-runner'] = {
    createTranscriptionRunner: (deps) => { events.push({ runnerStore: deps.modelStore }); return runner; },
  };
  if (setup) replacements['./lib/diarization-setup'] = { createDiarizationSetup: () => setup };
  if (install) replacements['./lib/model-download'] = { createModelDownloader: () => install };
  if (logger) replacements['./lib/logging'] = { createLogger: () => logger };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), {
    require: (name) => replacements[name] || requireMain(name),
    __dirname: root, process, console, AbortController,
  }, { filename: path.join(root, 'main.js') });
  return { app, handlers, events, updater, windows, invoke: (name, ...args) => handlers.get(name)(...args) };
}
module.exports = { loadMain };
