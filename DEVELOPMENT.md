# Development Guide

## Prerequisites

- [Node.js](https://nodejs.org/) >= 22.12
- [Git](https://git-scm.com/)
- `unzip` for local Windows archives, and `tar` with xz support for Linux archives. Build downloads use Node's HTTP client.

**Linux only** (for building whisper.cpp from source):
- A C/C++ compiler (`gcc` / `g++`)
- `cmake` >= 3.10
- `make`
- For Vulkan builds: `libvulkan-dev`, `glslc`, and `spirv-headers`

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
| `--skip-deps` | Verify existing binary provenance and default model, then package without fetching/building |
| `--no-gpu` | Skip building Vulkan GPU binaries (CPU only) |
| `--debug` | Include debug panel in settings (log file viewer) |

The script runs these steps:

1. `npm install`
2. Verifies or downloads the bundled model (`ggml-tiny.en.bin`, 75 MB) from its pinned Hugging Face revision, checking SHA-256 and size before installation
3. Fetches or builds platform-specific binaries into `bin/{win,linux}/{cpu,vulkan}/`
   - **Windows**: pre-built CPU `whisper-cli.exe` + DLLs from [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases), `ffmpeg.exe` from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/)
   - **Linux**: clones whisper.cpp, builds CPU and Vulkan variants with cmake, downloads static ffmpeg from [johnvansickle.com](https://johnvansickle.com/ffmpeg/)
   - Vulkan binaries: for Linux, built from source (requires Vulkan SDK); for Windows, Vulkan binaries are built in CI only (local Windows builds download pre-built CPU binaries). Skipped with `--no-gpu`
4. Runs `electron-builder` to produce the distributable in `dist/`

`scripts/build-deps.js` shares the fetch/identity policy with both local scripts
and the native Windows/Linux release workflow. Whisper source must match the
manifest's tag and commit with no tracked edits; old CMake outputs need matching
source provenance. Binary receipts bind the version, revision, architecture,
CPU/Vulkan variant and every copied file hash. FFmpeg archives must match their
existing SHA-256 before extraction. Downloads use unique temporary paths and
HTTP failure handling, and only become final assets after validation.

An existing checkout or binary cache with unknown provenance stops the build,
including `--skip-deps`. Move that cache aside explicitly and rerun to create a
verified replacement. Do not stamp old files or change a trust hash simply to
silence a mismatch. A mutable FFmpeg URL may legitimately change upstream; its
new identity needs review before updating `deps.json`.

## Windows Native Build

Build and run the app directly on Windows without cross-compiling from Linux.

### Prerequisites

1. **Node.js** >= 22.12: [Download](https://nodejs.org/)
2. **Git for Windows**: [Download](https://git-scm.com/download/win)
3. **Visual Studio Build Tools** (for compiling whisper.cpp):
   - Download [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
   - Select **"Desktop development with C++"** workload
4. **CMake** (if not using Visual Studio's bundled version): [Download](https://cmake.org/download/)

Optional for GPU acceleration:
- **CUDA Toolkit**: [Download](https://developer.nvidia.com/cuda-downloads) (for NVIDIA GPU support)

### Option A: Pre-built binaries (recommended)

```powershell
git clone <repo-url>
cd transcriber
npm install

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
New-Item -ItemType Directory -Force bin\win\cpu, models | Out-Null

# Fetch the pinned release archive and verify before extraction
node scripts/build-deps.js fetch whisper-win whisper.zip
Expand-Archive -Path whisper.zip -DestinationPath whisper-temp -Force
Copy-Item whisper-temp\Release\* bin\win\cpu\ -Force
node scripts/build-deps.js record whisper-win-cpu bin/win/cpu
Remove-Item whisper.zip, whisper-temp -Recurse -Force

# Download ffmpeg
node scripts/build-deps.js fetch ffmpeg-win ffmpeg.zip
Expand-Archive -Path ffmpeg.zip -DestinationPath ffmpeg-temp -Force
Copy-Item ffmpeg-temp\ffmpeg-*\bin\ffmpeg.exe bin\win\
node scripts/build-deps.js record-file ffmpeg-win bin/win/ffmpeg.exe
Remove-Item ffmpeg.zip, ffmpeg-temp -Recurse -Force

# Download the default model
node scripts/build-deps.js fetch model models/ggml-tiny.en.bin
```

### Option B: Build whisper.cpp from source

For custom builds or GPU support:

```powershell
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
node scripts/build-deps.js source .build-whisper

# CPU only, from the pinned source
cmake -S .build-whisper -B .build-whisper/build-cpu -DBUILD_SHARED_LIBS=ON

# Or with CUDA support (requires CUDA Toolkit)
# cmake -S .build-whisper -B .build-whisper/build-cpu -DBUILD_SHARED_LIBS=ON -DGGML_CUDA=ON

cmake --build .build-whisper/build-cpu --config Release
Copy-Item .build-whisper\build-cpu\bin\Release\whisper-cli.exe bin\win\cpu\
Copy-Item .build-whisper\build-cpu\bin\Release\*.dll bin\win\cpu\

# Still need ffmpeg and model; see Option A for download commands
```

Custom source builds above are for development. They do not acquire an archive
receipt automatically. The verified local packaging script refuses unrecorded
outputs; for native Vulkan release builds, follow `.github/workflows/release.yml`.
Native Windows CI is configured to run the release commands; execution and
installer evidence remain pending. Linux shell fixtures do not prove them.

### Run and package

```powershell
npm start              # development mode
npm run package        # produces dist/ with NSIS installer
```

The NSIS installer (`Transcriber-Setup-<version>.exe`) uses electron-builder's default installation location, creates Start Menu shortcuts and registers an uninstaller.

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Run in development mode (requires `scripts/setup.sh` first on Linux) |
| `npm run setup` | Alias for `bash scripts/setup.sh` |
| `npm run package` | Package for Windows (same as `package:win`) |
| `npm run package:win` | Package for Windows |
| `npm run package:linux` | Package for Linux |
| `npm run package:mac` | Package for macOS |
| `npm run package:all` | Package for all platforms |

## Project Structure

```
main.js              Electron main process; IPC handlers, window creation, settings
cli.js               Command-line entry point; same pipeline as the GUI, no Electron
preload.js           Context bridge between main and renderer
deps.json            Single source of truth for dependency versions and URLs
renderer/
  index.html         App UI
  renderer.js        UI logic (wires queue model to DOM, IPC handlers)
  queue.js           Queue state model (pending -> processing -> done/error)
  job-options.js     Speaker labelling availability and per-job option construction
  media-extensions.js Supported file extensions whitelist
  time-estimates.js  Model-id to time-estimate bucket mapping
  transcript-format.js Diarization output formatting and rich-transcript parsing
  style.css          Styles
  fonts/             Bundled fonts
lib/
  paths.js                Shared binary-path resolution (dev vs. packaged, platform dir)
  capabilities.js         GPU/DTW/Python capability detection (consolidated from main.js)
  models.js               Canonical model metadata (filenames, DTW presets, download URLs)
  model-store.js          Caller-owned availability, paths and download ownership
  model-download.js       Atomic cancellable HTTPS model transfers
  logging.js              Bounded asynchronous diagnostics
  operation-manager.js    Work admission, cancellation and shutdown
  transcription-runner.js FFmpeg -> whisper -> optional align -> diarize pipeline factory
  whisper-runner.js       Whisper-cli arg construction, backend resolution, GPU/DTW fallback retry
  _subprocess.js          Shared subprocess spawn helper (used by ffmpeg, whisper, diarization)
  transcript-timing.js   Word timing validation, grouping and alignment provenance
  diarize-merge.js        Speaker assignment and transcript formatting
  diarization-setup.js    Explicit Python model setup runner
  diarize.py              Offline Community-1 speaker inference and readiness check
  align.py                Offline word alignment (part of speaker labelling) and readiness check
  pcm_audio.py            Shared strict 16-bit mono PCM WAV loading
  alignment_models.py     Alignment language/model registry and cache-only loaders
  alignment_core.py       Alignment path search (adapted from WhisperX 3.8.6 / TorchAudio)
  third_party/            Upstream licence notices for the adapted alignment code
  requirements.txt        Pinned Python dependencies for speaker labelling (diarization and alignment)
assets/              App icons (icon.png, icon-512.png, icon-1024.png, icon.svg)
scripts/
  build.sh                 Full build script (download deps + package distributable)
  setup.sh                 Dev-only setup (build whisper.cpp from source for local testing)
  build-deps.js            Pinned source, archive and binary-cache verification
  test-build-deps.js       Local HTTP/git/build policy fixtures
  run-tests.js             Deterministic, tensor maths and Electron test categories
  benchmark-merge.js       Synthetic exact-parity speaker assignment benchmark
  setup-diarization.py     Download speaker/alignment models; check readiness
  test-merge.js                 Unit tests for the diarization merge logic (no model needed)
  test-capabilities.js          Unit tests for lib/capabilities.js (GPU, DTW, Python)
  test-transcription-runner.js  Unit tests for the transcription pipeline (FFmpeg, whisper, fallbacks)
  test-whisper-runner.js        Unit tests for whisper arg construction and retry policy
  test-models.js                Unit tests for model metadata module
  test-cli.js                   Subprocess tests for cli.js (arg parsing, exit codes, output streams)
  test-queue.js                 Unit tests for the queue state model (enqueue, processAll, cancel)
  test-renderer-smoke.js        Smoke test: loads renderer scripts in a browser-like vm context
  test-renderer-dom.js          Real Electron renderer behaviour
  test-electron-lifecycle.js    Real Electron shutdown with harmless child trees
  test-gui-transcript-contract.js Structured result and rendering contracts
  test-cli-pipeline.js          CLI subprocess pipeline through harmless executables
  test-model-store.js           Writable/bundled model lookup and availability
  test-model-download.js        Atomic transport failure/cancellation fixtures
  test-subprocess.js            Bounded diagnostics and child-tree cancellation
  test-logging.js               Rotation, queue pressure and logger closure
  test-operation-manager.js     Admission and shutdown ownership
  test-main-lifecycle.js        Main-process integration boundaries
  test-packaging.js             Static check: require() consistency vs electron-builder.yml
  test-diarize-pipeline.py End-to-end diarization test (requires prepared model + Python)
  test-diarize-contract.py Offline diarization/setup contract tests
  test-align-contract.py  Offline alignment contract tests
  test-alignment-models.py Offline alignment registry/loader tests (stubbed)
  test-alignment-core.py   Alignment maths tests with real torch tensors (no model)
  test-alignment-isolation.py Real offline check with removed packages blocked (needs the English model)
  test-alignment-runtime.py Real comparison against a saved alignment (needs a model)
  test-pcm-audio.py        Shared PCM decoder contracts and opt-in tensor maths
  test-audio-load.py       Checks ffmpeg can load a given audio file
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
models/              Bundled models and CLI downloads (development GUI fallback)
.build-whisper/      Pinned whisper.cpp source and build tree
node_modules/
dist/                Built distributables
```

## Architecture Notes

See [the walkthrough](docs/walkthrough.md) for the module and data-flow overview.

- `lib/paths.js` owns all binary-path resolution: `getPlatformDir()` resolves `win`/`linux`/`mac`, `getResourcePath()` handles dev vs. packaged, `getWhisperBinary(backend)` and `getFfmpegBinary()` return binary paths
- `lib/capabilities.js` consolidates GPU backend detection, DTW support probing, and Python/pyannote availability into a single module (formerly scattered global state in main.js)
- `lib/transcription-runner.js` orchestrates the FFmpeg -> whisper -> diarize pipeline via a `createTranscriptionRunner` factory. Long-lived dependencies (binary paths, spawn, capabilities) are bound at construction time; per-call job parameters (file, model, options, callbacks, signal) are passed to `runTranscription`. Composes `lib/whisper-runner.js` for the whisper step.
- Transcription flow: FFmpeg converts input to 16 kHz mono WAV, then whisper-cli transcribes. Pyannote jobs request full JSON, keep flash attention and re-time words with forced alignment by default (Whisper token timing is the fallback). Explicit CLI `--dtw` adds `--dtw <preset> --no-flash-attn` where supported. Forced jobs skip DTW and align the same text before speaker inference.
- Whisper thread count: `options.threads || 4` in `lib/whisper-runner.js`; GUI and CLI use the default four threads.
- Linux/macOS set `LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH` for whisper shared libs
- `lib/models.js` defines canonical metadata (13 entries). `lib/model-store.js` owns availability, paths and installation; `lib/model-download.js` handles atomic HTTPS transfers. GUI downloads go to `app.getPath('userData')/models`, prefer writable files and fall back to bundled `resources/models` (repository `models/` in development). CLI downloads stay in repository `models/`; listing, inference and downloading use the same store in each caller.
- English-only models pass `-l en`; multilingual models pass `-l auto` across plain, JSON and speaker-labelled paths.
- GUI IPC returns canonical `text` plus a versioned `transcript` structure with blocks, speakers, attribution, alignment and warnings. The legacy string IPC adapter remains available. The renderer reads blocks directly and uses canonical text for copy/save.
- Queue results/errors are retained in memory until removed or cleared. Each batch captures only its initial pending IDs; new items wait for the next batch. Cancellation marks the active item cancelled and preserves unstarted work. The renderer reads model/options for each file, keeps batch errors/fallback warnings visible and restores controls in `finally`.
- `lib/logging.js` serialises asynchronous diagnostic writes with a 1 MiB queue and 5 MiB current/rotated file limits. It can truncate/drop diagnostics with an overflow summary; transcript result data is kept separately.
- GPU acceleration: ships both CPU and Vulkan whisper-cli binaries; at startup, tests the Vulkan binary with `--help` (5s timeout) and caches the result. If Vulkan fails mid-transcription, transparently retries with CPU
- Backend preference stored in `settings.json` in `app.getPath('userData')`
- macOS builds require building on macOS with `bin/mac/` populated manually

`electron-builder.yml` lists the app code, assets and public documentation to
include. It excludes `.env` files, `.agents/`, `Examples/` and local build trees;
binaries and models are copied separately as extra resources. Gitignore alone does not
exclude private data from a package. Runtime Python helpers, the two alignment
sibling modules and their upstream notices remain explicit extra resources
(Python cannot import from inside the asar); JavaScript stays inside the asar.

## Diarization Architecture

Speaker labelling is optional, but has no partial mode: every labelled job
runs word alignment and then pyannote. Install Python 3.10 to 3.13 and the
pinned `lib/requirements.txt` packages (transformers 4.57.6 is there for the
non-torchaudio alignment languages), then prepare Community-1 and the English
alignment model with `scripts/setup-diarization.py --alignment`.
`TRANSCRIBER_PYTHON` selects the same interpreter for checks, setup and jobs. See [the setup guide](docs/diarization-setup.md)
for installation and the measured package footprint.

### Flow

```
FFmpeg -> whisper-cli full JSON
       -> lib/align.py (existing text, same WAV; skipped only by CLI --alignment whisper)
       -> lib/diarize.py (Community-1, same WAV, offline)
       -> transcript-timing.js -> diarize-merge.js -> speaker-labelled text
```

Every model stage runs in a separate process. Ordinary token timing is the
default. Explicit CLI `--dtw` needs `--no-flash-attn`; its anchor is an estimated
onset rather than a measured word interval. Otherwise ordinary token offsets,
segment times or missing timing are recorded. Forced jobs keep Whisper's
default decoder and record measured, interpolated or unaligned words.

The exclusive speaker timeline decides word labels when available; the
regular timeline records overlap evidence. Short replies and Unknown are
preserved through formatting. See [the pipeline guide](docs/diarization.md)
for assignment rules, JSON fields and failure behaviour.

### Setup and subprocess protocol

Setup is the only Python step that downloads assets. The Hugging Face token
is passed in the setup process environment and is never saved. Inference
sets offline flags, disables telemetry and reports missing caches instead
of downloading.

Both Python helpers send JSON progress/error lines on stderr and a final
summary on stdout. `diarize.py` writes a versioned `transcriber-diarization`
envelope with model revision, versions, device, regular and exclusive
timelines. `align.py` writes a `transcriber-alignment` envelope with per-word
times and quality; it returns no replacement text.

After setup, test the helper directly on a 16 kHz mono PCM WAV:

```bash
python lib/diarize.py --check --load
python lib/diarize.py --audio test.wav --output out.json
```

### Tests and evaluation

Deterministic checks need no model downloads:

```bash
npm test                         # deterministic Node + stdlib Python contracts
npm run test:maths                # NumPy/PyTorch tensor maths, no weights
npm run test:electron             # real Electron DOM + lifecycle fixtures
# Linux without a desktop session:
xvfb-run -a npm run test:electron
node scripts/benchmark-merge.js --runs 7 --compare-reference
```

Set `TRANSCRIBER_TEST_PYTHON` to the interpreter for deterministic or maths
checks; otherwise the runner uses `python3` (Windows: `py -3`). The maths
category needs NumPy/PyTorch and fails if they are missing. Electron fixtures
need the installed Electron runtime and a display or Xvfb. They exercise real
DOM behaviour and harmless child-process cleanup without recordings/models.
CI is configured to run deterministic/Electron categories on Windows and
Linux, with maths in a separate Linux job. A dry package build does not prove installed-app or
real-model acceptance.

`scripts/test-whisper-dtw.js`, `scripts/test-diarize-pipeline.py`,
`scripts/test-alignment-isolation.py` and `scripts/test-alignment-runtime.py`
use real local assets and are separate smoke checks. Run the last two under
`unshare -Urn` on Linux so external networking is absent; their docstrings
give the full commands. Speaker accuracy is scored with a local evaluation
harness and notes that are not in the repository (`.agents/scripts/` and
`.agents/docs/`). Current speaker accuracy and Windows/Linux acceptance checks
remain incomplete.

### Cancellation

FFmpeg, Whisper, alignment and diarisation share one `AbortSignal`. Cancelling
targets the active process tree and waits for termination before removing the
job's private temporary directory. POSIX groups get five seconds graceful and
two seconds forced termination; Windows uses `taskkill /T /F`. Direct Whisper
JSON callers receive an explicit cleanup function for the private output
directory when they do not supply a JSON prefix. Alignment failures retain
Whisper timing; diarisation failures retain plain text. Cancellation propagates
rather than starting a fallback job.

`lib/operation-manager.js` reserves jobs before awaits and owns transcription,
setup and model downloads. App quit/update closes admission, aborts owned work,
disposes capability probes and flushes/closes the logger. The shutdown deadline
is ten seconds; a timeout can leave processes or temporary files behind.
Native Windows child-tree and installed-package acceptance still need separate
evidence.

## Dependency Updates

All external dependency versions and download URLs are centralized in `deps.json`. Both `scripts/build.sh`, `scripts/setup.sh`, and `.github/workflows/release.yml` read from it.

### Automated checks

A weekly GitHub Actions workflow (`.github/workflows/dep-check.yml`) runs every Monday:

1. Checks the latest whisper.cpp release with the required Windows binary against `deps.json`
2. Downloads ffmpeg archives and compares SHA-256 checksums against stored values
3. Checks the latest Electron release and updates `package.json` and `package-lock.json`
4. If anything changed, opens a dependency update PR

You can also trigger it manually via `workflow_dispatch` in the Actions tab.

### Manual update

To bump whisper.cpp manually, edit `deps.json`:

```json
{ "whisper": { "version": "v1.9.2", ... } }
```

Update the matching `whisper.revision`, Windows asset SHA-256 and size from
reviewed upstream tag/release evidence too. Builds refuse a tag/commit mismatch
and do not treat an old receipt as the new version. The default model also has
an immutable revision URL, size and SHA-256. Review any FFmpeg archive change
against its existing hash before updating trust data. The weekly workflow
proposes version/checksum changes; it does not resolve all Whisper trust fields,
so a generated PR needs this review before the release can build.

## FFmpeg

FFmpeg is bundled as a standalone binary and spawned as a child process. See [docs/ffmpeg.md](docs/ffmpeg.md) for details on sources, licensing, and how to replace the bundled binary.
