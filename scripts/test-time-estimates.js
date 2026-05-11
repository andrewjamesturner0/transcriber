#!/usr/bin/env node
/**
 * Tests for renderer/time-estimates.js
 *
 * Usage:
 *     node scripts/test-time-estimates.js
 */

const te = require('../renderer/time-estimates');

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

// --- getEstimateKey ---

console.log('getEstimateKey\n');

test('tiny.en -> tiny', () => assert(te.getEstimateKey('tiny.en') === 'tiny'));
test('tiny -> tiny', () => assert(te.getEstimateKey('tiny') === 'tiny'));
test('base.en -> base', () => assert(te.getEstimateKey('base.en') === 'base'));
test('base -> base', () => assert(te.getEstimateKey('base') === 'base'));
test('small.en -> small', () => assert(te.getEstimateKey('small.en') === 'small'));
test('small -> small', () => assert(te.getEstimateKey('small') === 'small'));
test('medium.en -> medium', () => assert(te.getEstimateKey('medium.en') === 'medium'));
test('medium -> medium', () => assert(te.getEstimateKey('medium') === 'medium'));
test('large-v3 -> large', () => assert(te.getEstimateKey('large-v3') === 'large'));
test('large-v3-turbo -> large-turbo', () => assert(te.getEstimateKey('large-v3-turbo') === 'large-turbo'));
test('large-v3-turbo-q5_0 -> large-turbo', () => assert(te.getEstimateKey('large-v3-turbo-q5_0') === 'large-turbo'));
test('large-v3-q5_0 -> large', () => assert(te.getEstimateKey('large-v3-q5_0') === 'large'));
test('small.en-tdrz -> small', () => assert(te.getEstimateKey('small.en-tdrz') === 'small'));

test('unknown -> null', () => assert(te.getEstimateKey('unknown') === null));
test('empty string -> null', () => assert(te.getEstimateKey('') === null));

// --- TIME_ESTIMATES ---

console.log('\nTIME_ESTIMATES\n');

test('all buckets have required fields', () => {
  const buckets = ['tiny', 'base', 'small', 'medium', 'large-turbo', 'large'];
  for (const key of buckets) {
    const e = te.TIME_ESTIMATES[key];
    assert(e, `missing bucket: ${key}`);
    assert(typeof e.ratio === 'string', `${key} missing ratio`);
    assert(typeof e.example === 'string', `${key} missing example`);
    assert(typeof e.quality === 'string', `${key} missing quality`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
