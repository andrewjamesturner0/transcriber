# Diarisation evaluation

`scripts/evaluate-diarization.js` scores saved pipeline outputs against a
speaker-labelled reference transcript. The question it answers is "which
speaker did each recognised word get, and was that right?", not only "how
much time did the diariser label correctly?". A diariser can have a low
diarisation error rate (DER) and still put a two-word reply under the wrong
speaker, because short turns carry almost no time. Word speaker attribution
is what users read, so it is the main measure here. Time-based measures are
reported separately, and only when someone has annotated the times by hand.

The harness only replays saved files. It never runs Whisper, pyannote or the
aligner, so a comparison can hold any stage fixed (see "Comparing stages
fairly" below).

## Quick start

```bash
# Synthetic example (tracked, invented data)
node scripts/evaluate-diarization.js \
  --manifest scripts/fixtures/diarization/evaluation-example.json \
  --output /tmp/transcriber-diarization-example.json

# Unit tests
node scripts/test-diarization-evaluation.js

# Real data (private; manifest and report stay in ignored paths)
export DIARIZATION_EVAL_MANIFEST=Examples/diarization-evaluation.json
export DIARIZATION_EVAL_REPORT=Examples/diarization-evaluation-report.json
node scripts/evaluate-diarization.js
```

Options: `--quiet` drops the summary table on stderr; `--no-timestamp`
leaves out `generatedAt`, so two runs on the same inputs give byte-identical
reports. Exit codes: 0 success, 1 input or evaluation error (missing file,
checksum mismatch, schema mismatch, bad annotation), 2 usage error.

The synthetic example is not evidence about any model. Its report says so in
`notes` and in `"synthetic": true`.

## Importing a speaker-labelled reference

```bash
node scripts/evaluate-diarization.js import-reference \
  --text Examples/more_or_less_could_europe_use_its_gold-standard-transcript.txt \
  --audio Examples/more_or_less_could_europe_use_its.mp3 \
  --out Examples/diarization-evaluation.json --id more-or-less-europe
```

This writes a manifest skeleton with:

- the audio and text paths (relative to the manifest) and their sha256
  checksums;
- the parsed turns: 1-based turn number, label, source line range, text and
  normalised words (the word list is what timing annotations point at);
- the speaker inventory, derived from the turn labels actually used;
- the normalisation rules and scoring settings below;
- an empty `variants` list and `timing: null`.

The source text is never rewritten. At evaluation time the harness re-reads
the file, checks its checksum and fails if it changed. If the stored parsed
turns no longer match the file, it fails too and asks for a re-import.

`--split tune|heldout` sets the split (default `tune`). An existing manifest
is never overwritten unless you pass `--force`; `--append` adds another
recording to it instead.

### Reference text format

```
[3 speakers detected]          <- optional header, ignored

[Unknown] (music) Intro jingle.

[Speaker 1] A turn may wrap
over several lines.

[Speaker 2] Short reply.
```

- A line that starts with `[label]` starts a new turn. Following non-blank
  lines continue it. Blank lines are ignored.
- A first line like `[N speakers detected]` is a header and is ignored, even
  when malformed (the gold episode's header reads `[pp3 speakers detected]`).
  The speaker inventory always comes from the labels.
- Text before the first label is an error, so nothing is silently dropped.
- Turns labelled `Unknown` (configurable through `scoring.excludedLabels`)
  are excluded from speaker scoring but kept for coverage reporting.

## Text normalisation

Reference and recognised words go through the same rules (id
`transcriber-eval-text-v1`):

1. Text inside parentheses or square brackets is a cue such as `(music)` and
   is dropped. Cue state resets at the end of each reference turn and each
   Whisper segment, so an unclosed bracket cannot swallow the rest of the
   file.
2. Curly apostrophes become straight apostrophes, then text is lowercased.
3. `$`, `,` and `%` are removed: `$12.6` -> `126`, `10%` -> `10`. Numbers are
   not converted to or from words, so `forty two` and `42` do not match.
4. Hyphens, dashes and slashes split words: `sell-off` -> `sell off`.
5. All other punctuation is removed, including full stops inside numbers
   (`12.6` -> `126`).
6. Apostrophes stay only between letters or digits (`that's` stays).
7. Words are split on whitespace; empty results are dropped. Whisper words
   that produce nothing (for example `[BLANK_AUDIO]`) are counted in
   `whisperWordsDroppedByNormalisation`.

In the rest of this guide, "words" means these normalised words.

## Manifest schema

```json
{
  "schema": "transcriber-diarization-eval",
  "version": 1,
  "synthetic": false,
  "notes": ["free text copied into the report"],
  "normalisation": { "id": "transcriber-eval-text-v1" },
  "scoring": {
    "excludedLabels": ["Unknown"],
    "shortTurnMaxWords": 5,
    "nearChangeWords": 3,
    "externalDer": null
  },
  "recordings": [
    {
      "id": "episode-1",
      "split": "tune",
      "audio": { "path": "episode.mp3", "sha256": "..." },
      "reference": {
        "path": "episode-gold.txt", "sha256": "...",
        "format": "speaker-labelled-text",
        "insertedClipTurns": [3, 4],
        "parsed": { "...": "written by import-reference" }
      },
      "timing": null,
      "variants": [
        {
          "id": "community1-exclusive",
          "description": "What changed in this variant",
          "whisper": "runs/whisper.json",
          "diarization": "runs/diarize.json",
          "alignment": null,
          "timeline": "auto",
          "config": { "gapFillMaxMs": 5000 },
          "runtime": { "whisperSec": 225, "peakRssGb": 0.95 }
        }
      ]
    }
  ]
}
```

- All paths are relative to the manifest file. Any variant input can also be
  `{ "path": "...", "sha256": "..." }`; the checksum is then checked. The
  report always records each input's checksum.
- `audio` may be `null` (the synthetic fixture has no audio). When given, its
  checksum must match.
- `reference` is either a file (`path`, `sha256`, `format`) or inline
  `{ "turns": [{ "label", "text" }] }` for synthetic data.
- `insertedClipTurns` lists turns (1-based) from inserted clips such as a
  recorded interview question. They join short-turn retention whatever their
  length.
- `whisper` is the `--output-json-full` result, or a runner JSON with a
  `whisper` key.
- `diarization` is a `lib/diarize.py` envelope (`format:
  "transcriber-diarization"`), a legacy `[{start, end, speaker}]` array, a
  runner JSON with `diarize` and `diarizeExclusive`, or `null`. With `null`,
  only text coverage (and word start error, if annotated) is scored; speaker
  metrics are `null` with reason `"no diarization output"`.
- `alignment` is `lib/align.py` output (`format: "transcriber-alignment"`,
  version 1) or `null`. It is applied with `applyForcedAlignment`, exactly as
  the runner does.
- `timeline`: `auto` uses the exclusive timeline when present, as the app
  does; `regular` ignores the exclusive one; `exclusive` requires it and fails
  if it is missing.
- `config` overrides `assignSpeakers` settings (`gapFillMaxMs`,
  `assignmentPoint`). Unknown keys are an error.
- `runtime` is copied into the report as given. It is optional; when absent
  the report lists it under `missing`.
- `scoring.externalDer` is `null` or `{ "tool": "pyannote.metrics",
  "collar": 0.0, "skipOverlap": false }` (see "Standard DER" below).

Each variant is processed as: `normaliseWhisperWords` -> optional
`applyForcedAlignment` -> `assignSpeakers` with the chosen timeline and
config -> scoring.

## Metrics

### Pairing words (text only)

Recognised words are paired with reference words by a weighted edit-distance
alignment of the two normalised word sequences (substitution 3, insertion or
deletion 2, so ties never lose a matched word). Only identical words count as
matched. Timing is never used to decide which reference word a recognised
word belongs to: a word with wrong timing is still compared with its true
reference word, and moving every time stamp changes no text count.

### Denominators

| Field | Meaning |
| --- | --- |
| `referenceWords` | All reference words, including excluded turns |
| `referenceWordsScored` | Reference words outside excluded (Unknown) turns |
| `whisperWords` | Whisper words before normalisation |
| `recognisedWords` | Normalised recognised words |
| `matchedWords` | Pairs with identical text |
| `matchedWordsScored` | Matched words outside excluded turns: the denominator for speaker rates |
| `substitutedWords`, `deletedReferenceWords`, `insertedRecognisedWords` | The rest of the text alignment |

Text metrics: `coverage` = matched / reference words; `scoredCoverage` the
same for scored turns; `recognisedMatchedRate` = matched / recognised words;
`textWordErrorRate` = (substituted + deleted + inserted) / reference words,
after normalisation. Coverage matters: a variant that drops a turn cannot be
wrong about its speaker, so never compare speaker error without coverage.

### Speaker mapping

Diariser speaker IDs are arbitrary. For each variant, hypothesis IDs are
mapped one-to-one to reference labels with the Hungarian method, maximising
the number of matched scored words whose mapped label agrees. IDs are ordered
by first appearance, not by name, so renaming IDs cannot change any score. An
ID left without a partner (more diariser speakers than reference speakers),
or paired with zero agreement, is unmapped and all its words count as wrong.
The report lists the mapping with agreed and matched word counts.

### Word speaker scores

Over matched words in scored turns, each word is exactly one of:

- `correct`: the mapped hypothesis label equals the reference label;
- `wrong`: a speaker was assigned, but the wrong one (or an unmapped one;
  `wrongFromUnmappedSpeakers` counts these);
- `unknown`: the merge assigned no speaker (`Unknown`). This is not counted
  as an error.

`wordSpeakerErrorRate` = wrong / scored, `unknownRate` = unknown / scored.
`ambiguous` counts words whose assignment was `ambiguous` (overlap or tie)
and `ambiguousRate` = ambiguous / scored; those words are also correct or
wrong. `byAssignment` splits the counts by the merge's assignment state
(`supported`, `ambiguous`, `gap-filled`, `unknown`).

### Short-turn retention

Candidates are scored turns with at most `shortTurnMaxWords` words (default
5), plus `insertedClipTurns`. A candidate is:

- `retained` when a strict majority of its matched words have the correct
  mapped speaker;
- `lost` when it was recognised but not retained;
- `not-recognised` when none of its words matched (a text problem, not a
  speaker problem).

The report gives `retained / turns`, `retained / recognisedTurns` and the
turn numbers in each group.

### Errors near speaker changes

A speaker change is a position in the reference word sequence where the
label differs from the previous word's. Words within `nearChangeWords` (K,
default 3) words either side of a change are `near`; the rest are
`elsewhere`. Each group has its own counts and error rate.

### Overlap subsets

- `diariserOverlap` (available whenever diarisation exists): matched words
  whose assignment evidence lists two or more overlapping or tied speakers,
  scored separately from the rest.
- `timing.referenceOverlapWords` (needs a timing annotation): annotated words
  whose annotated start lies where two or more annotated reference turns
  overlap, scored against the text label.

### Per-turn coverage

`turnCoverage` lists every turn, excluded ones included, with words,
matched words, coverage and (with diarisation) correct, wrong and unknown
counts. `zeroCoverageTurns` lists turns with words but no match, for example
an inserted clip the recogniser dropped.

### Timing metrics

Without an independent timing annotation these are `null` with reason
`"no independent timing annotation"`: word start error, time-weighted speaker
error, the reference overlap subset and DER. A speaker-labelled text has no
times, and machine alignment of the reference is an experiment input, never
gold timing.

With an annotation:

- `wordStartError`: for annotated words that were matched by text, the
  recognised word's `startMs` minus the annotated start. Reports signed
  median, absolute median and absolute p95 (nearest-rank percentile), plus
  counts of untimed words and of words that are not the first normalised
  part of a recognised word (`sell-off` -> `off` is skipped).
- `timeWeightedSpeakerError`: within annotated time where exactly one
  reference speaker talks, (missed + confused) / scope, using the timeline
  that decided speakers and the word-level mapping. Missed means no
  hypothesis speaker; confused means any other set. It also reports how much
  annotated overlap the regular timeline also marks as overlap. This is a
  simple homegrown measure. It is deliberately not called DER.

### Standard DER

Standard DER is only computed through a named external tool. Set
`scoring.externalDer` to `{ "tool": "pyannote.metrics", "collar": 0.0,
"skipOverlap": false }`. The harness runs `pyannote.metrics`
`DiarizationErrorRate(collar, skip_overlap)` in a Python subprocess
(`$DIARIZATION_EVAL_PYTHON`, else `$TRANSCRIBER_PYTHON`, else `python3`),
with the UEM set to the span of the annotated turns, and records the tool
version and settings. In pyannote.metrics the collar is the total width
removed around each reference boundary. pyannote.metrics does its own
optimal speaker mapping. If the tool is missing or the annotation has no
turns, `der` is `null` with the reason.

### Other fields

Each variant also reports `timingSummary` (words per timing source, quality
and fallback), `assignmentSummary` (the merge's assignment counts),
`timeline.requested` / `timeline.used`, the input checksums and `runtime`.
`missing` lists every metric that is `null`, with its reason. A missing
metric is never reported as 0.

## Report schema

```json
{
  "schema": "transcriber-diarization-eval-report",
  "version": 1,
  "generatedAt": "2026-10-14T12:00:00.000Z",
  "manifest": { "path": "...", "sha256": "..." },
  "synthetic": false,
  "normalisation": { "id": "transcriber-eval-text-v1", "rules": ["..."] },
  "scoring": { "excludedLabels": ["Unknown"], "...": "..." },
  "recordings": [
    {
      "id": "...", "split": "tune",
      "inputs": { "audioSha": "...", "referenceSha": "..." },
      "referenceSummary": { "turns": 31, "words": 1353, "scoredWords": 1348,
        "speakers": ["Speaker 1"], "excludedTurns": [1], "insertedClipTurns": [3, 4],
        "headerIgnored": true, "timingAnnotation": null },
      "variants": [
        {
          "id": "...", "description": "...",
          "inputs": { "whisper": { "path": "...", "sha256": "..." }, "diarization": null, "alignment": null, "config": {} },
          "timeline": { "requested": "auto", "used": "exclusive" },
          "metrics": { "text": {}, "speaker": {}, "shortTurns": {}, "nearChange": {},
            "diariserOverlap": {}, "turnCoverage": [], "zeroCoverageTurns": [],
            "timing": { "wordStartError": null, "timeWeightedSpeakerError": null,
              "referenceOverlapWords": null, "der": null } },
          "denominators": {},
          "mapping": [{ "hypSpeakerId": "SPEAKER_00", "hypLabel": "Speaker 1",
            "referenceLabel": "Speaker 1", "agreedWords": 0, "matchedWords": 0 }],
          "timingSummary": {}, "assignmentSummary": {}, "runtime": null,
          "missing": [{ "metric": "timing.der", "reason": "..." }]
        }
      ]
    }
  ],
  "notes": ["..."]
}
```

A short table goes to stderr unless `--quiet` is given.

## Adding manual timing annotations

Time-based claims need times checked by a person against the audio. Add a
`timing` object to the recording:

```json
"timing": {
  "source": "who annotated, with what tool, on what date",
  "turns": [
    { "start": 71.6, "end": 79.2, "speaker": "Speaker 2" }
  ],
  "words": [
    { "turn": 5, "word": 0, "text": "hello", "startMs": 412340 }
  ]
}
```

- `turns` are seconds from the start of the audio, using reference labels.
  Overlapping turns are allowed and mark overlap.
- `words` point at a reference word by turn number (1-based) and word index
  (0-based) in that turn's normalised word list, which `import-reference`
  stores under `reference.parsed.turns[].words`. `text` is optional; when
  given it must match, which catches off-by-one mistakes.
- Times are seconds or milliseconds from the start of the audio the
  pipeline saw (the app's 16 kHz mono WAV). If you annotate the original
  file instead, spot-check a few words in both, since decoders can differ
  by a few tens of milliseconds at the start.
- You do not need to annotate everything. Start with the words around
  speaker changes, especially short replies and inserted clips.
- Keep machine-generated reference alignments in a separate file and never
  label them as `timing`.

## Comparing stages fairly

Change one stage at a time and replay saved outputs for the others:

- **Comparing timing** (ordinary offsets, DTW anchors, forced alignment):
  hold the recognised text fixed. DTW needs `--no-flash-attn`, which changed
  the recognised text on the gold episode (the dropped clip below), so an
  ordinary-versus-DTW comparison across two Whisper runs mixes a text change
  with a timing change. Compare on identical text where possible (for
  example forced alignment of the same Whisper JSON) and always read coverage
  next to speaker error.
- **Comparing diarisers** (legacy 3.1, Community-1 regular, Community-1
  exclusive): hold the Whisper JSON and alignment fixed and change only the
  `diarization` file and `timeline`.
- **Comparing merge settings**: hold all three inputs fixed and change only
  `config`.
- Record versions, model hashes and settings for every saved input, and keep
  the 16 kHz mono conversion the app uses.

## Tune and held-out recordings

Every recording has `split: "tune"` or `"heldout"`. Tune recordings are for
looking at failures and choosing settings. Before reading any held-out score,
write down the acceptance rule (for example: lower word speaker error with no
fall in short-turn retention or coverage) and the variants it applies to.
Do not change thresholds after seeing held-out results. A change tuned on one
episode is not independent evidence that it generalises.

Suggested order:

1. Start with the nine-minute gold episode (`Examples/`, about 545 s, 31
   turns: an Unknown music intro and 30 turns by Speakers 1-4, with short
   replies and an inserted two-speaker interview clip in turns 3-4). Score
   speaker attribution from the text now; add manual times around changes
   later.
2. Extend to roughly 10-20 minutes of representative clips (interviews,
   phone audio, overlap, several speakers), plus one longer excerpt to check
   long-recording behaviour.
3. Hold back independent recordings, not cut from the tuning material, as
   the held-out split.

The text alignment keeps a table of reference words x recognised words
(about 2 million cells for the nine-minute episode). The harness refuses
tables above 100 million cells (roughly 10,000 words each side, about an
hour of speech); split longer recordings into excerpts.

## Privacy

Real recordings, references, manifests and reports contain private speech
and text. Keep them in ignored paths such as `Examples/`
(`Examples/diarization-evaluation.json`,
`Examples/diarization-evaluation-report.json`) and point the script at them
with `DIARIZATION_EVAL_MANIFEST` and `DIARIZATION_EVAL_REPORT`. The summary
table on stderr has no transcript text, but the manifest and report store
parsed reference turns and per-turn data. Only clearly synthetic fixtures
belong in git. When quoting results, use counts and anonymised names.

## Results

### 2026-10-14: first benchmark recording (partial)

One recording so far: a nine-minute two-presenter radio podcast with two
short inserted interview clips (four reference speakers plus a music intro,
30 speaker turns, 1353 reference words). It is a **tune** recording; there is
no held-out recording yet, so nothing below is evidence that a change
generalises. Recognised text comes from whisper.cpp `small.en` (libwhisper
1.8.4 built locally, CPU, 4 threads), converted to 16 kHz mono as in the app.

**No speaker diarisation output exists yet.** The machine used has no
Hugging Face access to the gated pyannote model, so every speaker metric
(word speaker error, unknown and ambiguous rates, short-turn retention,
errors near changes, overlap subsets) is **missing** for every variant,
including the original pipeline baseline. No timing annotation exists
either, so word start error and time-weighted speaker error are **missing**.
The table records what was executed.

| Variant | Status | Recognised words | Matched / reference | Turns with no matched words | Whisper time | Extra step |
| --- | --- | ---: | ---: | --- | ---: | --- |
| Original decoder (flash attention, no DTW anchors) | executed, text only | 1344 | 1308 / 1353 (96.7%) | 1 (music intro) | 3 min 45 s | - |
| DTW decoder (`--no-flash-attn`) | executed, text only | 1298 | 1261 / 1353 (93.2%) | 1, 3, 4 (intro and both inserted clips) | 5 min 05 s | - |
| Original decoder + forced alignment | executed, text and timing provenance | 1344 | 1308 / 1353 (96.7%) | 1 | 3 min 45 s | 25.7 s wall (12.0 s GPU alignment), all 1340 words acoustically matched |
| Any variant with pyannote 3.1 or Community-1 | missing (no model access) | - | - | - | - | - |

Timing evidence that does not need a reference annotation (from design
record D1, same recording; the aligner output is itself a machine estimate,
checked against voicing onsets after quiet pauses):

| Timing source | Start vs aligner, median | abs p95 | Assignment point inside aligned word |
| --- | ---: | ---: | ---: |
| Ordinary token offsets | +15 ms | 906 ms | 25.9% |
| DTW anchor | +154 ms | 424 ms | 77.1% |
| Forced alignment vs voicing onset (69 words after quiet pauses) | +9 ms to -18 ms by padding | - | - |

### Promotion decisions

- **Defaults unchanged.** Diarised jobs keep Whisper timing (DTW anchors)
  by default and forced alignment stays an opt-in job option. No speaker
  accuracy evidence exists for either choice yet.
- **DTW carries a text cost on this recording.** Turning flash attention off
  for DTW lost both inserted interview clips (49 reference words); matched
  words fell from 1308 to 1261, 3.5 points of coverage. This is one decoder run on one recording; it must be checked
  on held-out recordings before DTW is kept or replaced as the default
  timing source for diarised jobs.
- **Still to run (T4.4):** reproduce the original `a08e386` pipeline with
  pyannote 3.1 in an isolated checkout; Community-1 regular and exclusive;
  cleanup-only comparison on frozen text and timelines; DTW versus ordinary
  versus forced timing with frozen diarisation; auto and explicit
  four-speaker runs; manual timing annotations for speaker changes and short
  replies; held-out recordings with acceptance rules fixed beforehand.
