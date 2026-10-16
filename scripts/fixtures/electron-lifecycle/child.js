// Harmless process tree used by the real Electron shutdown checks.
const fs = require('fs');
const { spawn } = require('child_process');
const [stage, marker, ...args] = process.argv.slice(2);
if (stage === 'descendant') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (process.env.TRANSCRIBER_HOLD_STAGE === stage) {
  const descendant = spawn(process.execPath, [__filename, 'descendant', marker], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore',
  });
  process.on('SIGTERM', () => {});
  fs.appendFileSync(marker, JSON.stringify({ stage, pid: process.pid, descendant: descendant.pid }) + '\n');
  setInterval(() => {}, 1000);
} else {
  const option = (flag) => args[args.indexOf(flag) + 1];
  if (stage === 'ffmpeg') fs.writeFileSync(args.at(-1), 'wav fixture');
  if (stage === 'whisper') {
    fs.writeFileSync(option('-of') + '.json', JSON.stringify({
      result: { language: 'en' },
      transcription: [{ text: 'hello', offsets: { from: 0, to: 1000 },
        tokens: [{ text: ' hello', offsets: { from: 0, to: 1000 }, t_dtw: -1 }] }],
    }));
    process.stdout.write('hello');
  }
  if (stage === 'alignment') {
    const input = JSON.parse(fs.readFileSync(option('--input'), 'utf8'));
    fs.writeFileSync(option('--output'), JSON.stringify({
      format: 'transcriber-alignment', version: 1,
      provider: { name: 'transcriber-align', version: 'fixture', language: 'en' },
      segments: input.segments.map((segment) => ({
        index: segment.index, status: 'aligned', reason: null,
        words: segment.words.map(() => ({ startMs: 0, endMs: 1000, score: 0.9, quality: 'measured' })),
      })),
    }));
  }
  if (stage === 'diarization') fs.writeFileSync(option('--output'), JSON.stringify([{ start: 0, end: 1, speaker: 'A' }]));
}
