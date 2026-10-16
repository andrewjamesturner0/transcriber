// Harmless process-tree fixture. It only waits for test-owned termination.
const { spawn } = require('child_process');
if (process.argv[2] === 'child') {
  process.on('SIGTERM', () => {});
  process.stdout.write(`child:${process.pid}\n`);
} else {
  process.on('SIGTERM', () => process.exit(0));
  spawn(process.execPath, [__filename, 'child'], { stdio: ['ignore', 'inherit', 'inherit'] });
}
setInterval(() => {}, 1000);
