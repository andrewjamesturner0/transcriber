# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Transcriber, an Electron desktop app wrapping [whisper.cpp](https://github.com/ggml-org/whisper.cpp) for local audio-to-text transcription. No cloud services; all processing is on-device. Licensed under GPLv3. Windows is the primary target.

See [DEVELOPMENT.md](DEVELOPMENT.md) for full build instructions, project structure, and architecture details.

Before changing existing behaviour, check `docs/lessons.md` for durable gotchas and deliberate behaviours maintained by `/lesson`.

Machine-specific notes that must stay private live in `.agents/local.md` (untracked); read it when working with local data.

## Commands

```bash
npm install                          # Install Electron and dev dependencies
bash scripts/build.sh                # Full build: download deps + package Windows NSIS installer (default)
bash scripts/build.sh --target linux # Build Linux AppImage instead
bash scripts/build.sh --target all   # Build both Windows and Linux
bash scripts/build.sh --skip-deps    # Verify existing model/binary identities, then package
bash scripts/build.sh --debug        # Include debug panel (log viewer in settings menu)
bash scripts/setup.sh                # Dev only: build whisper.cpp from source for local Linux testing
npm start                            # Launch app in dev mode (Linux only, needs bin/linux/ populated)
```

## Key Details

- **deps.json** is the single source of truth for dependency versions (whisper.cpp, ffmpeg URLs, Vulkan SDK, Node). Build scripts and CI both read from it.
- Platform binaries in `bin/{win,linux,mac}/{cpu,vulkan}/`; build-time bundled models in `models/`. GUI downloads go to `app.getPath('userData')/models` with bundled fallback; the CLI reads/writes repository `models/`. `lib/model-store.js` owns lookup/download state and `lib/model-download.js` installs HTTPS downloads atomically.
- `main.js`: main process; IPC handlers, explicit model storage, structured GUI results and operation-owned shutdown. `lib/operation-manager.js` reserves work before awaits, cancels owned jobs/setup/downloads and stops admission while closing; `lib/logging.js` owns bounded async logs.
- `cli.js`: command-line entry point (`node cli.js <subcommand>`), runs the same pipeline as the GUI without launching Electron; see [docs/cli.md](docs/cli.md)
- `lib/paths.js`: shared binary-path resolution (`getResourcePath`, `getPlatformDir`, `getWhisperBinary`, `getFfmpegBinary`, `makeEnvWithLibPath`)
- `lib/capabilities.js`: GPU backend detection, DTW support probing, Python/pyannote availability (consolidated from former global state)
- `lib/transcription-runner.js`: FFmpeg -> whisper -> alignment -> diarize pipeline (the last two only for speaker-labelled jobs) (factory `createTranscriptionRunner` with dependency injection; composes `lib/whisper-runner.js` and `lib/models.js`)
- `lib/whisper-runner.js`: whisper-cli arg construction, backend resolution, GPU/DTW fallback retry policy (factory `createWhisperRunner`)
- `lib/_subprocess.js`: shared subprocess spawn helper used by both pipeline modules
- `lib/models.js`: canonical model metadata; 13 entries with filenames, labels, sizes, DTW presets, and per-model flags
- Transcription flow: FFmpeg converts to 16 kHz mono WAV, then whisper-cli uses `--no-timestamps` (plain text), `--tinydiarize` (tdrz models), or `--output-json-full` (pyannote). Diarised jobs keep flash attention and take word timing from forced alignment (falling back to Whisper token timing if alignment fails). CLI `--dtw` (runner option `dtw: true`) explicitly adds `--dtw <preset> --no-flash-attn` where supported. Forced-alignment jobs skip DTW, run `lib/align.py`, then run `lib/diarize.py` on the same WAV.
- `lib/transcript-timing.js` validates word timing and records its source; `lib/diarize-merge.js` prefers the exclusive speaker timeline and preserves short turns and Unknown. See [docs/diarization.md](docs/diarization.md).
- Optional Python setup uses one file, `lib/requirements.txt` (Python 3.10 to 3.13, pyannote.audio 4.0.7, transformers 4.57.6 for non-torchaudio alignment languages). `TRANSCRIBER_PYTHON` selects the interpreter. Components and licences: [docs/diarization-setup.md](docs/diarization-setup.md).
- `lib/align.py` loads `lib/alignment_models.py` (41-language model registry, cache-only loaders) and `lib/alignment_core.py` (path search adapted from WhisperX 3.8.6; notices in `lib/third_party/`) by file path. WhisperX and NLTK/Punkt are not used; provider `transcriber-align`, envelope version 1.
- `scripts/setup-diarization.py` and `lib/diarization-setup.js` download models explicitly. Hugging Face tokens are used only for setup, passed through the environment and never saved. Python inference uses local caches with telemetry disabled.
- Speaker labelling is one Settings switch, "Label speakers", with no partial mode: every labelled job runs forced alignment then pyannote. `renderer/job-options.js` (`speakerLabelState`) enables it only when both models are ready. CLI `--diarize` defaults to `--alignment forced`; `--alignment whisper` and `--dtw` are for evaluation only.
- `lib/models.js` defines the canonical model metadata. Model stores, rather than the catalogue, own filesystem paths and downloads. Multilingual models pass `-l auto`; English-only models pass `-l en` in plain, JSON and speaker-labelled runs.
- `preload.js` keeps string `transcribe` compatibility and adds `transcribeResult` for `{ text, transcript }`. GUI rendering reads explicit blocks/warnings; canonical text is kept for copy/save. Queue snapshots are detached/read-only; completed/error items survive runs and cancellation leaves unstarted items pending.
- `scripts/build-deps.js` verifies pinned source, binary receipts, FFmpeg archives and the bundled default model. Unknown caches are refused, including with `--skip-deps`; dependency updates must refresh the matching reviewed revision/archive metadata.
- Test categories: `npm test` (deterministic Node/Python, no weights), `npm run test:maths` (NumPy/PyTorch, no weights), `npm run test:electron` (real Electron, display or Xvfb). Runtime model/recording checks stay separate; use `TRANSCRIBER_TEST_PYTHON` to select the test interpreter.
- NSIS installer built via electron-builder (cross-compiles on Linux or runs natively on Windows in CI); produces NSIS `.exe` installer
- GPU acceleration via Vulkan backend; CPU and Vulkan binaries in separate subdirs under `bin/{platform}/`
- Runtime GPU detection: spawned by `lib/capabilities.js` at startup, falls back to CPU if unavailable
- Weekly `dep-check.yml` workflow checks for whisper.cpp releases and ffmpeg checksum changes, auto-opens PRs
