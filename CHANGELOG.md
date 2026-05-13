# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [0.3.0] - 2026-05-13

### Added

- Command-line entry point (`node cli.js`) with `transcribe`, `download-model`, `list-models`, and `gpu-status` subcommands; runs the same pipeline as the GUI without launching Electron. See [docs/cli.md](docs/cli.md).
- Support for Olympus/Philips `.dss` (Digital Speech Standard) input files (Standard Play only; DSS Pro/DSS2 not supported).
- JSON output option in the transcription pipeline when diarization is not in use.
- Architecture walkthrough document (`docs/walkthrough.md`) and dedicated diarization documentation (`docs/diarization.md`).
- Tests for CLI argument parsing and output handling.

### Changed

- Bumped bundled Node to 22 for Electron 42 engine requirement.
- Major refactor of `main.js` into focused modules: `lib/transcription-runner.js` (FFmpeg -> whisper -> diarize pipeline, factory with dependency injection), `lib/whisper-runner.js` (whisper-cli args, backend resolution, GPU/DTW fallback), `lib/diarize-merge.js` (pyannote merge pipeline), `lib/capabilities.js` (GPU/DTW/Python detection), `lib/models.js` (canonical model metadata and download), `lib/paths.js` (binary-path resolution), `lib/_subprocess.js` (shared spawn helper).
- Extracted `renderer/queue.js` for transcription-queue state and split renderer pure functions out for testability.

### Fixed

- Hardened DTW availability detection and fallback path.

### Removed

- Dead diarize-only IPC path.

## [0.2.3] - 2026-03-31

### Changed

- Documentation refresh for video support, model list, and accuracy notes.
- Polished the refresh icon in the settings panel.

## [0.2.2] - 2026-03-30

### Added

- Video file inputs (MP4, MOV, AVI, MKV, WMV, FLV, 3GP).
- `large-v3-turbo` and quantized large model variants.

### Changed

- Time estimate display now shows a GPU caveat.
- Bumped GitHub Actions to v5 to resolve Node.js 20 deprecation warnings.

## [0.2.1] - 2026-03-24

### Fixed

- Vulkan backend selection when the binary is missing.
- NSIS installer filename now uses hyphens consistently.

### Changed

- Auto-updater now emits diagnostic logging.

## [0.2.0] - 2026-03-24

### Added

- GPU acceleration via Vulkan backend, with runtime GPU device detection, smart selection, and OOM handling.
- Speaker diarisation via pyannote.audio (Python sidecar) for word-level speaker alignment.
- Settings panel with whisper flag toggles to reduce transcript glitches.
- `deps.json` as the single source of truth for dependency versions; automated weekly `dep-check` workflow.
- `--debug` build flag with in-app debug panel (log viewer in settings menu).

### Changed

- Settings UI cleanup; estimate info moved into the model card.
- Refactored `main.js` and added test scripts for the diarization pipeline.

## [0.1.2] - 2026-03-07

### Added

- Auto-update via electron-updater; update metadata files now included in the release workflow.

## [0.1.1] - 2026-03-03

### Fixed

- Whisper binaries not found in the Windows installer.

## [0.1.0] - 2026-02-27

Initial public release.

### Added

- Local audio transcription powered by whisper.cpp; all processing on-device.
- Multiple Whisper model sizes from Tiny up to Large-v3, with English-optimised variants.
- Speaker diarisation via TinyDiarize (`tdrz` models).
- Batch processing; queue multiple files and transcribe sequentially.
- Audio file inputs: MP3, WAV, FLAC, OGG, M4A, AAC, WMA, WebM.
- In-app model downloader with progress indicator.
- Copy to clipboard and save to file.
- Time estimates per model.
- Drag-and-drop file selection.
- Windows (NSIS installer + portable ZIP) and Linux (AppImage) builds.
