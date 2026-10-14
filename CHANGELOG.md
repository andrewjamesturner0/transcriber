# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- Optional local word alignment of the existing Whisper transcript, with an "Align words to the audio" job switch and CLI `--alignment whisper|forced`.
- Explicit speaker and alignment model downloads in Settings or `scripts/setup-diarization.py`; `TRANSCRIBER_PYTHON` selects the interpreter.
- JSON speaker attribution evidence, word timing sources, alignment status and regular/exclusive speaker timelines, while retaining `whisper`, `diarize` and `merged`.
- A reproducible speaker evaluation harness and partial benchmark results. Community-1 and legacy word speaker scores are recorded on one tuning episode; independent timing annotations and held-out validation remain pending.

### Changed

- Diarised jobs keep ordinary Whisper timing and flash attention by default. DTW is now an explicit CLI `--dtw` option after the tuning episode lost two interview clips with DTW and took 35% longer.
- Optional speaker diarisation uses pyannote.audio 4.0.7 and Community-1 with its exclusive timeline for word assignment. Python packages are pinned; Python 3.10 to 3.13 is the supported setup.
- Speaker and alignment inference load prepared local caches with telemetry disabled. Tokens are used only during setup and are no longer saved; the CLI's old `--hf-token` option is ignored.
- Alignment setup warns about the non-commercial fr/de/es/it model licences.
- Word alignment no longer needs the WhisperX package or NLTK's Punkt data. Its path search is adapted into `lib/alignment_core.py` with the WhisperX and TorchAudio notices kept; the 41 language models and their caches are unchanged. `lib/requirements-alignment.txt` now adds transformers 4.57.6 instead of whisperx 3.8.6, so a clean install skips WhisperX, NLTK, faster-whisper, CTranslate2, ONNX Runtime, torchvision and other unused packages (470 MB less on the tested Linux CUDA setup). Existing environments are not changed.
- Alignment labels words with no characters the model knows (digits, symbols) `interpolated` instead of `measured`, and multi-character Japanese/Chinese words are matched to their own characters rather than lost (covered by synthetic tests; not yet checked on real Japanese or Chinese audio). The provider is reported as `transcriber-align`; older saved WhisperX results still load.

### Fixed

- Completed in-app model/font disclosures, distinguished optional downloaded assets, and recorded the unresolved FFmpeg source-delivery requirements.
- Excluded local credentials, environments and benchmark recordings from packaged app files.
- Requested DTW timing now disables flash attention and uses validated token anchors; unsupported DTW falls back with a recorded reason.
- Speaker merging preserves supported short replies, overlap evidence and Unknown labels instead of rewriting them during cleanup.


## [0.3.3] - 2026-10-14

### Changed

- Updated Electron from 44.3.0 to 44.7.0.
- Updated the bundled Windows FFmpeg build and verified the FFmpeg checksums for all platforms.

### Fixed

- Restored Windows release builds by updating the Vulkan SDK to 1.3.296.0, with matching SPIR-V headers, after the previous SDK download became unavailable.

## [0.3.2] - 2026-09-15

### Fixed

- Waited for Vulkan detection to finish before showing the active transcription backend in the model selector.

## [0.3.1] - 2026-09-15

### Changed

- Updated whisper.cpp from v1.8.4 to v1.9.2, the latest release that provides the required Windows binary.
- Updated Electron from 42.0.1 to 44.3.0 and raised the required Node.js version to 22.12.
- Updated the Windows FFmpeg build and verified its checksum.

### Fixed

- Kept `package-lock.json` in sync when the weekly dependency workflow updates Electron.
- Skipped whisper.cpp releases that do not provide the required Windows binary.
- Installed the SPIR-V headers required to build whisper.cpp with Vulkan on Linux and Windows.

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
