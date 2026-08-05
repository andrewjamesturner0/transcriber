# Speaker diarization pipeline

Transcriber uses pyannote.audio for optional speaker labelling. TinyDiarize and `small.en-tdrz` are not in the current catalogue.

Pyannote is available only when the selected model has word timing validated against Transcriber's merge pipeline. The current validated set is the 12 retained Whisper models. Parakeet, Nemotron, MedASR, and other new-family entries do not gain pyannote support merely because their upstream runtime can return words. Their separate timing and speaker evidence gates must pass first.

## Pipeline

```text
normalised words or validated Whisper token timing
  + pyannote speaker segments
  -> mergeDiarizeSegments
  -> groupTokensToWords when token input is used
  -> assignWordsToSpeakers
  -> refineSpeakerBoundaries
  -> smoothSpeakerAssignments
  -> collapse and mergeShortBlocks
  -> speaker-labelled transcript
```

`lib/transcription-runner.js` runs `lib/diarize.py` on the same temporary WAV used for transcription. `lib/diarize.py` writes speaker segments to a temporary JSON file. `lib/diarize-merge.js` accepts the engine-neutral transcript detail or validated Whisper token data and returns formatted speaker-labelled text.

## Merge stages

1. `mergeDiarizeSegments` joins nearby same-speaker pyannote segments and absorbs very short segments when the same speaker appears on both sides.
2. `groupTokensToWords` converts Whisper tokens to timed words when normalised words are not already present.
3. `assignWordsToSpeakers` uses midpoint containment, overlap, then a bounded nearest-segment fallback.
4. `refineSpeakerBoundaries` snaps nearby words to pyannote speaker changes and protects genuine third-speaker clusters.
5. `smoothSpeakerAssignments` repairs isolated one- or two-word assignments without flattening longer turns.
6. `mergeShortBlocks` combines short interruptions only when both word-count and duration limits allow it.

## Configuration

The exported `DEFAULTS` object in `lib/diarize-merge.js` contains:

| Field | Default | Purpose |
| --- | ---: | --- |
| `mergeGapSec` | 0.5 | Join nearby same-speaker segments. |
| `absorbShortSegSec` | 0.3 | Absorb a very short segment between the same speaker. |
| `boundarySnapMaxDistSec` | 3.0 | Limit word-to-boundary snapping. |
| `smoothingMaxRunLen` | 2 | Limit isolated-run smoothing. |
| `shortBlockMaxWords` | 3 | Limit short-block merging by word count. |
| `shortBlockMaxDurationSec` | 2.0 | Limit short-block merging by duration. |
| `boundaryThirdSpeakerWindowSec` | 2.0 | Distinguish isolated drift from a third-speaker cluster. |
| `nearestSegMaxDistSec` | 5.0 | Bound the nearest-segment fallback. |

Tests can pass partial overrides to `mergeTranscriptWithDiarization`.

## Whisper timing and DTW fallback

The retained Whisper path asks whisper.cpp for full JSON when speaker labels are enabled. Models with a DTW preset add `--dtw` when the binary supports it. If a DTW-specific failure occurs, `lib/whisper-runner.js` retries without `--dtw` and disables DTW for later jobs in that session. The merge can fall back to coarser segment timing, but no new model is marked pyannote-compatible without validation.

## Failure behaviour

If Python is missing or pyannote fails, transcription falls back to the plain transcript and reports the diarisation failure. Cancellation stops the active local subprocess. Setup and troubleshooting are in [diarization-setup.md](diarization-setup.md).

Set `DIARIZE_DEBUG=1` to print per-stage merge diagnostics to stderr:

```bash
DIARIZE_DEBUG=1 node scripts/test-merge.js
```
