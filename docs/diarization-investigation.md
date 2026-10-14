# Diarisation investigation, 2026-10-14

There are concrete reasons to reopen this case. The current pipeline silently
disables DTW, ignores the separate DTW timing field even when it is populated,
and can erase real speaker turns with perfectly accurate input times. The
earlier explanation that the timestamp resolution was insufficient is therefore
incomplete. Fixing these problems should establish a fair baseline before we
judge the remaining limits of Whisper or pyannote.

This records the original investigation, before production fixes. The implemented pipeline is documented in [diarization.md](diarization.md); measured results and missing evidence are in [diarization-evaluation.md](diarization-evaluation.md). The observations below describe the original checkout, not the current implementation.
Three GPT-6 Astra agents independently examined timestamp handling, speaker
merging, and current tooling; their findings were checked against source and
small reproducible examples.

## Scope and evidence

- Checkout: `master`, `a08e386`, initially clean.
- Dependency target: whisper.cpp `v1.9.2` in `deps.json`.
- The installed development libraries identify as `libwhisper.so.1.8.4`;
  local source is `.build-whisper`, commit `7668414`. These are not evidence of
  a packaged v1.9.2 runtime test. The relevant behaviour was separately checked
  against the official v1.9.2 source.
- Existing local assets include tiny.en, small.en and medium.en models and the
  public JFK sample in the Whisper source checkout.
- Follow-up after the user's pointer: `Examples/` also contains
  `more_or_less_could_europe_use_its.mp3` and its gold-standard transcript.
  This pair was missed during initial discovery. The audio lasts 544.7575
  seconds; the reference has 30 speaker-labelled turns across four speaker
  IDs plus an Unknown intro, and no timestamps. It supports a real
  speaker-attributed text benchmark immediately; timing metrics need manual
  annotations. The malformed `[pp3 speakers detected]` header must not
  override the four actual speaker labels. The revised implementation plan
  uses this pair first and preserves the ignored source files.
- Python 3.12 is available, but the system interpreter has no pyannote, torch,
  WhisperX or faster-whisper installation. No live pyannote accuracy test was
  possible in that interpreter.
- The machine has an NVIDIA RTX 3050 Ti Laptop GPU with 4 GB VRAM. Future GPU
  experiments should run transcription, alignment and diarisation sequentially
  and measure memory use rather than assume all models fit together.

`docs/lessons.md` describes newer playground work that is absent on this branch.
The current code still has the older 13-model catalogue and TinyDiarize entry.
This review does not recommend restoring or improving TinyDiarize.

## What actually happens

```text
Original media
  -> FFmpeg: 16 kHz mono PCM WAV
  -> whisper-cli: full JSON, requested DTW
  -> pyannote: regular speaker-diarization-3.1 timeline
  -> merge speaker segments, sometimes deleting short turns
  -> group Whisper token offsets into words
  -> assign by midpoint, overlap, or nearest speaker
  -> rewrite labels near speaker changes
  -> smooth short runs
  -> merge short transcript blocks, sometimes deleting real replies
  -> formatted text
```

Both estimators receive the same WAV: `lib/transcription-runner.js:144-170`.
There is no separate clock rate in this orchestration. Timing disagreement is
an estimation problem unless a specific offset or resampling bug is shown.
Adding decimal places cannot repair an estimated word that lands on the wrong
side of a speaker change.

## Confirmed problems

### 1. DTW is silently disabled by default flash attention

`lib/whisper-runner.js:37-42` requests `--dtw <preset>` without disabling flash
attention. Whisper defaults to flash attention and disables DTW when both are
requested. It logs a warning but completes successfully, so the retry code at
`lib/whisper-runner.js:120-132` never runs. The capability probe only checks for
the flag in help output (`lib/capabilities.js:321-337`).

A CPU test with the bundled JFK sample and tiny.en produced:

