# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Transcriber is an Electron desktop app for local audio-to-text transcription. It keeps whisper.cpp as the reliable engine and runs additional curated model families through an isolated transcribe.cpp worker. There is no cloud inference. Licensed under GPLv3. Windows x64 and Linux x64 are the supported targets.

See [DEVELOPMENT.md](DEVELOPMENT.md) for full build instructions, project structure, and architecture details.

Before changing existing behaviour, check `.agent-docs/LESSONS.md` for durable gotchas and deliberate behaviours maintained by `/lesson`.

## Commands

```bash
npm install                          # Install Electron and dev dependencies
bash scripts/build.sh                # Full build: download deps + package Windows NSIS installer (default)
bash scripts/build.sh --target linux # Build Linux AppImage instead
bash scripts/build.sh --target all   # Build both Windows and Linux
bash scripts/build.sh --skip-deps    # Skip binary downloads, just package
bash scripts/build.sh --debug        # Include debug panel (log viewer in settings menu)
bash scripts/setup.sh                # Dev only: build whisper.cpp from source for local Linux testing
npm start                            # Launch app in dev mode (Linux only, needs bin/linux/ populated)
```

## Key Details

- **deps.json** is the single source of truth for dependency versions (whisper.cpp, ffmpeg URLs, Vulkan SDK, Node). Build scripts and CI both read from it.
- whisper.cpp binaries are in `bin/{win,linux}/{cpu,vulkan}/`. The bundled fallback model is staged from `models/`, while downloads go to writable per-user model storage.
- `main.js`: main process; IPC handlers and transcription orchestration
- `cli.js`: command-line entry point (`node cli.js <subcommand>`), runs the same pipeline as the GUI without launching Electron; see [docs/cli.md](docs/cli.md)
- `lib/paths.js`: shared binary-path resolution (`getResourcePath`, `getPlatformDir`, `getWhisperBinary`, `getFfmpegBinary`, `makeEnvWithLibPath`)
- `lib/capabilities.js`: GPU backend detection, DTW support probing, Python/pyannote availability (consolidated from former global state)
- `lib/transcription-runner.js`: FFmpeg -> selected engine -> optional pyannote pipeline (factory `createTranscriptionRunner` with dependency injection)
- `lib/whisper-runner.js`: whisper-cli arg construction, backend resolution, GPU/DTW fallback retry policy (factory `createWhisperRunner`)
- `lib/transcribe-runner.js`, `lib/transcribe-worker-client.js`, and `worker/transcribe-worker.mjs`: transcribe.cpp adapter and isolated native worker
- `lib/_subprocess.js`: shared subprocess spawn helper used by both pipeline modules
- `lib/model-catalogue.js`: canonical 19-model metadata and shared job-option validation; `lib/models.js` owns paths and secure downloads
- Transcription flow: FFmpeg converts to 16 kHz mono WAV, then the selected whisper.cpp or transcribe.cpp adapter returns an engine-neutral result. Validated Whisper word timing can feed the optional pyannote merge.
- Model downloads are user initiated, checksummed, and installed atomically. Hugging Face tokens are sent only to approved Hugging Face HTTPS hosts.
- NSIS installer built via electron-builder (cross-compiles on Linux or runs natively on Windows in CI); produces NSIS `.exe` installer
- GPU acceleration via Vulkan backend; CPU and Vulkan binaries in separate subdirs under `bin/{platform}/`
- Runtime GPU detection: spawned by `lib/capabilities.js` at startup, falls back to CPU if unavailable
- Weekly `dep-check.yml` workflow checks for whisper.cpp releases and ffmpeg checksum changes, auto-opens PRs
