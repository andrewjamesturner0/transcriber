#!/usr/bin/env node
/**
 * Tests for renderer/transcript-format.js
 *
 * Usage:
 *     node scripts/test-transcript-format.js
 */

const tf = require('../renderer/transcript-format');

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

// --- isPyannoteDiarized ---

console.log('isPyannoteDiarized\n');

test('positive: 2 speakers detected', () => {
  assert(tf.isPyannoteDiarized('[2 speakers detected]\n\n[Speaker 1] Hello'));
});

test('positive: 1 speaker detected', () => {
  assert(tf.isPyannoteDiarized('[1 speaker detected]\n\n[Speaker 1] Hello'));
});

test('negative: no brackets', () => {
  assert(!tf.isPyannoteDiarized('2 speakers detected in the room'));
});

test('negative: empty string', () => {
  assert(!tf.isPyannoteDiarized(''));
});

test('negative: plain text', () => {
  assert(!tf.isPyannoteDiarized('Hello world'));
});

// --- formatDiarizedOutput ---

console.log('\nformatDiarizedOutput\n');

test('pyannote text passes through unchanged', () => {
  const text = '[1 speaker detected]\n\n[Speaker 1] Hello world';
  assert(tf.formatDiarizedOutput(text) === text);
});

test('tinydiarize text strips timestamps and adds separators', () => {
  const text = '[00:00:00.000 --> 00:00:05.000]  Hello\n[SPEAKER_TURN]\n[00:00:05.000 --> 00:00:10.000]  World';
  const result = tf.formatDiarizedOutput(text);
  assert(!result.includes('[00:00:00'), 'timestamps should be stripped');
  assert(result.includes('--- Speaker Change ---'), 'should have speaker change separator');
  assert(result.includes('Hello'), 'should contain first speaker text');
  assert(result.includes('World'), 'should contain second speaker text');
});

test('plain text returns unchanged', () => {
  const text = 'Just some plain text.';
  assert(tf.formatDiarizedOutput(text) === text);
});

test('text with SPEAKER_TURN but no leading timestamps', () => {
  const text = 'Hello\n[SPEAKER_TURN]\nWorld';
  const result = tf.formatDiarizedOutput(text);
  assert(result.includes('--- Speaker Change ---'));
  assert(!result.includes('[SPEAKER_TURN]'), 'SPEAKER_TURN markers should be removed');
});

// --- parseRichTranscript ---

console.log('\nparseRichTranscript\n');

test('parses basic speaker blocks', () => {
  const text = '[2 speakers detected]\n\n[Speaker 1] Hello there\n\n[Speaker 2] Hi back';
  const result = tf.parseRichTranscript(text);
  assert(result.length === 2);
  assert(result[0].speakerNum === 1);
  assert(result[0].speakerLabel === '1');
  assert(result[0].text === 'Hello there');
  assert(result[1].speakerNum === 2);
  assert(result[1].speakerLabel === '2');
  assert(result[1].text === 'Hi back');
});

test('clamps speaker number > 8', () => {
  const text = '[1 speakers detected]\n\n[Speaker 9] Loud voice\n\n[Speaker 12] Even louder';
  const result = tf.parseRichTranscript(text);
  assert(result.length === 2);
  assert(result[0].speakerNum === 8, 'speaker 9 should clamp to 8');
  assert(result[0].speakerLabel === '9', 'label should preserve original 9');
  assert(result[1].speakerNum === 8, 'speaker 12 should clamp to 8');
  assert(result[1].speakerLabel === '12', 'label should preserve original 12');
});

test('drops empty-text blocks', () => {
  const text = '[1 speakers detected]\n\n[Speaker 1] Real text\n\n[Speaker 2]   \n\n[Speaker 3] More text';
  const result = tf.parseRichTranscript(text);
  assert(result.length === 2, 'empty block should be dropped');
});

test('ignores N speakers detected header', () => {
  const text = '[3 speakers detected]\n\n[Speaker 1] A\n\n[Speaker 2] B\n\n[Speaker 3] C';
  const result = tf.parseRichTranscript(text);
  assert(result.length === 3);
  assert(!result.some(s => s.text.includes('speakers detected')), 'header should not appear in results');
});

test('handles single speaker', () => {
  const text = '[1 speaker detected]\n\n[Speaker 1] Monologue';
  const result = tf.parseRichTranscript(text);
  assert(result.length === 1);
  assert(result[0].speakerNum === 1);
  assert(result[0].text === 'Monologue');
});

test('handles multiline speaker text', () => {
  const text = '[1 speakers detected]\n\n[Speaker 1] Line one\nLine two\nLine three';
  const result = tf.parseRichTranscript(text);
  assert(result.length === 1);
  assert(result[0].text === 'Line one\nLine two\nLine three');
});

// --- countPyannoteSpeakers ---

console.log('\ncountPyannoteSpeakers\n');

test('empty input returns zero', () => {
  const result = tf.countPyannoteSpeakers('');
  assert(result.count === 0);
  assert(result.labels.length === 0);
});

test('counts distinct speaker labels', () => {
  const text = '[Speaker 1] Hi [Speaker 2] Hello [Speaker 1] Again';
  const result = tf.countPyannoteSpeakers(text);
  assert(result.count === 2);
  assert(result.labels.includes('[Speaker 1]'));
  assert(result.labels.includes('[Speaker 2]'));
});

test('three distinct speakers', () => {
  const text = '[Speaker 1] A [Speaker 2] B [Speaker 3] C';
  const result = tf.countPyannoteSpeakers(text);
  assert(result.count === 3);
});

// --- countWhisperSpeakerTurns ---

console.log('\ncountWhisperSpeakerTurns\n');

test('counts SPEAKER_TURN occurrences', () => {
  assert(tf.countWhisperSpeakerTurns('[SPEAKER_TURN][SPEAKER_TURN]') === 2);
});

test('zero turns for plain text', () => {
  assert(tf.countWhisperSpeakerTurns('Hello world') === 0);
});

test('handles empty string', () => {
  assert(tf.countWhisperSpeakerTurns('') === 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
