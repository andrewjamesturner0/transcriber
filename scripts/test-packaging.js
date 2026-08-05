#!/usr/bin/env node
/**
 * Packaging-config consistency check.
 *
 * Verifies that every require('./lib/...') in main.js targets a real file
 * AND that electron-builder.yml does not put the entire lib/ directory
 * in extraResources (which would move JS modules outside the asar, causing
 * "cannot find module" errors in packaged builds).
 *
 * Catches the class of bug where lib JS files are accidentally excluded
 * from the asar.
 *
 * Usage:
 *     node scripts/test-packaging.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// --- Helpers ---

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name} -- ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// --- Extract require('./lib/...') calls from main.js ---

function findLibRequires(sourcePath) {
  const src = fs.readFileSync(sourcePath, 'utf-8');
  const re = /require\s*\(\s*['"](\.[\/\\]lib[\/\\][^'"]+)['"]\s*\)/g;
  const modules = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    modules.push(m[1]);
  }
  return modules;
}

// --- Parse extraResources from electron-builder.yml ---

function parseExtraResources(yamlPath) {
  // Simple regex-based parse to avoid needing a YAML library.
  // Collects all "- from:" values under top-level extraResources.
  const src = fs.readFileSync(yamlPath, 'utf-8');
  const patterns = [];

  // Find the top-level extraResources block: from "extraResources:"
  // to the next top-level key (a word at column 0, not indented).
  const blockRe = /^extraResources:\n([\s\S]*?)(?=^\w+:)/m;
  const match = src.match(blockRe);
  if (match) {
    const block = match[1];
    const fromRe = /^\s*- from:\s*(.+)$/gm;
    let fm;
    while ((fm = fromRe.exec(block)) !== null) {
      patterns.push(fm[1].replace(/['"]/g, '').trim());
    }
  }

  return patterns;
}

function parseModelExtraResourceFilters(yamlPath) {
  const lines = fs.readFileSync(yamlPath, 'utf-8').split(/\r?\n/);
  const resources = [];
  let inTopLevelExtraResources = false;
  let current = null;
  let inFilter = false;

  for (const line of lines) {
    if (!inTopLevelExtraResources) {
      if (line === 'extraResources:') inTopLevelExtraResources = true;
      continue;
    }
    if (/^\S/.test(line)) break;

    const fromMatch = line.match(/^  - from:\s*(.+)$/);
    if (fromMatch) {
      current = {
        from: fromMatch[1].replace(/['"]/g, '').trim(),
        filters: [],
      };
      resources.push(current);
      inFilter = false;
      continue;
    }
    if (!current) continue;
    if (/^    filter:\s*$/.test(line)) {
      inFilter = true;
      continue;
    }
    const filterMatch = inFilter && line.match(/^      -\s*(.+)$/);
    if (filterMatch) {
      current.filters.push(filterMatch[1].replace(/['"]/g, '').trim());
    } else if (/^    \S/.test(line)) {
      inFilter = false;
    }
  }

  return resources
    .filter(resource => resource.from === 'models/' || resource.from === 'models')
    .map(resource => resource.filters);
}

function libPatternIsRisky(patterns) {
  // A pattern like "lib/" or "lib/**" would move all lib files out of the asar.
  return patterns.some(p => {
    return p === 'lib/' || p === 'lib' || p === 'lib/**' || p === 'lib/**/*';
  });
}

// --- Tests ---

console.log('Packaging-config tests\n');

test('all requires in main.js resolve to existing files', () => {
  const mainJs = path.join(ROOT, 'main.js');
  const modules = findLibRequires(mainJs);

  assert(modules.length > 0, 'should find at least one lib require');

  for (const mod of modules) {
    const resolved = path.resolve(path.dirname(mainJs), mod);
    // Node require resolution: try exact, then with .js extension
    const candidates = [resolved, resolved + '.js'];
    const found = candidates.some(c => fs.existsSync(c));
    assert(found, `module ${mod} not found on disk (tried ${candidates.join(', ')})`);
  }
  console.log(`    (checked ${modules.length} lib modules: ${modules.join(', ')})`);
});

