# Transcriber CLI

A command-line interface to the same transcription pipeline used by the GUI: FFmpeg converts the input to 16 kHz mono WAV, whisper.cpp transcribes it, and pyannote (optional) labels speakers. No window subsystem is launched, so the CLI is suitable for headless servers, faster dev loops, and programmatic use.

The CLI is an in-repo entry point. After cloning and running `scripts/setup.sh` (Linux) or `scripts/build.sh --skip-deps` (Windows), invoke it as:

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
| `--diarize` | off | Enable pyannote speaker diarisation. Requires Python 3.9+, `pyannote.audio`, and a Hugging Face token. |
| `--anti-corruption` | off | Enable anti-corruption sampling flags (helps with repeating-line hallucinations). |
| `--hf-token <token>` | `$HF_TOKEN` | Hugging Face token for diarisation. Falls back to the `HF_TOKEN` env var. |
| `--num-speakers <n>` | auto | Hint the diariser to expect exactly n speakers. |
| `--quiet` | off | Suppress progress output on stderr. Errors still appear. |
| `-h`, `--help` | | Print help text and exit 0. |

Capability detection is lazy:

- `--backend cpu` skips the GPU probe.
- The Python/pyannote probe runs only when `--diarize` is set.
- The DTW probe runs only on the diarisation path.

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

Diarisation, token from environment:

```bash
export HF_TOKEN=hf_xxx
node cli.js transcribe panel.wav --diarize --num-speakers 4 --model medium.en > panel.txt
```

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
- `models/<model-id>.bin` for the chosen model

Run `scripts/setup.sh` on Linux to fetch them, or `scripts/build.sh --skip-deps` on Windows. If a binary is missing, the CLI exits non-zero with an error naming the missing file. It does not fetch binaries itself.

For diarisation prerequisites (Python, pyannote.audio, Hugging Face token), see [diarization-setup.md](diarization-setup.md).
