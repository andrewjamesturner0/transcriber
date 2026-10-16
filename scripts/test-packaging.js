#!/usr/bin/env node
/**
 * Packaging-config consistency check.
 *
 * Verifies that every require('./lib/...') in main.js targets a real file
 * AND that electron-builder.yml does not put the entire lib/ directory
 * in extraResources (which would move JS modules outside the asar, causing
 * "cannot find module" errors in packaged builds).
 *
 * Catches JS files accidentally excluded from the asar and private local
 * files accidentally included in it.
 *
 * Usage:
 *     node scripts/test-packaging.js
 */

const fs = require('fs');
const path = require('path');

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

test('Python helpers and requirements are packaged individually', () => {
  const patterns = parseExtraResources(path.join(ROOT, 'electron-builder.yml'));
  const want = ['lib/diarize.py', 'lib/requirements.txt', 'lib/align.py',
    'lib/alignment_models.py', 'lib/alignment_core.py', 'lib/pcm_audio.py',
    'scripts/setup-diarization.py'];
  for (const w of want) {
    assert(patterns.includes(w), `${w} must be in extraResources; got ${patterns.join(', ')}`);
    assert(fs.existsSync(path.join(ROOT, w)), `${w} must exist`);
  }
  assert(!patterns.some((p) => p === 'scripts/' || p === 'scripts'), 'scripts/ must not be packaged wholesale');
});

test('every Python helper sibling and cited notice is packaged', () => {
  const patterns = parseExtraResources(path.join(ROOT, 'electron-builder.yml'));
  const siblings = ['lib/align.py', 'lib/diarize.py'].flatMap((file) => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf-8');
    const loaded = [...source.matchAll(/_sibling\("([a-z_]+)"\)/g)].map((m) => `lib/${m[1]}.py`);
    assert(loaded.includes('lib/pcm_audio.py'), `${file} must use the shared PCM decoder`);
    return loaded;
  });
  assert(siblings.includes('lib/alignment_models.py') && siblings.includes('lib/alignment_core.py'),
    'alignment siblings must be packaged');
  const cited = [];
  for (const file of ['lib/alignment_core.py', 'lib/alignment_models.py']) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf-8');
    cited.push(...[...src.matchAll(/(lib\/third_party\/[A-Za-z0-9_.-]+\.txt)/g)].map((m) => m[1]));
  }
  assert(cited.length >= 2, 'alignment_core.py must cite its upstream notice files');
  for (const file of [...new Set([...siblings, ...cited])]) {
    assert(fs.existsSync(path.join(ROOT, file)), `${file} must exist`);
    assert(patterns.includes(file), `${file} must be in extraResources; got ${patterns.join(', ')}`);
  }
  for (const [file, holder] of [['lib/third_party/whisperx-LICENSE.txt', 'Copyright (c) 2024, Max Bain'],
    ['lib/third_party/torchaudio-LICENSE.txt', 'Copyright (c) 2017 Facebook Inc. (Soumith Chintala)']]) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf-8');
    assert(text.startsWith('BSD 2-Clause License') && text.includes(holder), `${file} must keep its notice`);
    assert(text.includes('THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"'),
      `${file} must keep the disclaimer`);
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

test('credentials and private working data are excluded from app files', () => {
  const src = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf-8');
  const block = src.match(/^files:\n([\s\S]*?)(?=^\w+:)/m);
  assert(block, 'files exclusions must be explicit; gitignore does not protect packaged files');
  const patterns = [...block[1].matchAll(/^\s*-\s*["']([^"']+)["']/gm)].map(m => m[1]);
  const included = patterns.filter(p => !p.startsWith('!'));
  const excluded = patterns.filter(p => p.startsWith('!')).map(p => p.slice(1));
  const selected = file => included.some(pattern => path.matchesGlob(file, pattern)) &&
    !excluded.some(pattern => path.matchesGlob(file, pattern));
  for (const file of ['.env', '.env.local', 'nested/.env', '.agents/envs/python',
    '.agents/docs/private.md', 'Examples/recording.wav', 'Examples/reference.txt', '.build-whisper/samples/audio.wav',
    '.build-vulkan/libwhisper.so', 'scratch-recording.wav']) {
    assert(!selected(file), `${file} would enter the app archive`);
  }
  for (const file of ['main.js', 'preload.js', 'lib/align.py', 'lib/transcription-runner.js', 'renderer/index.html']) {
    assert(selected(file), `${file} must remain available to package`);
  }
});

test('bundled fonts retain their full licence and copyright notices', () => {
  const licenses = JSON.parse(fs.readFileSync(path.join(ROOT, 'THIRD-PARTY-LICENSES.json'), 'utf-8'));
  for (const [name, file] of [['DM Sans', 'OFL-DM-Sans.txt'], ['DM Mono', 'OFL-DM-Mono.txt']]) {
    const text = fs.readFileSync(path.join(ROOT, 'renderer/fonts', file), 'utf-8');
    assert(text.includes(`The ${name} Project Authors`), `${name} copyright notice missing`);
    assert(text.includes('SIL OPEN FONT LICENSE Version 1.1'), `${name} licence missing`);
    assert(text.includes('PERMISSION & CONDITIONS') && text.includes('DISCLAIMER'), `${name} licence is incomplete`);
    const entry = licenses.find(lic => lic.name === name);
    assert(entry && entry.text === text, `${name} in-app notice must retain the bundled licence`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
