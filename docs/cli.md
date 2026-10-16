# Transcriber CLI

A command-line interface to the same transcription pipeline used by the GUI: FFmpeg converts the input to 16 kHz mono WAV, whisper.cpp transcribes it, and pyannote (optional) labels speakers. No window subsystem is launched, so the CLI is suitable for headless servers, faster dev loops, and programmatic use.

The CLI is an in-repo entry point. After cloning and preparing the platform binaries and a Whisper model (see [DEVELOPMENT.md](../DEVELOPMENT.md)), invoke it as:

```
node cli.js <subcommand> [options]
```

On Linux the shebang lets you also run it as `./cli.js <subcommand>`.

## Synopsis

```
node cli.js transcribe <file> [options]
node cli.js download-model <id> [options]
node cli.js list-models [--json]
node cli.js gpu-status [--json]
```

Every subcommand accepts `--help` / `-h`.

## Output and exit-code contract

- Transcript output (txt or json) is written to **stdout**, with nothing else mixed in.
- Progress messages (the same human-readable lines the GUI shows) go to **stderr**, one per line. Pass `--quiet` to suppress.
- Errors always go to stderr.
- Exit code `0` on success, non-zero on any failure, `130` for SIGINT (Ctrl+C).

The CLI does not read or write the GUI's `settings.json`; all configuration comes from flags and environment variables.

## Subcommands

### transcribe

Run the full pipeline on one input audio or video file.

| Flag | Default | Description |
|---|---|---|
| `--model <id>` | `tiny.en` | Whisper model id; see `list-models` for choices. |
| `--backend auto\|cpu\|vulkan` | `auto` | Whisper backend. `auto` probes Vulkan and falls back to CPU. `cpu` skips the GPU probe entirely. |
| `--format txt\|json` | `txt` | Output format. `txt` is plain transcript text. `json` is the full whisper JSON (segments with timestamps), augmented with speaker labels when `--diarize` is on. |
| `--output <path>` | stdout | Write output to a file instead of stdout. |
| `--diarize` | off | Label speakers: word alignment, then Community-1 speaker diarisation, as in the app. Requires Python 3.10 to 3.13, the pinned packages and the prepared local models (see [the setup guide](diarization-setup.md)). Inference needs no token. |
| `--alignment forced\|whisper` | `forced` with `--diarize` | Evaluation only. Word timing for speaker assignment: `forced` matches the existing words to the audio; `whisper` skips alignment and uses Whisper's own word timing. Requires `--diarize`. |
| `--dtw` | off | Evaluation only. Opt in to experimental DTW timing. Needs `--diarize` and `--alignment whisper`; disables flash attention and can change recognised text. |
| `--anti-corruption` | off | Enable anti-corruption sampling flags (helps with repeating-line hallucinations). |
| `--hf-token <token>` | unused | Accepted for old scripts, but ignored. Use `HF_TOKEN` only with `scripts/setup-diarization.py` to download the speaker model. |
| `--num-speakers <n>` | auto | Hint the diariser to expect exactly n speakers. |
| `--quiet` | off | Suppress progress output on stderr. Errors still appear. |
| `-h`, `--help` | | Print help text and exit 0. |

Capability detection is lazy:

- `--backend cpu` skips the GPU probe.
- The Python/pyannote probe runs only when `--diarize` is set.
- Alignment readiness is checked whenever alignment is on (the `--diarize` default). For English-only Whisper models a missing English alignment model stops the run. For multilingual models only the packages are checked first, because the language is known only after Whisper runs; if that language's alignment model is missing, the job reports it and uses Whisper timing.
- The DTW probe runs on the diarisation path and checks each executable for both `--dtw` and `--no-flash-attn`. Ordinary timing keeps flash attention by default. Only explicit `--dtw` enables DTW; it cannot be combined with forced alignment.

Pressing Ctrl+C aborts the in-flight pipeline, cleans up the temp WAV via the existing AbortController, and exits 130. A second Ctrl+C is ignored; force-kill is not implemented in v1.

The CLI is single-file in v1. Multi-file input is not supported; use a shell loop:

```bash
for f in recordings/*.wav; do
  node cli.js transcribe "$f" --model small.en --output "transcripts/$(basename "$f" .wav).txt"
done
```

