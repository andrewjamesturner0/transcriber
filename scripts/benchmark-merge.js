#!/usr/bin/env node
// Synthetic assignment benchmark. Inputs use the public pretimed-word contract.
// No recordings/models, I/O or fixture generation inside the measured section.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { assignSpeakers, normaliseSpeakerTimeline } = require('../lib/diarize-merge');

function workload(name, wordCount, turnCount, { overlap = false, nonmonotonic = false } = {}) {
  const durationMs = turnCount * 2000;
  const regular = Array.from({ length: turnCount }, (_, index) => ({
    start: index * 2, end: index * 2 + 1.75, speaker: `S${index % 4}`,
  }));
  const exclusive = overlap ? regular.map(interval => ({ ...interval })) : null;
  if (overlap) {
    for (let index = 0; index < turnCount; index += 5) regular.push({
      start: index * 2 + 0.3, end: index * 2 + 0.9, speaker: `S${(index + 1) % 4}`,
    });
  }
  // Shuffle time slots, keeping text/index in recognised order. This deliberately
  // invalidates a moving cursor's assumption that word times only go forward.
  const slots = Array.from({ length: wordCount }, (_, index) => index);
  if (nonmonotonic) {
    let state = 0x12345678;
    for (let index = slots.length - 1; index > 0; index--) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const other = state % (index + 1);
      [slots[index], slots[other]] = [slots[other], slots[index]];
    }
  }
  const words = slots.map((slot, index) => {
    const missing = index > 0 && index % 211 === 0;
    const startMs = missing ? null : Math.round(slot * durationMs / wordCount);
    const endMs = missing ? null : startMs + (index % 97 === 0 ? 0 : 220);
    const dtw = !missing && index % 23 === 0;
    return {
      index, segmentIndex: Math.floor(index / 25), text: `word${index}`,
      startMs, endMs, anchorMs: dtw ? startMs : null,
      timingSource: missing ? 'none' : dtw ? 'dtw' : 'forced',
      timingQuality: missing ? 'missing' : dtw ? 'anchor' : 'measured',
      timingFallback: null,
    };
  });
  for (const [index, word] of words.entries()) {
    assert.equal(word.index, index);
    assert(word.startMs === null || (Number.isFinite(word.startMs) && word.startMs >= 0 && word.endMs >= word.startMs));
  }
  assert.equal(normaliseSpeakerTimeline(regular).dropped, 0);
  const diarization = exclusive ? { regular, exclusive } : regular;
  return { name, input: { words }, diarization, counts: {
    words: wordCount, regularIntervals: regular.length, exclusiveIntervals: exclusive ? exclusive.length : 0,
    durationSeconds: durationMs / 1000, nonmonotonic,
  } };
}

function makeWorkloads() {
  return [
    workload('small', 120, 24),
    workload('gate', 15000, 5000),
    workload('long', 10800, 1800),
    workload('overlapping', 10800, 1800, { overlap: true }),
    workload('nonmonotonic', 10800, 1800, { nonmonotonic: true }),
  ];
}
function quantile(sorted, fraction) {
  const offset = (sorted.length - 1) * fraction;
  const lower = Math.floor(offset);
  return sorted[lower] + (sorted[Math.ceil(offset)] - sorted[lower]) * (offset - lower);
}
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  return { medianMs: median, minMs: sorted[0], maxMs: sorted.at(-1), iqrMs: iqr, iqrFraction: iqr / median, samplesMs: samples };
}
function runBenchmark({ runs = 7, warmups = 3, compareReference = false } = {}) {
  const workloads = makeWorkloads();
  const reference = compareReference ? require('./fixtures/diarize-merge-reference').assignSpeakers : null;
  const algorithms = reference ? [['candidate', assignSpeakers], ['reference', reference]] : [['candidate', assignSpeakers]];
  const samples = new Map(workloads.map(item => [item.name, Object.fromEntries(algorithms.map(([name]) => [name, []]))]));
  const signatures = new Map();
  for (let round = -warmups; round < runs; round++) {
    // Rotate workload order and alternate reference/candidate order within each
    // pair so one implementation is not always favoured by CPU drift.
    const offset = (round + warmups) % workloads.length;
    for (let index = 0; index < workloads.length; index++) {
      const item = workloads[(index + offset) % workloads.length];
      const order = (round + warmups + index) % 2 ? [...algorithms].reverse() : algorithms;
      let firstResult;
      for (const [name, assign] of order) {
        const start = performance.now();
        const result = assign(item.input, item.diarization);
        const elapsed = performance.now() - start;
        assert.equal(result.words.length, item.counts.words);
        if (firstResult) assert.deepStrictEqual(result, firstResult, `${item.name} differs from frozen reference`);
        firstResult = result;
        const signature = crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex');
        if (signatures.has(item.name)) assert.equal(signature, signatures.get(item.name), `${item.name} output changed between runs`);
        signatures.set(item.name, signature);
        if (round >= 0) samples.get(item.name)[name].push(elapsed);
      }
    }
  }
  const results = workloads.map(item => {
    const candidate = stats(samples.get(item.name).candidate);
    const baseline = reference ? stats(samples.get(item.name).reference) : null;
    return { name: item.name, ...item.counts, outputSha256: signatures.get(item.name), ...candidate,
      ...(baseline ? { reference: baseline, speedup: baseline.medianMs / candidate.medianMs,
        savedMs: baseline.medianMs - candidate.medianMs } : {}) };
  });
  const gate = results.find(item => item.name === 'gate');
  const small = results.find(item => item.name === 'small');
  const comparison = reference ? {
    parity: true,
    baselineGateMet: gate.reference.medianMs > 250,
    speedupPassed: gate.speedup >= 2,
    smallRegressionPassed: small.medianMs - small.reference.medianMs <= Math.max(5, small.reference.medianMs * 0.1),
    stableBaseline: gate.reference.iqrFraction <= 0.2,
  } : null;
  if (comparison) {
    comparison.accepted = Object.values(comparison).every(value => value === true);
    // Candidate variation is reported separately. The approved gate requires a
    // stable baseline and >=2x median benefit, not a new candidate IQR limit.
    comparison.candidateIqrFraction = gate.iqrFraction;
    comparison.conservativeSampleSpeedup = gate.reference.minMs / gate.maxMs;
  }
  return {
    environment: { node: process.version, platform: process.platform, architecture: process.arch,
      os: os.release(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
      mergeSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../lib/diarize-merge.js'))).digest('hex') },
    runs, warmups, ...(comparison ? { comparison } : {}), workloads: results,
  };
}
function main(args) {
  let runs = 7;
  let compareReference = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--compare-reference') compareReference = true;
    else if (args[index] === '--runs' && /^\d+$/.test(args[index + 1] || '')) runs = Number(args[++index]);
    else throw new Error('Usage: benchmark-merge.js [--runs 1..99] [--compare-reference]');
  }
  if (runs < 1 || runs > 99) throw new Error('--runs must be between 1 and 99');
  const result = runBenchmark({ runs, compareReference });
  console.log(JSON.stringify(result, null, 2));
  if (result.comparison && !result.comparison.accepted) process.exitCode = 1;
}
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
module.exports = { makeWorkloads, runBenchmark };
