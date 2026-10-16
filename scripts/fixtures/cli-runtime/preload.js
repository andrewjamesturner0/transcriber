// Preloaded only by test-cli-pipeline.js. Keep the actual parser, model lookup,
// option validation and runners; replace machine resources and subprocesses.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const childProcess = require('child_process');
const paths = require('../../../lib/paths');

const root = process.env.TRANSCRIBER_CLI_FIXTURE_ROOT;
if (!root) throw new Error('CLI fixture root is required');

const initPaths = paths.initPaths;
paths.initPaths = () => initPaths({ isPackaged: false, resourcesPath: root });
paths.initPaths();
const tmpDir = path.join(root, 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });
os.tmpdir = () => tmpDir;

// Empty existence-check sentinels are never executed, including on Windows.
for (const file of [paths.getFfmpegBinary(), paths.getWhisperBinary('cpu'),
  paths.getResourcePath('models/ggml-tiny.en.bin'),
  paths.getResourcePath('lib/align.py'), paths.getResourcePath('lib/diarize.py')]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'fixture');
}

const whisper = {
  result: { language: 'en' },
  transcription: [{
    text: 'Hello world.', offsets: { from: 0, to: 1000 },
    tokens: [
      { text: ' Hello', offsets: { from: 0, to: 400 }, t_dtw: -1 },
      { text: ' world.', offsets: { from: 400, to: 1000 }, t_dtw: -1 },
    ],
  }],
};

function record(stage, args) {
  fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({ stage, args }) + '\n');
}

childProcess.spawn = (command, args) => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => process.nextTick(() => proc.emit('close', null));
  process.nextTick(() => {
    try {
      if (command === paths.getFfmpegBinary()) {
        record('ffmpeg', args);
        fs.writeFileSync(args[args.length - 1], 'fixture wav');
      } else if (command === paths.getWhisperBinary('cpu')) {
        record('whisper', args);
        if (args.includes('--output-json-full')) {
          fs.writeFileSync(args[args.indexOf('-of') + 1] + '.json', JSON.stringify(whisper));
        }
        proc.stdout.emit('data', Buffer.from(' Hello world.\n'));
        proc.stderr.emit('data', Buffer.from('fixture decoder log\n'));
      } else if (command === 'cli-fixture-python' && args[0] === paths.getResourcePath('lib/align.py')) {
        record('align', args);
        const input = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf8'));
        const aligned = {
          format: 'transcriber-alignment', version: 1,
          provider: { name: 'transcriber-align', version: 'fixture', language: input.language },
          segments: input.segments.map((segment) => ({
            index: segment.index, status: 'aligned', reason: null,
            words: segment.words.map((_, index) => ({
              startMs: index * 400, endMs: (index + 1) * 400, score: 0.9, quality: 'measured',
            })),
          })),
        };
        fs.writeFileSync(args[args.indexOf('--output') + 1], JSON.stringify(aligned));
        proc.stderr.emit('data', Buffer.from('{"message":"Fixture aligned words","percent":100}\n'));
      } else if (command === 'cli-fixture-python' && args[0] === paths.getResourcePath('lib/diarize.py')) {
        record('diarize', args);
        fs.writeFileSync(args[args.indexOf('--output') + 1], JSON.stringify([
          { start: 0, end: 1, speaker: 'A' },
        ]));
        proc.stderr.emit('data', Buffer.from('{"message":"Fixture found speakers","percent":100}\n'));
      } else {
        throw new Error(`Unexpected fixture subprocess: ${command}`);
      }
      proc.emit('close', 0);
    } catch (error) {
      proc.emit('error', error);
    }
  });
  return proc;
};

// Hardware and installed Python are outside this CLI-to-runner contract.
// These probes supply readiness only; they do not alter job options.
const Capabilities = require('../../../lib/capabilities');
Capabilities.prototype.detectGpu = async () => {};
Capabilities.prototype.detectDtw = async () => {};
Capabilities.prototype.getPythonInfo = async () => ({ diarizationStatus: 'ready' });
Capabilities.prototype.getAlignmentInfo = async () => ({ alignmentStatus: 'ready' });
Capabilities.prototype.getPythonSpawn = async () => ({ command: 'cli-fixture-python', args: [] });

// Keep the production transport and filesystem; replace only HTTPS responses.
const transferMode = process.env.TRANSCRIBER_CLI_TRANSFER_MODE;
if (transferMode) {
  const { PassThrough } = require('stream');
  require('https').get = (_url, callback) => {
    const request = new EventEmitter();
    request.destroy = (error) => {
      if (error) process.nextTick(() => request.emit('error', error));
    };
    process.nextTick(() => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = { 'content-length': '12' };
      callback(response);
      response.write('part');
      if (transferMode === 'reset') response.destroy(new Error('fixture connection reset'));
      else if (transferMode === 'cancel') setTimeout(() => process.emit('SIGINT'), 10);
      else response.end('ialmodel');
    });
    return request;
  };
}