### download-model

Fetch a model from Hugging Face into `models/`. No-op if the file is already on disk.

| Flag | Default | Description |
|---|---|---|
| `--quiet` | off | Suppress the progress percentage on stderr. |
| `-h`, `--help` | | Print help text and exit 0. |

There is no `--force` flag. To re-download, delete the `.bin` file first.

### list-models

Print the canonical model list defined in `lib/models.js`, marking which are already on disk.

| Flag | Default | Description |
|---|---|---|
| `--json` | off | Emit machine-readable JSON instead of a human-readable table. |
| `-h`, `--help` | | Print help text and exit 0. |

### gpu-status

Probe and print the active backend, device name, available backends, and DTW support.

| Flag | Default | Description |
|---|---|---|
| `--json` | off | Emit machine-readable JSON. |
| `-h`, `--help` | | Print help text and exit 0. |

## Usage examples

Plain transcription, transcript to stdout:

```bash
node cli.js transcribe interview.mp3 --model small.en > interview.txt
```

JSON output with timestamps, no diarisation, written to a file:

```bash
node cli.js transcribe lecture.m4a --model medium.en --format json --output lecture.json
```

To label speakers, download both models once (see
[the setup guide](diarization-setup.md)), then transcribe offline:

```bash
HF_TOKEN=hf_xxx python scripts/setup-diarization.py --alignment
node cli.js transcribe panel.wav --diarize --num-speakers 4 --model medium.en > panel.txt
```

`--diarize` always runs word alignment and then pyannote, as the app does,
and stops before transcribing if the speaker model or the alignment packages
are not ready (see the readiness rules below). For evaluation only,
`--alignment whisper` skips alignment and assigns speakers with Whisper's own
word timing:

```bash
node cli.js transcribe panel.wav --model small.en --diarize --alignment whisper --format json --output panel-whisper-timing.json
```

If diarisation succeeds, JSON keeps `whisper`, `diarize` (regular timeline)
and `merged`, and adds `diarizeExclusive`, `diarizeInfo` and
`speakerAttribution`. The latter records word timing sources, speaker
assignment evidence, DTW status and requested/actual alignment status.
See [the pipeline guide](diarization.md#output).

If alignment fails during inference, the job reports the failure and keeps
Whisper timing. If diarisation fails during inference, it returns plain text;
JSON callers receive `{ "text": "..." }` with no speaker fields. Missing
prerequisites detected before transcription produce a non-zero exit instead.
Neither alignment nor diarisation downloads missing models during a job.

To test DTW explicitly (after speaker setup):

```bash
node cli.js transcribe panel.wav --model small.en --diarize --dtw --format json --output panel-dtw.json
```

DTW is off by default because disabling flash attention changed the recognised
text and omitted short clips in the first benchmark. Check coverage as well
as speaker error when comparing it with ordinary or forced timing.

Quiet batch loop, suppress per-file progress:

```bash
for f in queue/*.mp3; do
  node cli.js transcribe "$f" --quiet --model small.en --output "out/$(basename "$f" .mp3).txt"
done
```

GPU detection in CI:

```bash
node cli.js gpu-status --json
```

Download a model up front in an agent flow:

```bash
node cli.js list-models --json | jq -r '.[] | select(.id=="small.en") | .id' \
  | xargs -I{} node cli.js download-model {}
```

## Prerequisites

The CLI assumes the platform binaries and any required models are already present:

- `bin/<platform>/<backend>/whisper-cli[.exe]`
- `bin/<platform>/ffmpeg[.exe]`
- `models/<filename>` for the chosen model (for example `models/ggml-small.en.bin`; see `lib/models.js`)

Run `scripts/setup.sh` on Linux, or follow the Windows-native setup in [DEVELOPMENT.md](../DEVELOPMENT.md#windows-native-build). `scripts/build.sh --skip-deps` only packages existing binaries; it does not fetch them. If a binary is missing, the CLI exits non-zero with an error naming the missing file. It does not fetch binaries itself.

Set `TRANSCRIBER_PYTHON` to an interpreter path to use a virtual environment. For speaker and alignment packages, cache setup and the setup-only Hugging Face token, see [diarization-setup.md](diarization-setup.md).
