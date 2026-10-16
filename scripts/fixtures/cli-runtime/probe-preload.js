// Keep production CLI/capability code, but run harmless real probe processes.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const root = process.env.TRANSCRIBER_CLI_FIXTURE_ROOT;
const target = process.env.TRANSCRIBER_CLI_PROBE_STAGE;
const paths = require('../../../lib/paths');
const init = paths.initPaths;
paths.initPaths = () => init({ isPackaged: false, resourcesPath: root });
paths.initPaths();
for (const file of ['bin/linux/cpu/whisper-cli', 'bin/linux/vulkan/whisper-cli',
  'bin/win/cpu/whisper-cli.exe', 'bin/win/vulkan/whisper-cli.exe', 'lib/align.py', 'lib/diarize.py']) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), 'fixture');
}
process.env.TRANSCRIBER_PYTHON = 'fixture-probe-python';
const spawn = cp.spawn;
cp.spawn = (command, args, options) => {
  if (command === 'taskkill') return spawn(command, args, options);
  const stage = command.includes('whisper-cli') ? 'gpu' :
    args.includes('--version') ? 'python-version' :
    args.some((arg) => arg.endsWith('align.py')) ? 'alignment' : 'python-check';
  return spawn(process.execPath, [path.join(__dirname, 'probe.js'), root, stage, target], options);
};
// Windows cannot send a POSIX terminal-group SIGINT. Exercise the same handler
// through an IPC request there; native console behaviour remains acceptance work.
process.on('message', (message) => {
  if (message === 'fixture-interrupt') {
    process.emit('SIGINT');
    if (process.connected) process.disconnect();
  }
});
