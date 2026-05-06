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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
