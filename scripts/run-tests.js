#!/usr/bin/env node
// Deterministic suites use stubs and temporary files. Tensor maths requires
// NumPy/PyTorch, but no weights, recordings or network. Runtime checks stay opt-in.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const NODE_RUNTIME_TESTS = new Set([
  'test-whisper-dtw.js',       // Real local inference assets.
  'test-renderer-dom.js',      // Launched separately with installed Electron.
  'test-electron-lifecycle.js', // Launched separately with installed Electron.
]);
const PYTHON_DETERMINISTIC = [
  ['test-diarize-contract.py'],
  ['test-align-contract.py'],
  ['test-alignment-models.py'],
  ['test-pcm-audio.py'],
];
const PYTHON_MATHS = [
  ['test-alignment-core.py'],
  ['test-pcm-audio.py', '--tensor'],
];

function main() {
  const category = process.argv[2] || 'deterministic';
  if (!['deterministic', 'maths', 'electron'].includes(category) || process.argv.length > 3) {
    console.error('Usage: node scripts/run-tests.js [deterministic|maths|electron]');
    return 1;
  }

  const python = process.env.TRANSCRIBER_TEST_PYTHON
    ? { command: process.env.TRANSCRIBER_TEST_PYTHON, args: [] }
    : process.platform === 'win32'
      ? { command: 'py', args: ['-3'] }
      : { command: 'python3', args: [] };
  const suites = [];
  if (category === 'deterministic') {
    // New pure Node checks join automatically; runtime entry points must be
    // explicitly excluded above instead of running accidentally under Node.
    for (const name of fs.readdirSync(__dirname).sort()) {
      if (/^test-.*\.js$/.test(name) && !NODE_RUNTIME_TESTS.has(name)) {
        suites.push({ command: process.execPath, args: [path.join(__dirname, name)], name });
      }
    }
  }
  if (category === 'electron') {
    for (const name of ['test-renderer-dom.js', 'test-electron-lifecycle.js']) {
      suites.push({ command: process.execPath, args: [path.join(__dirname, name)], name });
    }
  }
  const pythonSuites = category === 'maths' ? PYTHON_MATHS : category === 'deterministic' ? PYTHON_DETERMINISTIC : [];
  for (const [name, ...args] of pythonSuites) {
    suites.push({ command: python.command, args: [...python.args, path.join(__dirname, name), ...args],
      name: [name, ...args].join(' ') });
  }

  for (const suite of suites) {
    console.log(`\nRunning ${suite.name}`);
    const result = spawnSync(suite.command, suite.args, {
      cwd: path.join(__dirname, '..'), stdio: 'inherit', env: process.env,
    });
    if (result.error) {
      console.error(`Failed to launch ${suite.name}: ${result.error.message}`);
      if (suite.command === python.command) {
        console.error('Set TRANSCRIBER_TEST_PYTHON to a Python 3 interpreter path.');
      }
      return 1;
    }
    if (result.signal || result.status !== 0) {
      console.error(`Failed: ${suite.name} (${result.signal || `exit ${result.status}`})`);
      return result.status > 0 ? result.status : 1;
    }
  }
  console.log(`\n${suites.length} ${category} suites passed.`);
  return 0;
}

process.exitCode = main();
