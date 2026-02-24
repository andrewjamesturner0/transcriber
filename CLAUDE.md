# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Electron desktop app wrapping [whisper.cpp](https://github.com/ggml-org/whisper.cpp) for local audio-to-text transcription. No cloud services — all processing on-device. Windows is the primary target.

See [DEVELOPMENT.md](DEVELOPMENT.md) for full build instructions, project structure, and architecture details.

## Commands

```bash
npm install                          # Install Electron and dev dependencies
bash scripts/build.sh                # Full build: download deps + package Windows zip (default)
bash scripts/build.sh --target linux # Build Linux AppImage instead
bash scripts/build.sh --target all   # Build both Windows and Linux
bash scripts/build.sh --skip-deps    # Skip binary downloads, just package
bash scripts/setup.sh                # Dev only: build whisper.cpp from source for local Linux testing
npm start                            # Launch app in dev mode (Linux only, needs bin/linux/ populated)
```

## Key Details

- Platform binaries in `bin/{win,linux,mac}/`, models in `models/` — all gitignored, created by build scripts
- `main.js`: main process — `getPlatformDir()` and `getResourcePath()` handle dev vs packaged paths
- Transcription flow: ffmpeg converts to 16kHz mono WAV, then whisper-cli transcribes with `--no-timestamps`
- `MODELS` array in `main.js` defines available models; `download-model` IPC streams from Hugging Face
- NSIS installer target in `electron-builder.yml` requires native Windows (not WSL); build script defaults to zip
