# Whisper Transcriber

A desktop app for transcribing audio files locally using [whisper.cpp](https://github.com/ggml-org/whisper.cpp). Your audio never leaves your computer.

Supports MP3, WAV, FLAC, M4A, OGG, WebM, WMA, and AAC input. Outputs plain text. Includes a model picker to download and switch between Whisper models (from Tiny at 75 MB to Large-v3 at 3.1 GB).

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Git](https://git-scm.com/)
- `curl` and `unzip` (available by default on most systems)

**Linux only** (for building whisper.cpp from source):
- A C/C++ compiler (`gcc` / `g++`)
- `cmake` >= 3.10
- `make`

## Quick Start (Development)

```bash
git clone <repo-url> && cd transciption
npm install
```

### Windows target (cross-compile from Linux)

Downloads pre-built Windows binaries for whisper.cpp and ffmpeg:

```bash
bash scripts/build.sh                # builds dist/Whisper Transcriber-*-win.zip
```

### Linux target

Compiles whisper.cpp from source and downloads a static ffmpeg:

```bash
bash scripts/build.sh --target linux  # builds dist/Whisper Transcriber-*.AppImage
```

### Both targets

```bash
bash scripts/build.sh --target all
```

### Run locally (Linux dev mode)

For iterating on the UI or app logic without building a distributable:

```bash
bash scripts/setup.sh   # one-time: builds whisper.cpp, downloads model + ffmpeg into bin/linux/ and models/
npm start                # launches the Electron app
```

### Windows native build

Build and run the app directly on Windows without cross-compiling from Linux.

#### Prerequisites

1. **Node.js** >= 18 — [Download](https://nodejs.org/)
2. **Git for Windows** — [Download](https://git-scm.com/download/win)
3. **Visual Studio Build Tools** (for compiling whisper.cpp):
   - Download [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
   - During installation, select **"Desktop development with C++"** workload
   - This includes MSVC compiler, Windows SDK, and CMake
4. **CMake** (if not using Visual Studio's bundled version) — [Download](https://cmake.org/download/)

Optional for GPU acceleration:
- **CUDA Toolkit** — [Download](https://developer.nvidia.com/cuda-downloads) (for NVIDIA GPU support)

#### Setup steps

Open **PowerShell** or **Git Bash** and run:

```powershell
# Clone and install dependencies
git clone <repo-url>
cd transciption
npm install

# Create directories
mkdir -p bin\win
mkdir -p models
```

#### Option A: Use pre-built binaries (recommended)

Download pre-built whisper.cpp and ffmpeg binaries:

```powershell
# Download whisper.cpp release (adjust version as needed)
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

#### Option B: Build whisper.cpp from source

For custom builds or GPU support:

```powershell
# Clone whisper.cpp
git clone https://github.com/ggml-org/whisper.cpp.git .build-whisper
cd .build-whisper

# Configure with CMake (CPU only)
cmake -B build -DBUILD_SHARED_LIBS=ON

# Or configure with CUDA support (requires CUDA Toolkit)
# cmake -B build -DBUILD_SHARED_LIBS=ON -DGGML_CUDA=ON

# Build
cmake --build build --config Release

# Copy binaries to bin/win/
cd ..
Copy-Item .build-whisper\build\bin\Release\whisper-cli.exe bin\win\
Copy-Item .build-whisper\build\bin\Release\*.dll bin\win\

# Still need ffmpeg and model (see Option A for download commands)
```

#### Run in development mode

```powershell
npm start
```

#### Package for distribution

```powershell
npm run package
```

This creates both outputs in `dist\`:
- `Whisper Transcriber Setup <version>.exe` — NSIS installer (recommended for distribution)
- `Whisper Transcriber-<version>-win.zip` — portable zip

The NSIS installer provides the standard Windows experience: installs to Program Files, creates Start Menu shortcuts, and registers an uninstaller in Add/Remove Programs.

> **Note:** NSIS builds require native Windows. The cross-compile build script (`scripts/build.sh`) only produces the zip target since NSIS doesn't work under WSL.

## Build Script Reference

```
scripts/build.sh [--target win|linux|all] [--skip-deps]
```

| Flag | Description |
|------|-------------|
| `--target win` | **(default)** Download Windows binaries, package as zip |
| `--target linux` | Build whisper.cpp from source, package as AppImage |
| `--target all` | Build both Windows and Linux |
| `--skip-deps` | Skip downloading/building binaries (reuse existing `bin/` and `models/`) |

The script runs these steps in order:

1. `npm install` — installs Electron and electron-builder
2. Downloads the bundled model (`ggml-tiny.en.bin`, 75 MB) from Hugging Face
3. Fetches or builds platform-specific binaries into `bin/{win,linux}/`
   - **Windows**: downloads pre-built `whisper-cli.exe` + DLLs from the [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases) and `ffmpeg.exe` from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/)
   - **Linux**: clones whisper.cpp, builds with cmake, downloads a static ffmpeg from [johnvansickle.com](https://johnvansickle.com/ffmpeg/)
4. Runs `electron-builder` to produce the distributable in `dist/`

## Output

| Target | Output | How to run |
|--------|--------|------------|
| Windows (native) | `dist/Whisper Transcriber Setup <version>.exe` | Run installer, then launch from Start Menu |
| Windows (cross-compile) | `dist/Whisper Transcriber-<version>-win.zip` | Extract zip, run `Whisper Transcriber.exe` |
| Linux | `dist/Whisper Transcriber-<version>.AppImage` | `chmod +x` and run directly |

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Run the app in development mode (requires `scripts/setup.sh` first) |
| `npm run setup` | Alias for `bash scripts/setup.sh` (Linux dev binaries) |
| `npm run package` | Package for Windows using electron-builder |
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

## Models

The app ships with `ggml-tiny.en.bin` (75 MB, English-only). Additional models can be downloaded from within the app using the model picker dropdown. Available models:

| Model | Size | Languages |
|-------|------|-----------|
| Tiny | 75 MB | English or multilingual |
| Base | 142 MB | English or multilingual |
| Small | 466 MB | English or multilingual |
| Medium | 1.5 GB | English or multilingual |
| Large v3 | 3.1 GB | Multilingual |

Larger models produce more accurate transcriptions but require more RAM and processing time.

## Notes

- The NSIS installer target (`nsis` in `electron-builder.yml`) requires a native Linux environment or Windows. It does not work under WSL. The build script defaults to producing a zip for Windows instead.
- macOS builds (`npm run package:mac`) require building on macOS with the appropriate `bin/mac/` binaries populated manually.
- The app auto-detects CPU core count and uses up to 8 threads for transcription.
