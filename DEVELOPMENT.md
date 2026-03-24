# Development Guide

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Git](https://git-scm.com/)
- `curl` and `unzip` (available by default on most systems)

**Linux only** (for building whisper.cpp from source):
- A C/C++ compiler (`gcc` / `g++`)
- `cmake` >= 3.10
- `make`

## Quick Start (Linux)

```bash
git clone <repo-url> && cd transcriber
npm install
bash scripts/setup.sh   # builds whisper.cpp, downloads model + ffmpeg into bin/linux/ and models/
npm start                # launches the Electron app
```

## Building Distributables

### Windows target (cross-compile from Linux)

Downloads pre-built Windows binaries for whisper.cpp and ffmpeg:

```bash
bash scripts/build.sh                # produces dist/Transcriber Setup *.exe
```

### Linux target

Compiles whisper.cpp from source and downloads a static ffmpeg:

```bash
bash scripts/build.sh --target linux  # produces dist/Transcriber-*.AppImage
```

### Both targets

```bash
bash scripts/build.sh --target all
```

### Build Script Reference

```
scripts/build.sh [--target win|linux|all] [--skip-deps] [--no-gpu] [--debug]
```

| Flag | Description |
|------|-------------|
| `--target win` | **(default)** Download Windows binaries, package as NSIS installer |
| `--target linux` | Build whisper.cpp from source, package as AppImage |
| `--target all` | Build both Windows and Linux |
| `--skip-deps` | Skip downloading/building binaries (reuse existing `bin/` and `models/`) |
| `--no-gpu` | Skip building Vulkan GPU binaries (CPU only) |
| `--debug` | Include debug panel in settings (log file viewer) |

The script runs these steps:

1. `npm install`
2. Downloads the bundled model (`ggml-tiny.en.bin`, 75 MB) from Hugging Face
3. Fetches or builds platform-specific binaries into `bin/{win,linux}/{cpu,vulkan}/`
   - **Windows**: pre-built CPU `whisper-cli.exe` + DLLs from [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases), `ffmpeg.exe` from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/)
   - **Linux**: clones whisper.cpp, builds CPU and Vulkan variants with cmake, downloads static ffmpeg from [johnvansickle.com](https://johnvansickle.com/ffmpeg/)
   - Vulkan binaries are built from source (requires Vulkan SDK); skipped with `--no-gpu`
4. Runs `electron-builder` to produce the distributable in `dist/`

## Windows Native Build

Build and run the app directly on Windows without cross-compiling from Linux.

### Prerequisites

1. **Node.js** >= 18 — [Download](https://nodejs.org/)
2. **Git for Windows** — [Download](https://git-scm.com/download/win)
3. **Visual Studio Build Tools** (for compiling whisper.cpp):
   - Download [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
   - Select **"Desktop development with C++"** workload
4. **CMake** (if not using Visual Studio's bundled version) — [Download](https://cmake.org/download/)

Optional for GPU acceleration:
- **CUDA Toolkit** — [Download](https://developer.nvidia.com/cuda-downloads) (for NVIDIA GPU support)

### Option A: Pre-built binaries (recommended)

```powershell
git clone <repo-url>
cd transcriber
npm install

mkdir -p bin\win\cpu
mkdir -p models

# Download whisper.cpp release
$WHISPER_VERSION = "v1.8.3"
Invoke-WebRequest -Uri "https://github.com/ggml-org/whisper.cpp/releases/download/$WHISPER_VERSION/whisper-bin-x64.zip" -OutFile whisper.zip
Expand-Archive -Path whisper.zip -DestinationPath whisper-temp -Force
Copy-Item whisper-temp\* bin\win\cpu\ -Recurse -Force
Remove-Item whisper.zip, whisper-temp -Recurse -Force

# Download ffmpeg
Invoke-WebRequest -Uri "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile ffmpeg.zip
Expand-Archive -Path ffmpeg.zip -DestinationPath ffmpeg-temp -Force
Copy-Item ffmpeg-temp\ffmpeg-*\bin\ffmpeg.exe bin\win\
Remove-Item ffmpeg.zip, ffmpeg-temp -Recurse -Force

# Download the default model
Invoke-WebRequest -Uri "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin" -OutFile models\ggml-tiny.en.bin
```

### Option B: Build whisper.cpp from source

For custom builds or GPU support:

```powershell
git clone https://github.com/ggml-org/whisper.cpp.git .build-whisper
cd .build-whisper

# CPU only
cmake -B build -DBUILD_SHARED_LIBS=ON

# Or with CUDA support (requires CUDA Toolkit)
# cmake -B build -DBUILD_SHARED_LIBS=ON -DGGML_CUDA=ON

cmake --build build --config Release

cd ..
Copy-Item .build-whisper\build\bin\Release\whisper-cli.exe bin\win\cpu\
Copy-Item .build-whisper\build\bin\Release\*.dll bin\win\cpu\

# Still need ffmpeg and model — see Option A for download commands
```

### Run and package

```powershell
npm start              # development mode
npm run package        # produces dist/ with NSIS installer
```

The NSIS installer (`Transcriber Setup <version>.exe`) provides the standard Windows experience: installs to Program Files, creates Start Menu shortcuts, and registers an uninstaller.

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Run in development mode (requires `scripts/setup.sh` first on Linux) |
| `npm run setup` | Alias for `bash scripts/setup.sh` |
| `npm run package` | Package for Windows |
| `npm run package:linux` | Package for Linux |
| `npm run package:mac` | Package for macOS |
| `npm run package:all` | Package for all platforms |

## Project Structure

```
main.js              Electron main process — IPC handlers, spawns whisper-cli & ffmpeg
preload.js           Context bridge between main and renderer
deps.json            Single source of truth for dependency versions and URLs
renderer/
  index.html         App UI
  renderer.js        UI logic (model picker, file selection, transcription, save)
  style.css          Styles
lib/
  diarize.py         Pyannote speaker diarization script (spawned as subprocess)
  requirements.txt   Python dependencies for diarization
scripts/
  build.sh           Full build script (download deps + package distributable)
  setup.sh           Dev-only setup (build whisper.cpp from source for local testing)
electron-builder.yml Packaging config (extraResources, targets per platform)
```

**Not checked in** (gitignored, created by scripts):

```
bin/win/cpu/         whisper-cli.exe, DLLs (CPU backend)
bin/win/vulkan/      whisper-cli.exe, DLLs (Vulkan GPU backend)
bin/win/             ffmpeg.exe (shared)
bin/linux/cpu/       whisper-cli, shared libs (CPU backend)
bin/linux/vulkan/    whisper-cli, shared libs (Vulkan GPU backend)
bin/linux/           ffmpeg (shared)
models/              ggml-*.bin model files
.build-whisper/      whisper.cpp source and build tree (Linux only)
node_modules/
dist/                Built distributables
```

## Architecture Notes

- `getPlatformDir()` in `main.js` resolves the `win`/`linux`/`mac` subdirectory for binaries
- `getResourcePath()` handles dev (`__dirname`) vs packaged (`process.resourcesPath`) paths
- Transcription flow: ffmpeg converts input to 16kHz mono WAV temp file, then spawns whisper-cli with `--no-timestamps`
- Thread count: `Math.max(1, Math.min(os.cpus().length - 1, 8))`
- Linux/macOS set `LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH` for whisper shared libs
- `MODELS` array in `main.js` defines all available models; the `download-model` IPC streams from Hugging Face with progress events
- GPU acceleration: ships both CPU and Vulkan whisper-cli binaries; at startup, tests the Vulkan binary with `--help` (5s timeout) and caches the result. If Vulkan fails mid-transcription, transparently retries with CPU
- Backend preference stored in `settings.json` in `app.getPath('userData')`
- macOS builds require building on macOS with `bin/mac/` populated manually

## Diarization Architecture

Speaker diarization uses [pyannote.audio](https://github.com/pyannote/pyannote-audio) via a subprocess, following the same pattern as whisper-cli and ffmpeg.

### Flow

```
User enables diarization in settings
    → transcribe IPC handler runs whisper with --output-json (timestamped segments)
    → runs lib/diarize.py as subprocess on the same WAV
    → mergeTranscriptWithDiarization() aligns whisper segments with speaker labels
    → renderer displays color-coded speaker output
```

### Subprocess protocol

`lib/diarize.py` communicates with Electron via:
- **stderr**: JSON progress lines — `{"message": "Loading model...", "percent": 10}`
- **stderr**: JSON error lines — `{"error": "Authentication failed..."}`
- **stdout**: Final summary — `{"segments": 42}`
- **output file**: JSON array of segments — `[{"start": 0.0, "end": 3.5, "speaker": "SPEAKER_00"}, ...]`

### Testing standalone

```bash
python lib/diarize.py --audio test.wav --output out.json --hf-token YOUR_TOKEN
cat out.json  # should contain speaker segments
```

### Timestamp alignment

Whisper outputs segments with millisecond offsets. Pyannote outputs speaker segments with second-precision timestamps. `mergeTranscriptWithDiarization()` in `main.js` assigns each whisper segment to the pyannote speaker with the greatest temporal overlap, then collapses consecutive same-speaker segments.

### Cancellation

Both whisper and diarize subprocesses share a single `AbortController` per transcription job. The cancel button calls the `cancel-transcription` IPC, which aborts the controller, killing whichever subprocess is currently running.

## Dependency Updates

All external dependency versions and download URLs are centralized in `deps.json`. Both `scripts/build.sh`, `scripts/setup.sh`, and `.github/workflows/release.yml` read from it.

### Automated checks

A weekly GitHub Actions workflow (`.github/workflows/dep-check.yml`) runs every Monday:

1. Checks the latest whisper.cpp release tag against `deps.json`
2. Downloads ffmpeg archives and compares SHA-256 checksums against stored values
3. If anything changed, opens a PR with the updated `deps.json`

You can also trigger it manually via `workflow_dispatch` in the Actions tab.

### Manual update

To bump whisper.cpp manually, edit `deps.json`:

```json
{ "whisper": { "version": "v1.8.4", ... } }
```

Then push and run a CI build. The build scripts and CI workflow will pick up the new version automatically.

## FFmpeg

FFmpeg is bundled as a standalone binary and spawned as a child process. See [docs/ffmpeg.md](docs/ffmpeg.md) for details on sources, licensing, and how to replace the bundled binary.
