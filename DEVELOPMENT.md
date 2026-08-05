# Development Guide

## Supported development targets

The model playground supports Windows x64 and Linux x64. Both targets use CPU and the existing Vulkan path. macOS, ARM Linux, CUDA, Metal, and Intel Vulkan acceptance are outside the current feature scope, even where a script or upstream package mentions them.

## Prerequisites

- [Node.js](https://nodejs.org/) 22 or newer
- [Git](https://git-scm.com/)
- `curl` and `unzip`

Linux also needs:

- a C/C++ compiler (`gcc` and `g++`)
- `cmake` 3.10 or newer
- `make`

For a Linux Vulkan build, install the Vulkan headers and `glslc`. CPU-only development does not need them.

## Quick start on Linux

```bash
git clone <repo-url> && cd transcriber
npm install
bash scripts/setup.sh
npm start
```

`scripts/setup.sh` installs the pinned Node dependencies, verifies the Linux x64 transcribe.cpp runtime, builds whisper.cpp, downloads the bundled Tiny English model and FFmpeg, and builds Vulkan whisper.cpp when the required tools are present.

## Building distributables

```bash
bash scripts/build.sh                  # Windows NSIS target by default
bash scripts/build.sh --target linux   # Linux AppImage
bash scripts/build.sh --target all     # Windows and Linux
```

The full command is:

```text
scripts/build.sh [--target win|linux|all] [--skip-deps] [--no-gpu] [--debug]
```

| Flag | Description |
| --- | --- |
| `--target win` | Download Windows whisper.cpp and FFmpeg assets, then build the NSIS package. This is the default. |
| `--target linux` | Build Linux whisper.cpp assets, then build the AppImage. |
| `--target all` | Build both supported package targets. |
| `--skip-deps` | Reuse existing `bin/`, `models/`, and installed Node dependencies. Runtime verification still runs. |
| `--no-gpu` | Skip the Linux Vulkan whisper.cpp build. |
| `--debug` | Include the debug log panel. |

The build script:

1. Runs `npm install` so the exact transcribe.cpp 0.1.3 binding, Koffi 3.1.1, and target native packages from the lockfile are available.
2. Verifies the requested Windows x64 or Linux x64 transcribe.cpp native runtime.
3. Downloads the bundled `ggml-tiny.en.bin` fallback when it is absent.
4. Fetches or builds whisper.cpp and FFmpeg under `bin/{win,linux}/` unless `--skip-deps` is used.
5. Packages the Electron application.

Windows and Linux native package checks also run in release CI. Do not assume that a cross-built package contains the target native library merely because `npm install` succeeded on the host platform.

## Windows development

Use Node 22 or newer. The simplest supported route is to prepare assets and package from a checkout with:

```powershell
npm install
bash scripts/build.sh --target win
```

The Windows build downloads the released CPU whisper.cpp binaries and FFmpeg. Vulkan whisper.cpp binaries are produced on native Windows release CI. The transcribe.cpp worker and its Windows x64 CPU/Vulkan native package are pinned through `package-lock.json` and verified before packaging.

For manual whisper.cpp development, place `whisper-cli.exe` and its DLLs in `bin/win/cpu/`, place `ffmpeg.exe` in `bin/win/`, and place the bundled fallback model in `models/`. This does not replace the required `npm install` and `node scripts/verify-transcribe-runtime.js win32-x64` checks for the transcribe.cpp worker.

## npm scripts

| Script | Description |
| --- | --- |
| `npm start` | Run the Electron app in development mode. |
| `npm run setup` | Run `scripts/setup.sh`. |
| `npm run package` | Build the Windows package. |
| `npm run package:win` | Verify the Windows runtime and build the Windows package. |
| `npm run package:linux` | Verify the Linux runtime and build the Linux package. |
| `npm run package:mac` | Present in the package manifest, but not a supported or accepted model-playground target. |
| `npm run package:all` | Verify Windows/Linux runtimes and invoke all package targets. Do not treat the macOS output as accepted. |

## Project structure

```text
main.js                       Electron main process, IPC, settings, downloads, and jobs
cli.js                        Standalone CLI using the shared catalogue and runners
preload.js                    Narrow renderer IPC bridge
deps.json                     Dependency versions, target packages, and checksums
electron-builder.yml          ASAR, extra resources, and package targets
renderer/
  index.html                  Single-window UI
  renderer.js                 DOM wiring and queue execution
  model-chooser.js            Progressive 19-model chooser state
  job-options.js              Capability-driven current-job option state
  queue.js                    Serial queue state
  media-extensions.js         Accepted media extensions
  time-estimates.js           Whisper time-estimate buckets
  transcript-format.js        Plain and speaker-labelled transcript formatting
  style.css                   Application styles
  fonts/                      Bundled fonts
lib/
  model-catalogue.js          Canonical 19-model metadata and option validation
  models.js                   Download paths, downloaded state, and secure downloads
  transcript-result.js        Engine-neutral result validation and normalisation
  engine-adapters.js          Engine selector
  transcription-runner.js     FFmpeg, selected engine, optional pyannote, and cleanup
  whisper-runner.js           whisper.cpp arguments and retry policy
  transcribe-runner.js        transcribe.cpp option/result adapter
  transcribe-worker-client.js Framed worker lifecycle and recovery
  paths.js                    Dev, packaged, worker, binary, and model paths
  capabilities.js             GPU, DTW, Python, and pyannote probes
  _subprocess.js              Shared child-process helper
  diarize-merge.js            Speaker timing merge
  diarize.py                  pyannote subprocess
  requirements.txt            Python diarisation dependencies
worker/
  transcribe-worker.mjs       Node 22 transcribe.cpp native worker
scripts/
  build.sh                    Dependency preparation and packaging
  setup.sh                    Linux development setup
  verify-transcribe-runtime.js Exact native runtime check
  smoke-packaged-worker.js    Packaged worker protocol smoke test
  run-model-validation.js     Real-model evidence harness
  test-*.js                   Fast assertion-based JavaScript checks
  test-audio-load.py          Python audio-load check
  test-diarize-pipeline.py    Credential-gated pyannote end-to-end check
docs/                         User, architecture, privacy, and validation documentation
```

Generated and downloaded files are not checked in:

```text
bin/                          whisper.cpp and FFmpeg assets
models/                       bundled Tiny English staging model
.build-whisper/               local whisper.cpp source/build tree
node_modules/                 JavaScript and native dependencies
dist/                         built packages
```

Downloaded models do not normally go back into `models/`. The GUI writes them under Electron's writable `userData/models` directory. The standalone CLI uses `TRANSCRIBER_MODEL_DIR` when set, otherwise `%LOCALAPPDATA%/Transcriber/models` on Windows or `$XDG_DATA_HOME/transcriber/models` (defaulting to `~/.local/share/transcriber/models`) on Linux. Both paths fall back to a matching bundled file in `models/`.

## Architecture

The normal job is:

```text
input media
  -> FFmpeg child process creates a temporary 16 kHz mono WAV
  -> catalogue selects an engine adapter
       -> whisper.cpp child process for the 12 retained Whisper models
       -> framed Node 22 worker for supported transcribe.cpp models
  -> engine-neutral transcript result
  -> optional pyannote subprocess and speaker merge for validated word timing
  -> GUI result or CLI stdout
```

`lib/transcription-runner.js` owns conversion, duration limits, adapter selection, pyannote, and temporary-file cleanup. `lib/whisper-runner.js` keeps Whisper-specific flags plus Vulkan-to-CPU and DTW fallback. `lib/transcribe-runner.js` maps capabilities to the framed worker. Native transcribe.cpp code stays outside Electron's main process in `worker/transcribe-worker.mjs`. A failed worker rejects the active job and can be restarted; supported Vulkan failures retry once on CPU.

Every job uses one model and a complete file. The GUI processes queued files serially. There is no built-in model comparison, streaming control, or parallel model execution.

## Catalogue and downloads

`lib/model-catalogue.js` is the single capability source for all 19 entries. It records status, engine, source revision, checksum, size, licence, languages, timing, pyannote validation, supported backends, and job-option rules. The 12 Whisper entries are Recommended baselines. Parakeet, Moonshine, and Nemotron are Candidates. Qwen3-ASR, Canary, MedASR, and MOSS are Experimental. MOSS is visible but has `runtimeAvailable: false` with the pinned transcribe.cpp 0.1.3 runtime.

`lib/models.js` downloads to a `.download` file, checks SHA-256, and renames only after verification. Failed and interrupted partials are removed. Hugging Face bearer tokens are attached only to approved Hugging Face HTTPS hosts and are reconsidered after every redirect. MedASR is gated and requires accepted upstream access. A model counts as downloaded when its expected file exists.

## Settings and Job options

Settings are stored in `app.getPath('userData')/settings.json`. The main process currently persists:

- `gpuBackend`: `auto`, `cpu`, or `vulkan`
- `hfToken`: a saved Hugging Face token, never returned to the renderer

The renderer receives only safe GPU/pyannote status and `hfTokenConfigured`.

Choices for the current job are not settings. Job options contain job mode, source and target language, speaker labels, expected speakers, and Reduce repeated text. The shared catalogue validator controls them in both GUI and CLI.

## Speaker diarisation

TinyDiarize and `small.en-tdrz` have been removed. Speaker labelling uses pyannote only when the selected model has word timing validated against `lib/diarize-merge.js`. The current validated set is the 12 retained Whisper models. New-family word timing does not enable pyannote until the separate validation gates pass.

Application Settings holds Python, pyannote, Hugging Face, and device setup. Enabling speaker labels and choosing an expected speaker count are current-job choices under Job options.

See [docs/diarization.md](docs/diarization.md) and [docs/diarization-setup.md](docs/diarization-setup.md).

## Tests

Run the complete credential-free JavaScript suite:

```bash
for test_file in scripts/test-*.js; do node "$test_file" || exit 1; done
```

There are currently 20 JavaScript test files. They cover capabilities, CLI, job options, merge behaviour, secure downloads, catalogue/options/promotion, model chooser UI, packaging, queue behaviour, renderer smoke checks, validation-harness behaviour, time estimates, transcribe.cpp adapter/worker, transcript formatting/results, pipeline orchestration, and whisper.cpp retry behaviour.

Useful focused commands are:

```bash
node scripts/test-models.js
node scripts/test-model-options.js
node scripts/test-model-download.js
node scripts/test-cli.js
node scripts/test-transcribe-worker-client.js
node scripts/test-transcribe-runner.js
node scripts/test-transcription-runner.js
node scripts/test-model-playground-ui.js
node scripts/test-renderer-smoke.js
node scripts/test-packaging.js
```

The real pyannote and model acceptance checks are separate:

```bash
python3 scripts/test-audio-load.py
python3 scripts/test-diarize-pipeline.py --hf-token "$HF_TOKEN" --audio <speaker-fixture.wav>
node scripts/run-model-validation.js --help
```

Do not describe a Candidate as Recommended, enable pyannote for a new family, or claim a platform/backend passed acceptance without the evidence required by [docs/model-validation.md](docs/model-validation.md).

## Dependency updates

`deps.json` is the source of truth for whisper.cpp, FFmpeg, Electron, Node, and transcribe.cpp runtime pins. `scripts/setup.sh`, `scripts/build.sh`, runtime verification, and release CI consume it. The weekly dependency workflow checks upstream releases and FFmpeg checksums.

## FFmpeg

FFmpeg is bundled as a separate executable and spawned for conversion. See [docs/ffmpeg.md](docs/ffmpeg.md) for sources, licensing, and replacement details.
