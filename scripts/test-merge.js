#!/usr/bin/env node
/**
 * Test 3: Transcript + diarization merge logic.
 *
 * Tests mergeTranscriptWithDiarization() with sample data — no Python,
 * no models, no HF token needed. Runs instantly.
 *
 * Usage:
 *     node scripts/test-merge.js
 */

// --- Copy of mergeTranscriptWithDiarization from main.js ---
function mergeTranscriptWithDiarization(whisperSegments, diarizeSegments) {
  const speakerIds = [...new Set(diarizeSegments.map((s) => s.speaker))];
  const speakerLabels = {};
  speakerIds.forEach((id, i) => { speakerLabels[id] = `Speaker ${i + 1}`; });

  const labeled = whisperSegments.map((ws) => {
    let bestSpeaker = null;
    let bestOverlap = 0;

    for (const ds of diarizeSegments) {
      const overlapStart = Math.max(ws.start, ds.start);
      const overlapEnd = Math.min(ws.end, ds.end);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestSpeaker = ds.speaker;
      }
    }

    return {
      speaker: bestSpeaker ? speakerLabels[bestSpeaker] : 'Unknown',
      text: ws.text.trim(),
    };
  });

  const collapsed = [];
  for (const seg of labeled) {
    if (!seg.text) continue;
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.speaker === seg.speaker) {
      prev.text += ' ' + seg.text;
    } else {
      collapsed.push({ ...seg });
    }
  }

  const speakerCount = speakerIds.length;
  const header = `[${speakerCount} speaker${speakerCount !== 1 ? 's' : ''} detected]\n\n`;
  const body = collapsed.map((s) => `[${s.speaker}] ${s.text}`).join('\n\n');
  return header + body;
}

// --- Test cases ---
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name} — ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

console.log('Testing mergeTranscriptWithDiarization\n');

test('basic two-speaker merge', () => {
  const whisper = [
    { start: 0.0, end: 3.0, text: ' Hello, how are you?' },
    { start: 3.0, end: 6.0, text: ' I am fine, thanks.' },
    { start: 6.0, end: 9.0, text: ' Great to hear.' },
  ];
  const diarize = [
    { start: 0.0, end: 3.5, speaker: 'SPEAKER_00' },
    { start: 3.5, end: 7.0, speaker: 'SPEAKER_01' },
    { start: 7.0, end: 9.0, speaker: 'SPEAKER_00' },
  ];
  const result = mergeTranscriptWithDiarization(whisper, diarize);
  assert(result.includes('[2 speakers detected]'), 'should detect 2 speakers');
  assert(result.includes('[Speaker 1] Hello, how are you?'), 'first segment speaker 1');
  assert(result.includes('[Speaker 2] I am fine, thanks.'), 'second segment speaker 2');
  assert(result.includes('[Speaker 1] Great to hear.'), 'third segment speaker 1');
});

test('consecutive same-speaker segments collapse', () => {
  const whisper = [
    { start: 0.0, end: 2.0, text: ' Part one.' },
    { start: 2.0, end: 4.0, text: ' Part two.' },
    { start: 4.0, end: 6.0, text: ' Different speaker.' },
  ];
  const diarize = [
    { start: 0.0, end: 4.5, speaker: 'SPEAKER_00' },
    { start: 4.5, end: 6.0, speaker: 'SPEAKER_01' },
  ];
  const result = mergeTranscriptWithDiarization(whisper, diarize);
  assert(result.includes('[Speaker 1] Part one. Part two.'), 'should collapse consecutive same-speaker');
  assert(result.includes('[Speaker 2] Different speaker.'), 'different speaker separate');
});

test('single speaker', () => {
  const whisper = [
    { start: 0.0, end: 5.0, text: ' Just me talking.' },
  ];
  const diarize = [
    { start: 0.0, end: 5.0, speaker: 'SPEAKER_00' },
  ];
  const result = mergeTranscriptWithDiarization(whisper, diarize);
  assert(result.includes('[1 speaker detected]'), 'singular "speaker"');
});

test('empty segments skipped', () => {
  const whisper = [
    { start: 0.0, end: 2.0, text: ' Hello.' },
    { start: 2.0, end: 3.0, text: '  ' },
    { start: 3.0, end: 5.0, text: ' World.' },
  ];
  const diarize = [
    { start: 0.0, end: 5.0, speaker: 'SPEAKER_00' },
  ];
  const result = mergeTranscriptWithDiarization(whisper, diarize);
  assert(!result.includes('[]'), 'no empty brackets');
  assert(result.includes('Hello. World.'), 'empty segment collapsed');
});

test('no diarize overlap gives Unknown', () => {
  const whisper = [
    { start: 10.0, end: 15.0, text: ' Ghost text.' },
  ];
  const diarize = [
    { start: 0.0, end: 5.0, speaker: 'SPEAKER_00' },
  ];
  const result = mergeTranscriptWithDiarization(whisper, diarize);
  assert(result.includes('[Unknown]'), 'should label as Unknown');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
