#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, 'fixtures', 'model-validation.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed += 1;
  } else {
    console.log(`  FAIL: ${name}`);
    failed += 1;
  }
}

const taskNames = new Set(manifest.taskChoices.map((entry) => entry.task));
const requiredTasks = [
  'general-purpose',
  'fast-english',
  'small-download',
  'multilingual',
  'translation',
  'accuracy-first',
];

check('manifest has all four duration roles',
  JSON.stringify(manifest.durationRoles) === JSON.stringify(['short', '10-minute', '60-minute', '120-minute']));
check('manifest has all six task choices',
  requiredTasks.every((task) => taskNames.has(task)) && manifest.taskChoices.length === requiredTasks.length);
check('every task choice has a model, status and evidence rules',
  manifest.taskChoices.every((entry) => entry.modelId && entry.status && entry.evidenceIds.length > 0));
check('expanded new-family models have evidence rules',
  manifest.expandedModels.every((entry) => entry.family !== 'whisper' && entry.evidenceIds.length > 0));

const resultById = new Map(manifest.evidenceResults.map((result) => [result.id, result]));
const newFamilyEntries = [...manifest.taskChoices, ...manifest.expandedModels]
  .filter((entry) => entry.family !== 'whisper');

check('new-family recommendations require every evidence result to pass',
  newFamilyEntries.every((entry) => entry.status !== 'recommended'
    || entry.evidenceIds.every((id) => resultById.get(id)?.passed === true)));
check('no new-family model is recommended before local validation',
  newFamilyEntries.every((entry) => entry.status === 'candidate' || entry.status === 'experimental'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
