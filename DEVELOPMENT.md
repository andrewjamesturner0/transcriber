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
bash scripts/build.sh                # produces dist/Transcriber-*-win.zip
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
scripts/build.sh [--target win|linux|all] [--skip-deps]
```

| Flag | Description |
|------|-------------|
| `--target win` | **(default)** Download Windows binaries, package as zip |
| `--target linux` | Build whisper.cpp from source, package as AppImage |
| `--target all` | Build both Windows and Linux |
| `--skip-deps` | Skip downloading/building binaries (reuse existing `bin/` and `models/`) |

The script runs these steps:

1. `npm install`
2. Downloads the bundled model (`ggml-tiny.en.bin`, 75 MB) from Hugging Face
3. Fetches or builds platform-specific binaries into `bin/{win,linux}/`
   - **Windows**: pre-built `whisper-cli.exe` + DLLs from [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases), `ffmpeg.exe` from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/)
   - **Linux**: clones whisper.cpp, builds with cmake, downloads static ffmpeg from [johnvansickle.com](https://johnvansickle.com/ffmpeg/)
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

mkdir -p bin\win
mkdir -p models

# Download whisper.cpp release
$WHISPER_VERSION = "v1.7.5"
Invoke-WebRequest -Uri "https://github.com/ggml-org/whisper.cpp/releases/download/$WHISPER_VERSION/whisper-bin-x64.zip" -OutFile whisper.zip
Expand-Archive -Path whisper.zip -DestinationPath whisper-temp -Force
Copy-Item whisper-temp\* bin\win\ -Recurse -Force
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
Copy-Item .build-whisper\build\bin\Release\whisper-cli.exe bin\win\
Copy-Item .build-whisper\build\bin\Release\*.dll bin\win\

# Still need ffmpeg and model — see Option A for download commands
```

### Run and package

```powershell
npm start              # development mode
npm run package        # produces dist/ with installer and zip
```

The NSIS installer (`Transcriber Setup <version>.exe`) provides the standard Windows experience: installs to Program Files, creates Start Menu shortcuts, and registers an uninstaller. The zip is a portable alternative.

> **Note:** NSIS builds require native Windows. The cross-compile build script only produces the zip target.

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
renderer/
  index.html         App UI
  renderer.js        UI logic (model picker, file selection, transcription, save)
  style.css          Styles
scripts/
  build.sh           Full build script (download deps + package distributable)
  setup.sh           Dev-only setup (build whisper.cpp from source for local testing)
electron-builder.yml Packaging config (extraResources, targets per platform)
```

**Not checked in** (gitignored, created by scripts):

```
bin/win/             whisper-cli.exe, DLLs, ffmpeg.exe
bin/linux/           whisper-cli, shared libs, ffmpeg
models/              ggml-*.bin model files
.build-whisper/      whisper.cpp source and build tree (Linux only)
node_modules/
dist/                Built distributables
```

## Architecture Notes

- `getPlatformDir()` in `main.js` resolves the `win`/`linux`/`mac` subdirectory for binaries
- `getResourcePath()` handles dev (`__dirname`) vs packaged (`process.resourcesPath`) paths
- Transcription flow: ffmpeg converts input to 16kHz mono WAV temp file, then spawns whisper-cli with `--no-timestamps`
- Thread count: `Math.min(os.cpus() - 1, 8)`
- Linux/macOS set `LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH` for whisper shared libs
- `MODELS` array in `main.js` defines all available models; the `download-model` IPC streams from Hugging Face with progress events
- macOS builds require building on macOS with `bin/mac/` populated manually
