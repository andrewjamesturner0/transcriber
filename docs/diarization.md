# Speaker Diarization Pipeline

This document describes the diarization pipeline in `lib/diarize-merge.js`, the shared module used by both `main.js` and `scripts/test-merge.js` to merge whisper word-level timestamps with pyannote speaker segments.

## Pipeline Overview

```
Pyannote segments ──┐
                    ├──> mergeDiarizeSegments (stage 0)
                    │         │
Whisper full JSON ──┤         │
  groupTokensToWords (stage 1) │
                    │         │
                    ├─────────┘
                    │
                    ▼
         assignWordsToSpeakers (stage 2)
                    │
                    ▼
         refineSpeakerBoundaries (stage 3)
                    │
                    ▼
         smoothSpeakerAssignments (stage 4)
                    │
                    ▼
         collapse + mergeShortBlocks
                    │
                    ▼
         formatted speaker-labeled transcript
```

## Stage 0: mergeDiarizeSegments

Pre-processes pyannote output before alignment in a single left-to-right pass:

1. Same-speaker segments separated by less than `mergeGapSec` (default 0.5s) are merged.
2. Segments shorter than `absorbShortSegSec` (default 0.3s) flanked by the same speaker are absorbed.

## Stage 1: groupTokensToWords

Converts whisper's per-token output into words with accumulated start/end times. Tokens with no whitespace prefix are appended to the current word (handles sub-word tokens and punctuation). Tokens starting with `[_` (special whisper tokens) are skipped. Tokens without offset data inherit the previous token's end time.

## Stage 2: assignWordsToSpeakers

Each word is assigned to the pyannote speaker whose segment **contains the word's temporal midpoint**. If no segment contains the midpoint, the word is assigned to the speaker with the greatest temporal overlap. If there is no overlap (word falls in a pyannote gap), the nearest segment within 5s is used as a last-resort fallback.

## Stage 3: refineSpeakerBoundaries

Snaps word-level speaker transitions to pyannote's segment boundaries. This runs *before* smoothing so that boundary words are placed on the correct side of each speaker change before smoothing looks for isolated misassignments.

Uses a **time-window approach**: for each pyannote speaker change, words within `boundarySnapMaxDistSec` of the boundary are reassigned to the speaker on their side of the boundary.

Words touched by refinement are flagged so that smoothing does not undo the boundary corrections.

**Third-speaker words at 2-speaker boundaries**: when a word at an A->B boundary is labelled with a third speaker C, the algorithm checks whether C appears elsewhere within `boundaryThirdSpeakerWindowSec` (default 2.0s) around the boundary. If C is isolated (no other C labels nearby), it is likely DTW drift and gets reassigned to A or B. If C appears in a cluster, it is probably a genuine 3-way conversation and is preserved.

## Stage 4: smoothSpeakerAssignments

Corrects remaining isolated misassignments after boundary refinement. If a run of 1 or 2 consecutive words is flanked by the same speaker on both sides, and the run contains only different speakers, the entire run is reassigned to the flanking speaker.

Runs are processed by increasing length (1, 2) and repeated to convergence before moving to the next length. The default maximum run length is 2 to avoid flattening short genuine interjections (e.g. "It's about 10%."). For recordings where longer misassignment runs are expected, override `smoothingMaxRunLen`.

Segment-level fallback entries (`isSegLevel`) are excluded from smoothing since they represent whole sentences.

## Post-collapse: mergeShortBlocks

After collapsing consecutive same-speaker words into utterance blocks, a short-block merge catches remaining fragmentation. A block is merged into its predecessor when:

1. It is flanked by the same speaker on both sides.
2. It has `shortBlockMaxWords` or fewer words (default 3).
3. Its duration is `shortBlockMaxDurationSec` or less (default 2.0s).

The duration check prevents long interjections (e.g. a 3-word utterance lasting 4 seconds) from being absorbed. Blocks without timing data (segment-level fallback) use word-count-only logic.

## Config Reference

All tunables live in a single `DEFAULTS` object exported from `lib/diarize-merge.js`. Tests can pass partial overrides to `mergeTranscriptWithDiarization(json, segs, overrides)`.

| Field | Default | Stage | Description |
|-------|---------|-------|-------------|
| `mergeGapSec` | 0.5 | 0 | Gap below which adjacent same-speaker pyannote segments are merged |
| `absorbShortSegSec` | 0.3 | 0 | Maximum duration of a segment to absorb when flanked by same speaker |
| `boundarySnapMaxDistSec` | 3.0 | 3 | Maximum distance (seconds) between pyannote boundary and a word for snapping |
| `smoothingMaxRunLen` | 2 | 4 | Maximum consecutive-run length corrected by smoothing |
| `shortBlockMaxWords` | 3 | collapse | Maximum word count for short-block merge eligibility |
| `shortBlockMaxDurationSec` | 2.0 | collapse | Maximum duration (seconds) for short-block merge eligibility |
| `boundaryThirdSpeakerWindowSec` | 2.0 | 3 | Window for checking whether a third-speaker label at a 2-speaker boundary is isolated |
| `nearestSegMaxDistSec` | 5.0 | 2 | Maximum distance from a pyannote segment for the nearest-segment last-resort fallback |

## Debug Logging

Set the environment variable `DIARIZE_DEBUG=1` to emit per-stage diff logs:

```bash
DIARIZE_DEBUG=1 node scripts/test-merge.js
```

Each stage logs: input count, output count, and count of items changed. The output goes to stderr via `console.error`. From `main.js`, logs appear in the application log file.

## DTW Fallback

The pipeline requires whisper token timestamps for word-level alignment. These come from DTW (Dynamic Time Warping) alignment, enabled via `--dtw <preset>` on the whisper-cli command line.

**Detection**: at app startup, `lib/capabilities.js` probes the whisper binary with `--help` to detect whether `--dtw` is supported. The result is cached.

**Fallback**: if DTW fails at runtime (unknown preset, unrecognised flag, or DTW not built), the app retries without `--dtw` and disables DTW for subsequent runs. When DTW is unavailable, the pipeline falls back to segment-level alignment (each whisper segment assigned as a whole).

**Manual test**: to verify the fallback, rename a `dtwPreset` to a bogus value in `lib/models.js` and re-run a diarization. The app should log the fallback and produce a segment-level transcript.

## Pyannote Unavailability

If pyannote is not installed or diarization fails, the app produces a plain (non-speaker-labeled) transcript. This is handled in `lib/transcription-runner.js`, not in the merge module.

See `README.md` for pyannote installation instructions.
