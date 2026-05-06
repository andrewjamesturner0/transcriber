# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Transcriber — Electron desktop app wrapping [whisper.cpp](https://github.com/ggml-org/whisper.cpp) for local audio-to-text transcription. No cloud services — all processing on-device. Licensed under GPLv3. Windows is the primary target.

See [DEVELOPMENT.md](DEVELOPMENT.md) for full build instructions, project structure, and architecture details.

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
- Platform binaries in `bin/{win,linux,mac}/{cpu,vulkan}/`, models in `models/` — all gitignored, created by build scripts
- `main.js`: main process — IPC handlers and transcription orchestration
- `lib/paths.js`: shared binary-path resolution (`getResourcePath`, `getPlatformDir`, `getWhisperBinary`, `getFfmpegBinary`, `makeEnvWithLibPath`)
- `lib/capabilities.js`: GPU backend detection, DTW support probing, Python/pyannote availability (consolidated from former global state)
- Transcription flow: ffmpeg converts to 16kHz mono WAV, then whisper-cli transcribes with `--no-timestamps` (single-speaker), `--tinydiarize` (tdrz models), or `--output-json-full` + `--dtw <preset>` (pyannote diarization, for word-level speaker alignment via `lib/diarize-merge.js`)
- `MODELS` array in `main.js` defines available models; `download-model` IPC streams from Hugging Face
- NSIS installer built via electron-builder (cross-compiles on Linux or runs natively on Windows in CI); produces NSIS `.exe` installer
- GPU acceleration via Vulkan backend; CPU and Vulkan binaries in separate subdirs under `bin/{platform}/`
- Runtime GPU detection: spawned by `lib/capabilities.js` at startup, falls back to CPU if unavailable
- Weekly `dep-check.yml` workflow checks for whisper.cpp releases and ffmpeg checksum changes, auto-opens PRs
