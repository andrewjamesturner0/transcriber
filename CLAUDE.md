# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Electron desktop app wrapping [whisper.cpp](https://github.com/ggml-org/whisper.cpp) for local audio-to-text transcription. No cloud services — all processing on-device. Windows is the primary target.

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

Output goes to `dist/`. Windows produces a zip (user extracts and runs `Whisper Transcriber.exe`). Linux produces an AppImage.

Note: NSIS installer target is configured in `electron-builder.yml` but requires native Linux (not WSL). The build script defaults to zip for Windows.

## Architecture

**Binary layout** — platform-specific binaries live in `bin/{win,linux,mac}/`:
- `whisper-cli` (.exe on Windows) + shared libs (`.dll` / `.so`)
- `ffmpeg` (.exe on Windows)
- `models/ggml-tiny.en.bin` (75MB, English-only, shared across platforms)

Windows binaries come from whisper.cpp GitHub releases (pre-built). Linux binaries are compiled from source via `scripts/setup.sh`.

**Electron main process** (`main.js`):
- `getPlatformDir()` resolves `win`/`linux`/`mac` subdirectory
- `getResourcePath()` handles dev (`__dirname`) vs packaged (`process.resourcesPath`) paths
- Transcription flow: ffmpeg converts input to 16kHz mono WAV temp file, then spawns whisper-cli with `--no-timestamps`
- Sets `LD_LIBRARY_PATH` (Linux) or `DYLD_LIBRARY_PATH` (macOS) for whisper shared libs

**Preload** (`preload.js`) — exposes IPC methods via `contextBridge`: `selectFile`, `transcribe`, `saveTranscript`, `onStatus`.

**Renderer** (`renderer/`) — vanilla HTML/CSS/JS. File picker, transcribe button, spinner, textarea, save button.

**Packaging** (`electron-builder.yml`) — `extraResources` bundles platform-specific `bin/` subdir and `models/` into the distributable.

## Key Details

- whisper-cli natively handles wav, mp3, flac, ogg; ffmpeg covers m4a, webm, wma, aac and ensures 16kHz mono
- Thread count: `Math.min(os.cpus() - 1, 8)`
- `.build-whisper/` is the whisper.cpp source/build tree (gitignored, only for Linux builds)
- **Model picker**: `MODELS` array in `main.js` defines all available models (tiny through large-v3). The `get-models` IPC checks which are downloaded. The `download-model` IPC streams from Hugging Face with progress events. Models are stored in `models/` directory.