test('lib/ is NOT in top-level extraResources as a directory wildcard', () => {
  const yamlPath = path.join(ROOT, 'electron-builder.yml');
  const patterns = parseExtraResources(yamlPath);
  assert(!libPatternIsRisky(patterns),
    `lib/ (or equivalent) found in extraResources patterns: ${patterns.join(', ')}. ` +
    'JS modules would be moved outside the asar, causing "cannot find module" errors.');
});

test('lib/diarize.py IS in extraResources (needed for Python subprocess)', () => {
  const yamlPath = path.join(ROOT, 'electron-builder.yml');
  const patterns = parseExtraResources(yamlPath);
  const hasPy = patterns.some(p => {
    const cleaned = p.replace(/['"]/g, '');
    return cleaned === 'lib/diarize.py' || cleaned.endsWith('/diarize.py');
  });
  assert(hasPy, 'lib/diarize.py must be in extraResources for Python spawn to access it');
});

test('only tiny.en is bundled as the packaged model fallback', () => {
  const yamlPath = path.join(ROOT, 'electron-builder.yml');
  const modelResourceFilters = parseModelExtraResourceFilters(yamlPath);
  assert(modelResourceFilters.length === 1,
    `expected exactly one models/ extraResource, found ${modelResourceFilters.length}`);
  const filters = modelResourceFilters[0];
  assert(!filters.some(filter => /[*?\[\]{}]/.test(filter)),
    `models/ extraResource must not use wildcard filters: ${filters.join(', ')}`);
  assert(filters.length === 1 && filters[0] === 'ggml-tiny.en.bin',
    `models/ extraResource must include only ggml-tiny.en.bin, found: ${filters.join(', ')}`);
});

test('app.asar uses an explicit production file allowlist', () => {
  const yaml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  for (const included of [
    'main.js',
    'preload.js',
    'package.json',
    'lib/**/*',
    'renderer/**/*',
    'assets/**/*',
    'worker/**/*',
  ]) {
    assert(yaml.includes(`- ${included}`), `${included} must be included in app.asar`);
  }
  for (const privatePath of [
    '.agent-docs',
    '.build-whisper',
    'models/**/*',
    'bin/**/*',
  ]) {
    assert(!yaml.includes(`- ${privatePath}`), `${privatePath} must not be included in app.asar`);
  }
});

test('all lib JS files required by main.js are NOT individually in extraResources', () => {
  const mainJs = path.join(ROOT, 'main.js');
  const modules = findLibRequires(mainJs);
  const yamlPath = path.join(ROOT, 'electron-builder.yml');
  const patterns = parseExtraResources(yamlPath);

  for (const mod of modules) {
    const cleaned = mod.replace(/^\.\//, ''); // ./lib/foo -> lib/foo
    const jsFile = cleaned + '.js';
    const isExcluded = patterns.some(p => {
      const c = p.replace(/['"]/g, '');
      return c === cleaned || c === jsFile || c === cleaned + '.js';
    });
    assert(!isExcluded,
      `${mod} is required from main.js but also listed in extraResources. ` +
      'Move it inside the asar by removing the extraResources entry.');
  }
});

test('transcribe.cpp binding and both target native packages are exactly pinned', () => {
  const deps = require(path.join(ROOT, 'deps.json')).transcribeCpp;
  const manifest = require(path.join(ROOT, 'package.json'));
  const lock = require(path.join(ROOT, 'package-lock.json'));
  assert(manifest.engines.node === '>=22', 'development Node requirement must be >=22');
  assert(manifest.dependencies['transcribe-cpp'] === deps.version, 'binding must be pinned exactly');
  assert(manifest.dependencies.koffi === deps.koffi.version, 'koffi must be pinned exactly');
  for (const target of ['linux-x64', 'win32-x64']) {
    const spec = deps[target];
    assert(spec.integrity.startsWith('sha512-'), `${target} integrity is missing`);
    const entry = lock.packages[`node_modules/${spec.package}`];
    assert(entry && entry.version === deps.version, `${spec.package} is missing from the lockfile`);
    assert(entry.integrity === spec.integrity, `${spec.package} lockfile integrity differs from deps.json`);
  }
  const binding = lock.packages['node_modules/transcribe-cpp'];
  assert(binding.integrity === deps.binding.integrity, 'binding lockfile integrity differs from deps.json');
});

test('worker and native dependencies are unpacked from ASAR', () => {
  const yaml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  for (const required of [
    'worker/**/*',
    'node_modules/transcribe-cpp/**/*',
    'node_modules/koffi/**/*',
    'node_modules/@koromix/koffi-*/**/*',
    'node_modules/@transcribe-cpp/**/*',
  ]) {
    assert(yaml.includes(required), `${required} is missing from asarUnpack`);
  }
});

test('packaged worker path resolves beside unpacked native dependencies', () => {
  const paths = require(path.join(ROOT, 'lib', 'paths'));
  paths.initPaths({ isPackaged: true, resourcesPath: path.join('C:', 'Transcriber', 'resources') });
  const worker = paths.getTranscribeWorkerPath().replace(/\\/g, '/');
  assert(worker.endsWith('resources/app.asar.unpacked/worker/transcribe-worker.mjs'), `unexpected worker path: ${worker}`);
  paths.initPaths({ isPackaged: false, resourcesPath: ROOT });
});

test('packaged model downloads use writable storage with bundled fallback', () => {
  const temp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'transcriber-path-test-'));
  const resources = path.join(temp, 'resources');
  const writableModels = path.join(temp, 'user-data', 'models');
  const bundledModels = path.join(resources, 'models');
  fs.mkdirSync(writableModels, { recursive: true });
  fs.mkdirSync(bundledModels, { recursive: true });
  const paths = require(path.join(ROOT, 'lib', 'paths'));
  const models = require(path.join(ROOT, 'lib', 'models'));
  paths.initPaths({ isPackaged: true, resourcesPath: resources, modelDirectory: writableModels });
  try {
    const fileName = models.getModel('tiny.en').fileName;
    const bundled = path.join(bundledModels, fileName);
    const writable = path.join(writableModels, fileName);
    fs.writeFileSync(bundled, 'bundled');
    assert(models.getModelPath('tiny.en') === bundled, 'bundled model should be the read-only fallback');
    assert(models.getModelDownloadPath('tiny.en') === writable, 'downloads should target writable user data');
    fs.writeFileSync(writable, 'downloaded');
    assert(models.getModelPath('tiny.en') === writable, 'writable downloaded model should take priority');
  } finally {
    paths.initPaths({ isPackaged: false, resourcesPath: ROOT });
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('standalone CLI model directory is stable and user writable', () => {
  const paths = require(path.join(ROOT, 'lib', 'paths'));
  const linux = paths.getStandaloneModelDirectory({ platform: 'linux', env: {}, homedir: '/home/tester' });
  const windows = paths.getStandaloneModelDirectory({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }, homedir: 'C:\\Users\\tester' });
  assert(linux === path.join('/home/tester', '.local', 'share', 'transcriber', 'models'), `unexpected Linux path: ${linux}`);
  assert(windows === path.join('C:\\Users\\tester\\AppData\\Local', 'Transcriber', 'models'), `unexpected Windows path: ${windows}`);
});

test('Electron main injects writable model storage and shuts down the runner', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert(main.includes("modelDirectory: path.join(app.getPath('userData'), 'models')"), 'main should inject a user-data model directory');
  assert(main.includes("app.on('before-quit'"), 'main should handle application shutdown');
  assert(main.includes('transcriptionRunner.shutdown()'), 'main should close the transcription worker');
});

test('installed host runtime and real worker pass a shutdown smoke check', () => {
  if (process.platform !== 'linux' || process.arch !== 'x64') return;
  const verify = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-transcribe-runtime.js'), 'linux-x64'], {
    encoding: 'utf8',
  });
  assert(verify.status === 0, verify.stderr || verify.stdout);
  const worker = spawnSync(process.execPath, [path.join(ROOT, 'worker', 'transcribe-worker.mjs')], {
    input: '{"id":"smoke","op":"shutdown"}\n',
    encoding: 'utf8',
    timeout: 10000,
  });
  assert(worker.status === 0, worker.stderr || `worker exited ${worker.status}`);
  const reply = JSON.parse(worker.stdout.trim());
  assert(reply.ok === true && reply.result.shutdown === true, 'worker did not acknowledge shutdown');
});

test('runtime and every offered model have packaged notice data', () => {
  const yaml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  assert(yaml.includes('- from: NOTICE'), 'NOTICE must be an extra resource');
  assert(yaml.includes('- from: THIRD-PARTY-LICENSES.json'), 'in-app licences must be an extra resource');
  const notice = fs.readFileSync(path.join(ROOT, 'NOTICE'), 'utf8');
  const licences = require(path.join(ROOT, 'THIRD-PARTY-LICENSES.json'));
  const searchable = `${notice}\n${licences.map((entry) => `${entry.name}\n${entry.text}`).join('\n')}`;
  assert(searchable.includes('transcribe.cpp'), 'transcribe.cpp notice is missing');
  assert(searchable.includes('Koffi'), 'Koffi notice is missing');
  const ffmpegNotice = licences.find((entry) => entry.name === 'FFmpeg');
  assert(ffmpegNotice && ffmpegNotice.license === 'GPLv3', 'bundled FFmpeg must be identified as GPLv3');
  assert(!/LGPL/i.test(`${notice}\n${ffmpegNotice.text}`), 'bundled FFmpeg notice must not claim LGPL');
  assert(ffmpegNotice.text.includes('https://www.gyan.dev/ffmpeg/builds/'), 'Windows FFmpeg build source is missing');
  assert(ffmpegNotice.text.includes('https://johnvansickle.com/ffmpeg/'), 'Linux FFmpeg build source is missing');
  const whisperNotice = licences.find((entry) => entry.name === 'OpenAI Whisper');
  assert(whisperNotice && whisperNotice.text.includes("tiny.en is bundled as Transcriber's fallback"), 'tiny.en bundled fallback notice is missing');
  assert(whisperNotice.description.includes('11 optional downloads'), 'optional Whisper download count is wrong');
  const catalogue = require(path.join(ROOT, 'lib', 'model-catalogue')).listCatalogueModels();
  for (const model of catalogue) {
    assert(searchable.includes(model.id), `notice data is missing model ${model.id}`);
  }
  const externalIds = catalogue.filter((model) => model.family !== 'whisper').map((model) => model.id);
  const inAppModelIds = licences.filter((entry) => entry.modelId).map((entry) => entry.modelId);
  for (const id of externalIds) assert(inAppModelIds.includes(id), `in-app licence is missing ${id}`);
});

test('Windows CI verifies CPU and Vulkan packaging inputs before building', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert(workflow.includes('Verify Windows packaging inputs'), 'Windows packaging input check is missing');
  for (const required of [
    'bin\\win\\cpu\\whisper-cli.exe',
    'bin\\win\\vulkan\\whisper-cli.exe',
    'bin\\win\\vulkan\\ggml-vulkan.dll',
    'bin\\win\\ffmpeg.exe',
    'models\\ggml-tiny.en.bin',
  ]) {
    assert(workflow.includes(required), `Windows CI does not require ${required}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
