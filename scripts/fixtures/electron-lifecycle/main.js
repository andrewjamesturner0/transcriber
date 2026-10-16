// Actual Electron app lifetime, production main ownership and real process groups.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { spawn } = require('child_process');
const { loadMain } = require('../main-harness');
const { _runProcess } = require('../../../lib/_subprocess');
const Capabilities = require('../../../lib/capabilities');
const { createTranscriptionRunner } = require('../../../lib/transcription-runner');
const { createDiarizationSetup } = require('../../../lib/diarization-setup');
const [directory, stage, nonce, quitMode] = process.argv.slice(2);
app.setPath('userData', path.join(directory, 'user'));
fs.mkdirSync(app.getPath('userData'), { recursive: true });
const marker = path.join(directory, 'child.json');
const child = path.join(__dirname, 'child.js');
const paths = {
  getResourcePath: (name) => path.join(directory, name),
  getWhisperBinary: () => path.join(directory, 'whisper'),
  getFfmpegBinary: () => path.join(directory, 'ffmpeg'),
  makeEnvWithLibPath: () => ({ ...process.env }),
};
for (const file of ['ffmpeg', 'whisper', 'lib/align.py', 'lib/diarize.py', 'scripts/setup-diarization.py', 'models/ggml-tiny.en.bin']) {
  fs.mkdirSync(path.dirname(paths.getResourcePath(file)), { recursive: true });
  fs.writeFileSync(paths.getResourcePath(file), 'fixture');
}
function launch(command, args, options) {
  if (command === 'taskkill') return spawn(command, args, options);
  let name = command === paths.getFfmpegBinary() ? 'ffmpeg' :
    command === paths.getWhisperBinary() ? 'whisper' :
    args.some((arg) => arg.endsWith('setup-diarization.py')) ? 'setup' :
    args.some((arg) => arg.endsWith('align.py')) ? 'alignment' : 'diarization';
  if (command === 'fixture-probe') name = 'probe';
  if (command === 'fixture-download') name = 'download';
  return spawn(process.execPath, [child, name, marker, ...args], {
    ...options,
    env: { ...options.env, ELECTRON_RUN_AS_NODE: '1', TRANSCRIBER_HOLD_STAGE: stage },
  });
}
const deps = { spawn: launch, makeEnvWithLibPath: paths.makeEnvWithLibPath, log() {} };
const probes = new Capabilities({
  paths, spawn: (cmd, args, opts) => launch('fixture-probe', args, opts), fsExists: () => true,
  env: { TRANSCRIBER_PYTHON: 'fixture-probe' },
});
const caps = {
  detect: () => stage === 'probe' ? probes.detect() : Promise.resolve(),
  detectGpu: async () => {}, getActiveBackend: () => 'cpu', getDeviceIndex: () => null,
  isDtwSupported: () => false, getPythonSpawn: async () => ({ command: 'fixture-python', args: [] }),
  getPythonInfo: async () => ({ diarizationStatus: 'ready' }),
  getAlignmentInfo: async () => ({ alignmentStatus: 'ready' }),
  dispose: () => probes.dispose(),
};
let active;
let main;
app.whenReady().then(async () => {
  // Keep actual production runner cleanup and helper orchestration.
  const runner = createTranscriptionRunner({ capabilities: caps, paths, spawn: launch, log() {}, tmpDir: directory });
  const setup = createDiarizationSetup({ capabilities: caps, paths, spawn: launch, log() {} });
  main = loadMain({
    directory, electron: { app }, capabilities: caps, runner, setup,
    install: async ({ destPath, signal }) => {
      const partial = path.join(directory, 'download.part');
      fs.writeFileSync(partial, 'partial');
      try { await _runProcess('fixture-download', [], { ...deps, signal }); }
      finally { fs.rmSync(partial, { force: true }); }
      fs.writeFileSync(destPath, 'model');
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const event = { sender: { isDestroyed: () => true, send: () => { throw new Error('Destroyed sender'); } } };
  if (stage === 'setup') active = main.invoke('prepare-diarization', event, 'fixture-token', {});
  else if (stage === 'download') active = main.invoke('download-model', event, 'base');
  else if (stage !== 'probe') active = main.invoke('transcribe', event, path.join(directory, 'input.wav'), 'tiny.en', {
    diarization: true, alignment: 'forced',
  });
  if (active) active.catch(() => {});
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(marker)) {
    assert.ok(Date.now() < deadline, 'Stage never started: ' + stage);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (quitMode === 'update') {
    // The harness substitutes the updater boundary. Finish Electron after it settles.
    await main.invoke('install-update');
    assert.equal(main.events.filter((item) => item === 'install').length, 1);
    app.quit();
  } else {
    app.quit();
    app.quit();
  }
}).catch((error) => { console.error(error.stack); app.exit(1); });
app.on('will-quit', () => {
  try {
    assert.ok(main, 'Main must load before quit');
    assert.equal(fs.existsSync(path.join(directory, 'download.part')), false);
    assert.deepEqual(fs.readdirSync(directory).filter((name) => name.startsWith('transcriber-')), []);
    const log = path.join(app.getPath('userData'), 'logs/transcriber.log');
    assert.ok(fs.readFileSync(log, 'utf8').includes('Application started'));
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ nonce, passed: true, stage, electron: process.versions.electron }));
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
});