| Invocation | Text tokens with offsets | Valid DTW anchors | Outcome |
| --- | ---: | ---: | --- |
| Full JSON, no DTW | 23 | 0 | Success |
| Full JSON, `--dtw tiny.en` | 23 | 0 | Success; warning; DTW disabled |
| Full JSON, `--dtw tiny.en --no-flash-attn` | 23 | 23 | Success; DTW enabled |

The ordinary offsets were unchanged across these runs. This is a plumbing
experiment on single-speaker public audio, not a speaker accuracy benchmark.

The official pinned source confirms both the
[default flash-attention setting](https://github.com/ggml-org/whisper.cpp/blob/v1.9.2/examples/cli/cli.cpp)
and the [DTW incompatibility](https://github.com/ggml-org/whisper.cpp/blob/v1.9.2/src/whisper.cpp).

### 2. The merge never reads DTW output

`groupTokensToWords` reads only `token.offsets.from/to`
(`lib/diarize-merge.js:105-129`). Whisper exports the ordinary token interval
and `t_dtw` separately. Changing valid DTW anchors has no effect on the current
merge.

`t_dtw` is an experimental token anchor, not a measured start/end interval.
Its unit is 10 ms; convert to milliseconds with `t_dtw * 10`. The DTW path uses
a 20 ms frame grid. Reject `-1`, missing and non-finite values; retain zero as
a valid time. Constructing word intervals from neighbouring anchors requires
an explicit, evaluated policy. Blindly using an anchor as both start and end,
or claiming it measures the complete word duration, would be misleading.
See the pinned [token definition](https://github.com/ggml-org/whisper.cpp/blob/v1.9.2/include/whisper.h)
and [DTW implementation](https://github.com/ggml-org/whisper.cpp/blob/v1.9.2/src/whisper.cpp).

The older engine-neutral work in commits `176d065` and `4255ca3` can provide a
word/segment representation on the playground branch. It does not solve this
issue: its Whisper normalisation still consumes offsets rather than `t_dtw`.

### 3. Cleanup erases correctly detected short turns

Two independent stages do this:

- `mergeDiarizeSegments`, `lib/diarize-merge.js:78-82`, absorbs a turn shorter
  than 300 ms when the surrounding speaker labels match.
- `mergeShortBlocks`, `lib/diarize-merge.js:333-363`, absorbs an A/B/A middle
  block of up to three words lasting up to two seconds. Earlier protection
  from speaker-change refinement is lost during collapse, so it does not
  prevent this final rewrite.

With exact input times for A saying "Ready?", B saying "Yes.", and A saying
"Continue.", the default output is:

```text
[2 speakers detected]

[Speaker 1] Ready? Yes.

[Speaker 1] Continue.
```

Disabling only short-block merging restores the 600 ms reply. A 200 ms reply
also requires disabling short-segment absorption. These thresholds have been
deliberate attempts to suppress fragmentation, but the perfect-time examples
justify reopening that choice. Short duration alone does not prove an error.

### 4. Overlapping speaker segments are treated as sequential turns

Midpoint assignment picks the first containing segment
(`lib/diarize-merge.js:149-154`). Refinement treats adjacent entries in the
sorted segment list as transitions (`:210-221`), even when one is nested
inside another.

For A speaking from 0-10 seconds and B from 2-3 seconds, an A-only word at
4-4.5 seconds starts correctly assigned to A and is then changed to B.
Refinement invents an A-to-B transition at 2 seconds but misses A continuing
after B stops. Better word timing alone cannot fix this interpretation.

### 5. Timing quality and fallback are not validated

The presence of any non-null offset is enough to select word processing
(`lib/diarize-merge.js:399-418`). Negative, reversed and otherwise implausible
times are not rejected. A token at -10 ms can override valid 4-5 second
segment times and assign its text to the wrong speaker.

Also, `--output-json-full` enables ordinary token timestamps even without DTW.
The existing documentation that DTW absence necessarily produces segment-level
fallback is wrong. Fallback depends on output contents, not simply the flag.
See the pinned [CLI timestamp setup](https://github.com/ggml-org/whisper.cpp/blob/v1.9.2/examples/cli/cli.cpp).

Unknown labels are not durable either. A word more than five seconds from all
speaker segments initially receives Unknown, but smoothing can assign it to
the surrounding speaker despite the distance limit. A sentence-level fallback
cannot recover a change of speaker inside that sentence.

## Current tooling options

| Option | What it addresses | Assessment |
| --- | --- | --- |
| Fix DTW invocation and consume validated anchors | Existing timing plumbing failures | First experiment; small to medium effort, high confidence in the defects, unmeasured accuracy gain |
| Preserve real short turns and Unknown labels | Destructive cleanup | First implementation candidate; small to medium effort, high confidence from perfect-time reproductions |
| Community-1 with an exclusive timeline for transcript assignment | Speaker counting and sequential interpretation of overlap | Strong next candidate; medium effort, high confidence in availability, recording-specific benefit needs testing |
| Optional forced alignment after whisper.cpp | Word times that still drift after the plumbing fixes | Most direct next timing experiment; medium to large effort, additional model and Python dependencies |
| Replace the entire transcription engine | Broader ASR changes | Larger experiment that mixes transcription and alignment effects; unnecessary for testing the above |

### Community-1 is available but not used here

`lib/diarize.py:49-52` loads `speaker-diarization-3.1`; mentioning Community-1
in licence instructions does not select it. The script extracts regular
`speaker_diarization` (`:115-121`) and never requests an exclusive timeline.

[Community-1](https://huggingface.co/pyannote/speaker-diarization-community-1)
runs locally, reports improved results on most listed benchmarks, and returns
`exclusive_speaker_diarization` alongside regular diarisation. Use the
exclusive timeline for a transcript that must assign one speaker at each
time; retain the regular timeline for overlap evidence and evaluation.
Exclusive output does not separate mixed voices or recover words omitted by
the recogniser. Upstream benchmark improvements are not local proof.

Treat the upgrade as a tested Python dependency set. The
[pyannote 4.0.7 requirements](https://pypi.org/pypi/pyannote.audio/4.0.7/json)
require Python 3.10 or later and a newer torch/torchaudio stack. The repo's
`pyannote.audio>=3.1` leaves incompatible generations open, while its loader
uses the newer `token=` argument. Update version detection, setup instructions,
loading and output handling together. Retain the waveform loader that avoids
file-decoder problems on Windows.

An experiment can start with pyannote 4.0.7 and
[WhisperX 3.8.6](https://pypi.org/pypi/whisperx/3.8.6/json), then resolve and
record the complete environment. Their requirements intersect at torch and
torchaudio 2.8.x and TorchCodec 0.7.x. This is a dependency comparison, not a
locally tested installation. Pyannote 3.1 used `use_auth_token=` rather than
`token=`; retaining 3.x support would require handling that explicitly.

To keep the documented local-only behaviour, explicitly disable pyannote
metrics before import (`PYANNOTE_METRICS_ENABLED=0`), pre-download required
assets during setup, and test cached/local loading offline. Current
[telemetry configuration](https://github.com/pyannote/pyannote-audio/blob/4.0.7/src/pyannote/audio/telemetry/config.yaml)
enables metrics by default.

### Add alignment without replacing whisper.cpp

Keep the chosen Whisper transcript and run a local model to match those words
back to the audio. Feed its word intervals into the same speaker assignment
step. This isolates timing improvement from changes in recognised text.

[WhisperX](https://github.com/m-bain/whisperX) provides this alignment stage.
Its [alignment function](https://github.com/m-bain/whisperX/blob/main/whisperx/alignment.py)
accepts existing segment text and times, so a Python helper can align
whisper.cpp output without loading another Whisper recogniser. This still adds
WhisperX and its dependencies if used directly. A smaller extracted aligner is
another option, with its own maintenance cost.

Evaluate missing word times, numbers, names, punctuation, language support,
segment padding and transcript errors. Alignment cannot recover a word the
transcript omitted. WhisperX also documents limitations for overlap and
diarisation; switching to its full pipeline is not a word-perfect guarantee.
Recent WhisperX releases improved wildcard alignment and interpolation, so
test dates and numbers instead of assuming they always lack timings. Preserve
the distinction between an acoustic match and an interpolated estimate.
Its standard diarisation extraction needs checking rather than assuming it
uses exclusive output. stable-ts is not a preferred new dependency: its
[repository](https://github.com/jianfch/stable-ts) is archived and development
is paused.

Stereo should be a separate experiment when recording channels correspond to
different people. The current FFmpeg conversion always downmixes to mono,
discarding that information. Do not assume arbitrary stereo files provide
speaker channels.

Two further local tools deserve separate experiments after this baseline:
[Qwen3-ForcedAligner-0.6B](https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B-hf)
for matching existing text to audio, and
[Nemotron 3 Diarization](https://huggingface.co/nvidia/Nemotron-3-Diarization)
for speaker activity detection. Neither was run here. Their advertised timing
resolution and upstream scores do not establish better word attribution in
this application, and their dependency and Windows runtime costs need review.

## Proposed experiments and evaluation

1. Preserve a baseline from a small, fixed set of representative recordings.
   Hand-label speaker changes and the words around them, including "yes",
   "right" and other short replies, interruption, overlap and long gaps.
2. Evaluate cleanup changes alone with the same text, times and raw pyannote
   output. This measures whether the merge itself destroys good evidence.
3. Evaluate actual DTW separately: disable flash attention, validate populated
   anchors, and compare ordinary offsets against DTW-derived word times.
4. Hold transcript and alignment fixed while comparing pyannote 3.1, regular
   Community-1 and exclusive Community-1 output.
5. Hold recognised text and diarisation fixed while comparing ordinary times,
   corrected DTW and forced alignment.
6. Combine the winners, then check setup, cancellation, offline operation,
   CPU/Vulkan transcription and Python CPU/CUDA operation on supported systems.

Measure speaker accuracy on matched words, wrong-speaker words near changes,
short-reply retention, unknown/ambiguous coverage, word-time error and runtime.
Map arbitrary speaker IDs consistently before scoring. Report time-based
diarisation error separately from word speaker error, and score overlapped
speech separately from the exclusive transcript. Review a held-out set so
thresholds do not merely fit the examples used to choose them.

Keep structured word assignments and their timing source before formatting.
Currently the merge returns only a string and the optional JSON contains raw
inputs plus that string (`lib/transcription-runner.js:172-175`), making it hard
to see which stage changed a particular word. A deeper merge module should
own timing validation and speaker assignment, returning evidence that both
formatting and evaluation can use.

## Checks completed

- [x] Traced the current pipeline and earlier relevant merge history.
- [x] Checked the pinned Whisper source and installed development behaviour.
- [x] Reproduced seven merge/timing failures without audio or credentials.
- [x] Ran existing merge tests: 51 passed.
- [x] Ran Whisper runner tests: 12 passed.
- [x] Ran transcription runner tests: 13 passed.
- [x] Ran capability tests: 18 passed.
- [x] Checked current primary tooling documentation and source.
- [x] Recorded recommended experiments and their limits.

Run the saved reproductions with:

```bash
node scripts/investigate-diarization.js
```

The script asserts the existing defective behaviour, not the desired outcome.
It is a diagnostic record and will need updating or replacing with regression
tests once fixes change that behaviour. Existing tests passing does not prove
speaker accuracy: some assert that short turns are absorbed, and the boundary
tests inject wrong labels without moving word times across the true change.
The Python pipeline script requires a Hugging Face token and its default
input is synthetic tones; it is an installation smoke test, not a speaker
accuracy benchmark. No live multi-speaker pyannote benchmark was completed.
