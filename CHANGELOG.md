# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.1.0] — 2026-02-27

Initial public release.

### Added

- Local audio and video transcription powered by whisper.cpp — all processing on-device
- 9 Whisper model sizes from Tiny (75 MB) to Large-v3 (3.1 GB), with English-optimised variants
- Speaker diarisation via TinyDiarize (Not very good!)
- Batch processing — queue multiple files and transcribe sequentially
- 8 supported audio/video formats: MP3, WAV, FLAC, OGG, M4A, AAC, WMA, MP4
- In-app model downloader with progress indicator
- Copy to clipboard and save to file
- Time estimates per model
- Drag-and-drop file selection
- Windows (NSIS installer + portable ZIP) and Linux (AppImage) builds
