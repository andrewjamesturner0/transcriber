# Speaker Diarization Pipeline

How a diarised job turns Whisper output and pyannote speaker turns into a
speaker-labelled transcript. Code: `lib/transcript-timing.js` (word timing)
and `lib/diarize-merge.js` (speaker assignment), called from
`lib/transcription-runner.js`. Evidence and design decisions:
[diarization-investigation.md](diarization-investigation.md) and
[diarization-evaluation.md](diarization-evaluation.md).

## Pipeline

```
media -> FFmpeg (16 kHz mono WAV)
      -> whisper-cli --output-json-full [--dtw <preset> --no-flash-attn]
      -> [optional] lib/align.py   (re-times the same words; job option)
      -> lib/diarize.py           (pyannote Community-1, offline)
      -> normalise word timing -> assign speakers -> formatted text
```

Each step is a separate process, so GPU memory is released between them.
The WAV is shared, so all steps use the same clock.

## Word timing (`lib/transcript-timing.js`)

Every word gets one declared timing source:

| `timingSource` | `timingQuality` | Meaning |
| --- | --- | --- |
| `forced` | `measured` / `interpolated` | Matched to the audio by the optional aligner, or placed between matched neighbours |
| `dtw` | `anchor` | Whisper DTW anchor (`t_dtw * 10` ms) of the word's first token: an estimated onset, not a measured span. The end is the next word's anchor |
| `token` | `estimated` | Whisper's ordinary token offsets |
| `segment` | `segment` | Only the Whisper segment interval is valid |
| `none` | `missing` | No usable time; the word is labelled Unknown |

Invalid values (negative, non-finite, reversed, `-1`) are rejected and the
next source is used; `timingFallback` records why. Zero is a valid time.
Recognised text and word order are never changed.

DTW needs flash attention off (`--no-flash-attn`); whisper.cpp otherwise
disables DTW silently. Turning flash attention off can change the
recognised text. Forced-alignment jobs therefore run Whisper without DTW.

## Speaker assignment (`lib/diarize-merge.js`)

Speaker intervals are half-open `[start, end)`. Each word is assigned from
one point: the DTW anchor for DTW words, otherwise the span midpoint.

- `supported`: the point lies in one speaker's interval (or, if it falls in
  a gap, the word span overlaps one speaker most).
- `ambiguous`: the point lies in two or more speakers' intervals (overlap in
  the regular timeline). The previous word's speaker is kept if it is a
  candidate; all candidates are recorded.
- `gap-filled`: in a gap, within `gapFillMaxMs` (5 s) of a speaker.
- `unknown`: no timing, or further than 5 s from any speaker.

When pyannote returns an exclusive timeline it decides the speaker; the
regular timeline only adds `overlapSpeakers` evidence. Consecutive words
with the same label form a block. Nothing rewrites a word afterwards: there
is no segment absorption, boundary snapping, smoothing or short-block
merging, so short replies and Unknown survive.

## Output

- Text: `[N speakers detected]` then `[Speaker N] text` blocks (unchanged
  format; `mergeTranscriptWithDiarization` returns it).
- JSON (`--format json`): `whisper`, `diarize` (regular timeline) and
  `merged` as before, plus `diarizeExclusive`, `diarizeInfo` (model,
  versions, device) and `speakerAttribution` (per-word timing, speaker,
  assignment and evidence, DTW status and alignment status).

If diarisation fails the job returns the plain transcript. If alignment
fails, words keep Whisper timing and the job says so once.

## Debugging

Set `DIARIZE_DEBUG=1` for a one-line summary on stderr. Regression tests:
`scripts/test-transcript-timing.js`, `scripts/test-merge.js`,
`scripts/test-transcription-runner.js`.
