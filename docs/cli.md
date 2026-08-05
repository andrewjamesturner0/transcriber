# Transcriber CLI

A command-line interface to the same local transcription pipeline used by the GUI. FFmpeg converts the input to 16 kHz mono WAV, then the catalogue selects whisper.cpp or transcribe.cpp. Pyannote can label speakers for models where that path has been validated. The CLI does not open a window, so it can run on headless servers and in scripts.

The CLI is an in-repo entry point and requires Node 22 or newer. After cloning, run `scripts/setup.sh` on Linux. On Windows, install dependencies and prepare the required binaries as described in [DEVELOPMENT.md](../DEVELOPMENT.md). Then invoke it as:

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

- Transcript output (txt or JSON) is written to **stdout**, with nothing else mixed in.
- Progress messages (the same human-readable lines the GUI shows) go to **stderr**, one per line. Pass `--quiet` to suppress them.
- Errors always go to stderr.
- The exit code is `0` on success, non-zero on failure, and `130` for SIGINT (Ctrl+C).

The CLI does not read or write the GUI's `settings.json`; all configuration comes from flags and environment variables. Hugging Face tokens are never included in progress or error output. Model downloads use writable per-user storage, described under Prerequisites below.

## Subcommands

### transcribe

Run the full pipeline on one input audio or video file.

| Flag | Default | Description |
|---|---|---|
| `--model <id>` | `tiny.en` | Stable catalogue model id; see `list-models` for choices and availability. |
| `--backend auto\|cpu\|vulkan` | `auto` | Local inference backend. `auto` probes Vulkan and falls back to CPU. `cpu` skips the GPU probe entirely. |
| `--format txt\|json` | `txt` | Output format. JSON uses the engine-neutral result contract described below. |
| `--output <path>` | stdout | Write output to a file instead of stdout. |
| `--job-mode transcribe\|translate` | `transcribe` | Transcribe speech or translate it. The chosen model must support the mode and language pair. |
| `--source-language <id>` | model default | Source language, or `auto` where the model supports detection. |
| `--target-language <id>` | none | Required in translation mode. |
| `--diarize` | off | Enable pyannote speaker diarisation for a validated model. Requires Python 3.9+, `pyannote.audio`, and a Hugging Face token. |
| `--reduce-repeated-text` | off | Apply the model's tested repetition control. Unsupported models reject this option. |
| `--anti-corruption` | off | Compatibility alias for `--reduce-repeated-text`. New scripts should use the new name. |
| `--hf-token <token>` | `$HF_TOKEN` | Hugging Face token for diarisation. Falls back to the `HF_TOKEN` env var. |
| `--num-speakers <n>` | auto | Hint the diariser to expect exactly n speakers. |
| `--quiet` | off | Suppress progress output on stderr. Errors still appear. |
| `-h`, `--help` | | Print help text and exit 0. |

The CLI runs system checks only when needed:

- `--backend cpu` skips the GPU probe.
- The Python/pyannote probe runs only when `--diarize` is set.
- The DTW probe runs only on the diarisation path.

The shared catalogue validator checks the model, job mode, languages, speaker options and repetition control before any capability probe or transcription subprocess starts. Invalid combinations exit with the catalogue's stable error code and model-specific explanation.

JSON output always starts with `text`, `model`, `engine` and `backend`. It can also include `selectedLanguage`, `detectedLanguage`, `segments`, `words`, `tokens`, `timings` or `truncated` when the engine actually returns that detail. Optional fields are omitted when no detail is available. Callers do not need to know the engine's native JSON format.

Pressing Ctrl+C stops the active pipeline, removes the temporary WAV, and exits 130. A second Ctrl+C is ignored; force-kill is not implemented in v1.

The CLI is single-file in v1. Multi-file input is not supported; use a shell loop:

```bash
for f in recordings/*.wav; do
  node cli.js transcribe "$f" --model small.en --output "transcripts/$(basename "$f" .wav).txt"
done
```

### download-model

Fetch a model from Hugging Face into the CLI's writable per-user model directory. If the model is already present there or in the bundled files, the command does nothing.

| Flag | Default | Description |
|---|---|---|
| `--hf-token <token>` | `$HF_TOKEN` | Hugging Face token for a gated model download. Falls back to the `HF_TOKEN` env var. |
| `--quiet` | off | Suppress the progress percentage on stderr. |
| `-h`, `--help` | | Print help text and exit 0. |

Public models do not require a token. Gated models fail before any network request when neither token path is set and print the access-request URL from the catalogue.

### list-models

Print the canonical 19-model catalogue, marking which entries are already on disk. Both formats include the stable id, task, status, languages, size, licence, capabilities and downloaded state. The JSON form also gives structured availability and capability fields. Candidate and Experimental are maturity states, not recommendations or acceptance results.

MOSS Transcribe-Diarize remains visible as an experimental entry, but its runtime is marked deferred and unavailable until the pinned transcribe.cpp release supports it.

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

Translate French speech to English with a multilingual Whisper model:

```bash
node cli.js transcribe interview-fr.wav --model small --job-mode translate \
  --source-language fr --target-language en
```

Apply supported repetition control using the current flag:

```bash
node cli.js transcribe meeting.wav --model small.en --reduce-repeated-text
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

Download a model before a scripted run:

```bash
node cli.js list-models --json | jq -r '.[] | select(.id=="small.en") | .id' \
  | xargs -I{} node cli.js download-model {}
```

Download a gated model after access has been granted:

```bash
export HF_TOKEN=hf_xxx
node cli.js download-model medasr
```

## Prerequisites

The CLI requires Node 22 or newer and assumes the platform binaries and selected model are present:

- `bin/<platform>/<backend>/whisper-cli[.exe]` for whisper.cpp models
- the local transcribe.cpp worker runtime for other supported families
- `bin/<platform>/ffmpeg[.exe]`
- the selected model in writable per-user storage or the bundled `models/` fallback

Run `scripts/setup.sh` on Linux to prepare the development runtime. See [DEVELOPMENT.md](../DEVELOPMENT.md) for Windows preparation and exact transcribe.cpp runtime verification. If a binary is missing, the CLI exits non-zero with an error naming the missing file. It does not fetch engine binaries itself.

`download-model` writes to `TRANSCRIBER_MODEL_DIR` when set. Otherwise it uses `%LOCALAPPDATA%/Transcriber/models` on Windows or `$XDG_DATA_HOME/transcriber/models` on Linux, defaulting to `~/.local/share/transcriber/models`. A matching repository `models/` file remains a read-only fallback.

For diarisation prerequisites (Python, pyannote.audio, Hugging Face token), see [diarization-setup.md](diarization-setup.md).
