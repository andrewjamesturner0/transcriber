const fs = require('fs');
const path = require('path');
const [root, stage, target] = process.argv.slice(2);
if (stage === 'descendant') {
  process.on('SIGTERM', () => {});
  process.stdout.write('ready');
  setInterval(() => {}, 1000);
} else if (stage === 'gpu' && target === 'gpu-resistant') {
  const descendant = require('child_process').spawn(process.execPath, [__filename, root, 'descendant', target], { stdio: ['ignore', 'pipe', 'ignore'] });
  descendant.stdout.once('data', () => {
    fs.writeFileSync(path.join(root, 'descendant-pid'), String(descendant.pid));
    fs.appendFileSync(path.join(root, 'probe-pids'), process.pid + '\n');
  });
  process.on('SIGTERM', () => {
    fs.writeFileSync(path.join(root, 'parent-closed'), 'yes');
    process.exit(0);
  });
  setInterval(() => {}, 1000);
} else if (stage === target) {
  fs.appendFileSync(path.join(root, 'probe-pids'), process.pid + '\n');
  setInterval(() => {}, 1000);
} else if (stage === 'gpu') process.stderr.write('ggml_vulkan: 0 = Fixture GPU\n--dtw --no-flash-attn\n');
else if (stage === 'python-version') process.stdout.write('Python 3.12.9\n');
else if (stage === 'python-check') process.stdout.write(JSON.stringify({
  status: 'ready', pythonSupported: true, pyannoteSupported: true, modelReady: true,
  versions: { 'pyannote.audio': '4.0.7' }, cudaAvailable: false,
}) + '\n');
else process.stdout.write('{"status":"ready"}\n');
