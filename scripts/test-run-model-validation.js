#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runValidation, checksum, transcriptMetrics } = require('./run-model-validation');

async function main() {
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transcriber-validation-test-'));
  const modelPath = path.join(temporaryRoot, 'fake-model.bin');
  const sourcePath = path.join(temporaryRoot, 'source.wav');
  const tempFilesPath = path.join(temporaryRoot, 'runtime-temp');
  const manifestPath = path.join(temporaryRoot, 'manifest.json');
  const outputPath = path.join(temporaryRoot, 'result.json');
  const workerPath = path.resolve(__dirname, 'fixtures', 'fake-transcribe-worker.js');
  await fs.promises.mkdir(tempFilesPath);
  await fs.promises.writeFile(modelPath, 'credential-free fake model\n');
  await fs.promises.writeFile(sourcePath, 'credential-free fake audio\n');
  const modelSha = (await checksum(modelPath)).actual;
  const sourceSha = (await checksum(sourcePath)).actual;
  const nodeSha = (await checksum(process.execPath)).actual;
  const workerSha = (await checksum(workerPath)).actual;
  const modelId = 'parakeet-tdt-ctc-110m';
  const manifest = {
    schemaVersion: 1,
    runtime: {
      command: process.execPath,
      args: [workerPath],
      env: { FAKE_VALIDATION_SLOW_JOB: 'transcribe-2' },
      files: [
        { path: process.execPath, sha256: nodeSha },
        { path: workerPath, sha256: workerSha },
      ],
    },
    models: [{ id: modelId, path: modelPath }],
    fixtures: [{
      id: 'credential-free-short',
      sourceId: 'generated-test-data',
      durationRole: 'short',
      audioPath: sourcePath,
      sha256: sourceSha,
      referenceTranscript: 'ok',
      tempDirectories: [tempFilesPath],
      annotations: { missingSpans: [], repeatedSpans: [], inventedSpans: [] },
    }],
    runs: [{
      id: 'fake-parakeet-short',
      fixtureId: 'credential-free-short',
      modelId,
      evidenceIds: ['parakeet-english-omission'],
      assessment: { passed: true, notes: 'Fake protocol self-test only.' },
      cancellation: { enabled: true, cancelAfterMs: 25, maxLatencyMs: 2000 },
    }],
  };
  await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const fakeModel = {
    id: modelId,
    displayName: 'Fake Parakeet',
    revision: 'fake-revision',
    sha256: modelSha,
    runtimeAvailable: true,
    timestampLevel: 'word',
    backends: ['cpu', 'vulkan'],
  };
  const { result, outputPath: writtenPath } = await runValidation({
    manifestPath,
    outputPath,
    catalogueResolver: (id) => {
      assert.strictEqual(id, modelId);
      return fakeModel;
    },
  });

  assert.strictEqual(writtenPath, outputPath);
  assert.strictEqual(result.runs.length, 1);
  assert.strictEqual(result.runs[0].ok, true);
  assert.strictEqual(result.runs[0].backend, 'cpu');
  assert.strictEqual(result.runs[0].checksums.source.matches, true);
  assert.strictEqual(result.runs[0].checksums.model.matches, true);
  assert.strictEqual(result.runs[0].metrics.wordErrorRate, 0);
  assert.strictEqual(result.runs[0].cancellation.passed, true);
  assert.strictEqual(result.runs[0].annotations.missingPromotionAnnotation, false);
  assert.strictEqual(result.leakChecks.workerCounts.afterShutdown, 0);
  assert.strictEqual(result.leakChecks.workerCounts.leaked, false);
  assert.strictEqual(result.leakChecks.temporaryFileCounts.leaked, false);
  assert.strictEqual(result.promotion.performed, false);
  assert.strictEqual(result.promotion.catalogueChanged, false);
  assert.deepStrictEqual(
    result.evidence[modelId].missingEvidenceIds,
    ['parakeet-word-timing', 'parakeet-long-audio', 'parakeet-package-matrix'],
  );
  assert.strictEqual(JSON.parse(await fs.promises.readFile(outputPath, 'utf8')).schemaVersion, 1);
  assert.deepStrictEqual(transcriptMetrics('one two', 'one too').wordErrorRate, 0.5);
  await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  process.stdout.write('model validation harness self-test passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
