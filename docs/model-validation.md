# Model validation

This document defines the evidence needed before a model can be described as
recommended in Transcriber. Catalogue inclusion is not a recommendation.

## Initial task choices

| Task | Initial model | Initial status | Promotion evidence |
| --- | --- | --- | --- |
| General purpose | Whisper Small | Recommended baseline | Existing Whisper path plus the full release corpus |
| Fast English | Parakeet TDT-CTC 110M | Candidate | English omission, timing, long-audio and package gates |
| Small download | Moonshine Tiny | Candidate | English omission and long-audio gates; text-only limits remain visible |
| Multilingual | Nemotron 3.5 ASR Streaming 0.6B | Candidate | Language, timing, memory, licence and long-audio gates |
| Translation | Whisper Large v3 | Recommended baseline | Existing Whisper translation path plus translation fixtures |
| Accuracy first | Whisper Large v3 | Recommended baseline | Existing Whisper path plus memory and long-audio fixtures |

Qwen3-ASR 0.6B, Canary 180M Flash, MedASR and MOSS
Transcribe-Diarize start as Experimental. Their catalogue entries stay visible,
but they are not promoted without the evidence IDs in
`scripts/fixtures/model-validation.json`.

## Corpus

The checked-in manifest contains recipes and source records, not recordings.
Audio must be fetched or assembled outside the repository. The initial public
sources are LibriSpeech and Google FLEURS, both published under CC BY 4.0. Keep
the original recording and speaker IDs in each local run record so results can
be traced back to their source.

The corpus uses four recording lengths:

- Short: one natural utterance between 8 and 15 seconds, used for text, timing,
  language and cancellation smoke checks.
- 10 minute: a deterministic concatenation with silence, long pauses, names,
  numbers and repeated phrases, used for ordinary omission and repetition
  checks.
- 60 minute: a deterministic multi-speaker concatenation, used for long-audio,
  peak-memory, cancellation and temporary-file checks.
- 120 minute: the 60-minute recipe repeated with a second speaker ordering,
  used for worker reuse, leak and sustained-memory checks.

The English set must include British, American and non-native accents. The
multilingual set must include English, German, Spanish and French, plus at
least one language outside Canary's supported translation set. Speaker timing
uses separate two-speaker and four-speaker recipes with overlap and quick turn
changes. MedASR also gets 399-second and 401-second derived files to test its
declared limit. Synthetic tone and silence may test exact timing, but may not
replace natural speech in a promotion result.

## Required measurements

Every run records the application commit, model ID, immutable model revision,
file checksum, runtime checksum, platform, backend and fixture ID. It then
records:

- selected and detected language;
- reference word and character error rates where a transcript exists;
- missing, repeated and invented spans, including start and end times;
- segment and word timing coverage without invented timestamps;
- wall time, model load time, peak RAM and peak GPU memory;
- cancellation latency and whether useful work stops;
- worker and temporary-file counts before and after the run;
- the result of CPU retry after a forced Vulkan failure;
- pyannote speaker-turn comparison for models separately marked as having
  validated word timing; and
- a human licence and attribution review tied to the exact revision.

## Promotion rules

A new-family task choice may be marked Recommended only when every evidence ID
listed for that choice exists in the machine-readable result set and has
`passed: true`. Required gates include:

- no known silent omission or material invented span in the release corpus;
- no unexplained truncation in the 10, 60 or 120 minute role;
- cancellation stops useful work within 2 seconds;
- no worker or temporary-file leak after the 120 minute role;
- clean CPU execution and controlled Vulkan-to-CPU recovery on packaged Windows
  x64 and Linux x64 builds;
- no network connection during transcription after assets are installed;
- memory remains within the guidance displayed for the model; and
- licence, source and required attribution have been reviewed.

Word timing and pyannote compatibility are separate capabilities. A model can
pass transcription promotion while pyannote remains disabled. Pyannote is
enabled only when the two-speaker and four-speaker timing evidence IDs pass and
speaker-turn quality is no worse than the retained Whisper workflow.

Any failed or missing evidence keeps a model Candidate or Experimental. A
failed candidate may remain in the wider catalogue, be demoted or be omitted;
it does not block other model families.

## Running the contract check

Run:

```bash
node scripts/test-model-promotion.js
```

Real-model runs will add machine-readable results outside the fast test suite.
Private or confidential recordings must never be used or committed.
