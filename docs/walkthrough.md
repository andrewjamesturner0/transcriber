# Transcriber: A Walkthrough

## 1. What the project actually is

Transcriber is a single-user, local-only Electron desktop app that transcribes audio and video files using [whisper.cpp](https://github.com/ggml-org/whisper.cpp). It runs entirely on-device. No audio, transcript text, or metadata is transmitted over a network. There are no user accounts, no cloud APIs, and no telemetry. After initial model download, the app works offline.

The target audience is anyone who needs transcription without sending audio to a cloud service: researchers with ethics-committee constraints, journalists working with sensitive recordings, and anyone who prefers to keep their data local. Windows is the primary platform; Linux is also supported. macOS packaging exists in the config but is untested.

The app converts an input media file to 16 kHz mono WAV via a bundled ffmpeg binary, runs a bundled whisper-cli binary on that WAV, optionally aligns the recognised words and runs Python-based speaker diarisation, and displays the transcript. The app downloads models once from Hugging Face and caches them locally. GPU acceleration (Vulkan) is auto-detected and can be disabled.

Three constraints define the architecture:

- Local-only, offline processing: everything runs as local subprocesses. No remote inference endpoints. This explains the child-process spawning pattern and the bundling of platform-specific binaries.
- Single-user desktop app: no authentication, no database, no multi-tenancy. Settings live in a flat JSON file in the user data directory. The queue is an in-memory array.
- Cross-platform from a single codebase: Windows is primary, Linux is supported, macOS is aspirational. Path resolution, binary discovery, and environment setup all go through a shared abstraction layer in `lib/paths.js`.

## 2. The 30-second architecture

```
  local media -> FFmpeg -> temp 16 kHz mono WAV
              -> whisper-cli -> text / full JSON
              -> optional align.py -> times for the same words
              -> optional diarize.py -> regular + exclusive speaker timelines
              -> transcript-timing.js -> diarize-merge.js
              -> renderer display or CLI stdout
```

The main process (`main.js`) owns the IPC handlers and transcription orchestration for the GUI. A parallel entry point (`cli.js`) runs the same pipeline from the command line, without launching Electron, for use on headless servers and in batch or agent workflows; see [docs/cli.md](cli.md) for the reference. The renderer (`renderer/renderer.js` + `renderer/queue.js`) owns the UI and queue state. The two communicate through Electron's context bridge (`preload.js`), which exposes a flat `window.api` object. The renderer never touches Node APIs directly; the main process never touches the DOM.

The `lib/` directory holds shared modules used by the main process, the CLI, and the test scripts: path resolution (`paths.js`), capability detection (`capabilities.js`), model metadata and download (`models.js`), the transcription pipeline (`transcription-runner.js`) and the whisper invocation/retry sub-module it composes (`whisper-runner.js`), a shared subprocess helper (`_subprocess.js`), word timing (`transcript-timing.js`), speaker assignment (`diarize-merge.js`), and explicit Python model setup (`diarization-setup.js`). The CLI is structurally constrained to never `require('electron')` and never read or write the GUI's `settings.json`; configuration comes entirely from flags and environment variables.

## 3. The transcription pipeline

The transcription pipeline is the core of the application. It lives in `lib/transcription-runner.js`, extracted from what was previously a large inline function in `main.js`'s `transcribe` IPC handler. The extraction binds long-lived dependencies (capabilities, paths, spawn, log) once at construction time and accepts a small per-call object so the pipeline can be unit-tested without spawning real processes.

### 3.1 lib/transcription-runner.js -- the orchestrator

This module exports a factory: `createTranscriptionRunner({ capabilities, paths, spawn, log, tmpDir? })` returns `{ runTranscription }`. Each call takes `{ filePath, modelId, options, signal, onProgress, onDiarizeProgress }` and resolves to `{ text, json? }` -- `text` is the formatted transcript (with `[Speaker N]` labels when diarisation is on), and `json` is the full whisper JSON output, included only when `options.outputJson` is true. `main.js` builds the runner once at startup, destructures `text` from the result, and returns that to the renderer (which expects a plain string); the CLI uses the `json` field for `--format json`.

The dependency-injection pattern has two purposes. First, it makes the pipeline testable: `scripts/test-transcription-runner.js` passes mock spawn functions, fake binary paths, and fake capability callbacks to exercise orchestration and cancellation without touching the filesystem. Second, it isolates the pipeline from the Electron main process -- the pipeline does not `require('electron')` and does not know about `ipcMain`. It receives `onProgress(msg)` and `onDiarizeProgress(data)` callbacks; `main.js` wires those to `event.sender.send(...)`.

The pipeline runs these steps in order:

1. **FFmpeg conversion.** The input file (audio or video) is converted to 16 kHz mono WAV (`pcm_s16le`) in a temp directory. A 16-format extension whitelist (9 audio, 7 video) controls which files pass the UI, but the pipeline itself trusts the extension to detect video vs. audio for the "Extracting audio..." / "Converting audio..." status message.

2. **Whisper transcription.** The whisper-cli binary is spawned with arguments that depend on the model type and diarization mode:

   - **Plain transcription:** `--no-timestamps` -- whisper outputs raw text, fastest path.
   - **TinyDiarize (tdrz models):** `--tinydiarize` -- the `small.en-tdrz` model was fine-tuned for speaker change detection; it emits `[SPEAKER_TURN]` markers inline. No separate diarization step needed.
   - **Pyannote diarisation:** `--output-json-full` returns token offsets. Ordinary token timing is the default. Explicit `--dtw` adds `--dtw <preset> --no-flash-attn` where supported and consumes valid DTW anchors. Forced-alignment jobs skip DTW so Whisper keeps its default decoder.

   The anti-corruption mode (`-mc 0 --temperature 0.4 --entropy-thold 1.8`) disables cross-segment text conditioning, preventing whisper from entering hallucination loops that produce repeating lines. These specific values come from whisper.cpp issue discussions about repetitive output on certain audio.

3. **Optional alignment.** For `alignment: 'forced'`, `lib/align.py` matches the existing words to the same WAV with a wav2vec2 model and returns times and quality labels. The path search in `lib/alignment_core.py` is adapted from WhisperX 3.8.6 (itself from a TorchAudio tutorial) without installing WhisperX; `lib/alignment_models.py` holds the language-to-model table and the cache-only loaders. A failure keeps Whisper timing and reports the reason; cancellation propagates.

4. **Optional diarisation.** For pyannote jobs (excluding tdrz models), `lib/diarize.py` runs Community-1 offline on the same WAV. `lib/transcript-timing.js` normalises word timing, and `lib/diarize-merge.js` assigns speakers using the exclusive timeline when available. Each Python process exits before the next starts.

The whisper step is delegated to `lib/whisper-runner.js`, which owns arg construction, backend resolution, and two fallback chains:

- **GPU to CPU fallback.** If the active backend is `'vulkan'` and whisper exits non-zero, the runner retries with the CPU binary. It distinguishes OOM errors (`OutOfDeviceMemory`, `failed to allocate`) from other Vulkan failures: OOM doesn't disable GPU for future runs (the next file might be shorter and fit), but non-OOM errors call `capabilities.disableGpu()` which pins the session to CPU.

- **DTW fallback.** A DTW error retries without `--dtw` and `--no-flash-attn`. A successful run that reports DTW disabled records that reason too. Support is tracked per executable, so one backend failure does not disable DTW on the other. Missing or invalid anchors use declared token/segment fallback; the JSON never treats flag support alone as measured timing.

Keeping the retry policy in `whisper-runner.js` means `runTranscription` composes FFmpeg, Whisper, optional alignment and diarisation with no retry-aware branching. Subprocess spawning, logging, abort wiring, and HF-token redaction live in `lib/_subprocess.js`, shared by ffmpeg, whisper, and the diarization step.

Cancellation works through a single `AbortSignal` shared across all subprocesses. Each `_runProcess` call registers an `abort` event listener that calls `proc.kill()`. The `cancel-transcription` IPC handler calls `abort()` on the controller. Because ffmpeg and whisper run sequentially (not in parallel), killing whichever process is currently running is sufficient.

### 3.2 Word timing and speaker assignment

`lib/transcript-timing.js` groups tokens into ordered words and validates
DTW anchors, ordinary offsets and segment times. It records the timing source
and fallback for each word. Zero is valid; negative, reversed and non-finite
times are rejected. DTW anchors are estimated onsets with derived spans,
not measured word durations. Forced alignment labels acoustic matches and
interpolated times separately and leaves unaligned words on Whisper timing.

`lib/diarize-merge.js` assigns one speaker from the word's DTW anchor or span
midpoint. It prefers the exclusive timeline, keeping regular overlap as
evidence. In a gap it checks span overlap, then allows nearby speech within
`gapFillMaxMs` (5 seconds); distant or untimed words remain Unknown.
Consecutive words with the same label form blocks. Cleanup no longer rewrites
short replies, snaps boundaries or smooths labels. Both estimators see the
same WAV and clock; timing disagreement is an estimate error.

See [diarization.md](diarization.md) for the full contract and
[diarization-evaluation.md](diarization-evaluation.md) for the benchmark limits.
`DIARIZE_DEBUG=1` prints an assignment summary on stderr.

### 3.3 Python helpers and setup

`lib/diarize.py` loads pinned Community-1 from the local Hugging Face cache.
It reads the app's PCM WAV with the stdlib `wave` module, runs pyannote.audio
4.x, and writes a versioned envelope with regular and exclusive timelines,
model revision, versions and device. `lib/align.py` loads a prepared language
model and writes per-word timing and quality without replacement text. It
loads its two sibling modules by file path, so it works from any working
directory and from the installed `resources/lib` folder.

Both helpers send JSON progress/errors on stderr, a summary on stdout and
results through a temporary output file. `lib/_subprocess.js` runs and reads
both helpers. Temporary files are deleted after success, failure or cancellation.

`scripts/setup-diarization.py` downloads models explicitly and checks that the
speaker pipeline loads offline. `lib/diarization-setup.js` exposes this through
Settings. The token is used only for setup, passed through the environment and
never saved. Inference sets offline flags and disables telemetry; missing
assets produce a setup message. Python and packages are installed separately
(see [the setup guide](diarization-setup.md)).

### 3.4 lib/capabilities.js -- runtime capability detection

Replaces what was once scattered global state in `main.js` (separate `gpuState`, `dtwState`, `cachedPythonCmd` variables). This module consolidates all runtime probes into a single class with injected settings callbacks.

At startup, `detect()` runs three probes concurrently:
- **GPU detection:** spawns the Vulkan whisper binary with `--help` (5s timeout), parses stderr for `ggml_vulkan:` device lines, and picks a discrete GPU (non-Intel) over integrated. The app rejects Intel GPUs because their Vulkan drivers are unreliable for ML inference.
- **DTW detection:** probes CPU and available Vulkan executables for both `--dtw` and `--no-flash-attn`. Results and failures are cached per backend.
- **Python detection:** uses `TRANSCRIBER_PYTHON` when set, otherwise tries `python3`, `python`, and `py` (Windows). `diarize.py --check` reports Python/package compatibility, CUDA and speaker cache readiness. `align.py --check` reports optional alignment readiness per language. Results can be refreshed after setup.

`getActiveBackend()` resolves the effective backend from the user's preference (auto/cpu/vulkan) and the detection result. The app persists the user preference to `settings.json` in the user data directory.

## 4. The data model

Transcriber has no database. It stores two kinds of persistent data:

### 4.1 Settings (`settings.json`)

A flat JSON file at `app.getPath('userData')/settings.json`. Read and written via `readSettings()` and `writeSettings()` in `main.js`. Keys currently include:

- `gpuBackend`: `'auto'`, `'cpu'`, or `'vulkan'`

There is no schema enforcement or migration logic; a missing backend key defaults to `'auto'`. If more settings are added, the `{ ...existing, ...data }` merge in `writeSettings()` ensures new keys don't clobber old ones.

### 4.2 Models (`models/`)

Model files are `.bin` files downloaded from Hugging Face. `lib/models.js` owns the canonical list (13 entries) along with every per-model fact: filename, label, size, DTW preset, the optional `tdrz` flag, and the optional `hfRepo` override (only `small.en-tdrz` uses it, to pull from `akashmjn/tinydiarize-whisper.cpp` instead of the default `ggerganov/whisper.cpp`). Adding a model is a single-entry edit; the `download-model` IPC handler and the transcription runner both consult the same module via `models.getModel(id)`, `models.getModelPath(id)`, and `models.getDownloadUrl(id)`.

Model download state is computed at runtime: `models.listModels()` maps the spec array, adding a `downloaded` boolean by checking `fs.existsSync()` on each model's path. There is no separate download-state store. If a model file exists, it's downloaded; if not, it isn't.

### 4.3 Log file (`transcriber.log`)

A plain text append-only log at `app.getPath('userData')/logs/transcriber.log`. Rotated when it exceeds 5 MB (the old log is renamed to `transcriber.log.old`, overwriting any previous old log). The log captures all subprocess launches, their stdout/stderr, exit codes, GPU detection results, and diarization failures. In debug builds (marked by a `.debug-build` marker file or `DEBUG_BUILD=1` env var), a debug panel in the settings menu exposes log viewing.

## 5. The UI layer

The renderer loads six scripts in `index.html`: `queue.js`, `media-extensions.js`, `time-estimates.js`, `transcript-format.js`, `job-options.js`, then `renderer.js`. The first five are pure modules (no DOM, no IPC) using the same dual `module.exports` / `window.<namespace>` pattern as `queue.js`, so they are testable in plain Node. `renderer.js` consumes them through `window.mediaExtensions`, `window.timeEstimates`, and `window.transcriptFormat`. There is no framework, no build step, and no bundler. The constraints that drove this: (a) the UI is a single screen with no routing, so a framework adds complexity without benefit; (b) avoiding a build step means contributors can change the renderer code and reload the app without running a watcher; (c) the UI is simple enough (a model picker, a file queue, a transcript output) that vanilla DOM manipulation is sufficient.

### 5.1 renderer/queue.js -- the queue state model

A pure state model with no DOM dependencies. Exports a `createQueue()` factory that returns an object with `enqueue`, `remove`, `clear`, `getItems`, `getSummary`, `getActiveItem`, and `processAll`. Items flow through states: `pending` -> `processing` -> `done` | `error`.

`processAll` processes pending items serially. It accepts an `AbortSignal` and an `onChange` callback. After each item completes or fails, `onChange` fires so the renderer can update the queue list. Error in one item does not stop the queue -- the next pending item proceeds. A corrupt file that crashes ffmpeg should not prevent the rest of the batch from transcribing.

The module runs in both Node (test scripts) and the browser (renderer) via the `if (typeof module !== 'undefined')` check at the bottom.

### 5.2 renderer/renderer.js -- the UI logic

Wires the DOM elements to user actions and IPC events. Key behaviours:

- **File selection** works through both a click-to-browse button (native dialog via `dialog.showOpenDialog`) and drag-and-drop. Dropped files are filtered against a whitelist of 16 extensions. Files that don't match are rejected with a status message.
- **Model download** streams progress from the main process via `download-progress` events. The download button appears only for undownloaded models, determined by the `downloaded` boolean from `get-models`.
- **Transcription** is kicked off by the Transcribe button, which calls `queue.processAll` with a callback that invokes `window.api.transcribe`. The UI shows a progress spinner, an elapsed timer, and a cancel button. After processing, the queue is cleared (completed items are discarded from the UI -- transcripts are shown in the output area, not retained in the queue).
- **Rich display for diarized output:** when pyannote diarization succeeds (detected by `transcriptFormat.isPyannoteDiarized`, a `[N speakers detected]` header check), the renderer replaces the plain textarea with a `div.transcript-rich` containing speaker-colored spans. The block parsing is done by `transcriptFormat.parseRichTranscript`, which clamps speaker numbers above 8 to the highest CSS class. Eight CSS classes (`speaker-1` through `speaker-8`) provide distinct colors. The textarea is kept in sync (hidden) as the plain-text copy/save source.
- **Settings menu** contains the anti-corruption toggle, speaker/alignment model setup and an optional debug panel. Speaker diarisation is enabled only when the supported Python packages and model are ready. The Model card shows **Align words to the audio** while diarisation is on; `job-options.js` controls availability and builds each job's options. The alignment preference is saved in renderer local storage; the token is not saved.
- **Auto-update** uses `electron-updater`'s GitHub provider. The renderer listens for `update-available` (shows "Downloading...") and `update-downloaded` (shows "Update ready -- click to restart"). Version comparison prevents offering downgrades.

### 5.3 preload.js -- the context bridge

A flat list of `contextBridge.exposeInMainWorld` calls. Each function maps to an `ipcRenderer.invoke` or `ipcRenderer.on` call. There is no wrapper or abstraction layer -- the renderer calls `window.api.transcribe(...)` directly. With only ~20 IPC channels and a single window, indirection through a typed API layer would add maintenance cost without reducing coupling.

## 6. Packaging and deployment

### 6.1 Why Electron

Electron was chosen because it provides a cross-platform desktop shell with native file dialogs, auto-updates, and a Chromium renderer -- all from JavaScript. The alternative would be a native GUI toolkit (Qt, GTK, WinUI), but that would require either C++ development or Python packaging (which is notoriously fragile on Windows). Electron's `extraResources` mechanism in `electron-builder.yml` allows bundling arbitrary binary directories alongside the asar, which lets the app ship ffmpeg and whisper-cli.

### 6.2 Platform binary layout

```
bin/
  win/
    cpu/          whisper-cli.exe, whisper.dll, ggml*.dll
    vulkan/       whisper-cli.exe, whisper.dll, ggml*.dll (built in CI only)
    ffmpeg.exe
  linux/
    cpu/          whisper-cli, libwhisper.so, libggml*.so
    vulkan/       whisper-cli, libwhisper.so, libggml*.so
    ffmpeg
```

Each platform gets its own directory. The binary names differ by platform (`.exe` on Windows). `lib/paths.js` abstracts this: `getPlatformDir()` returns `'win'`, `'linux'`, or `'mac'`; `getWhisperBinary(backend)` appends the extension; `makeEnvWithLibPath(binDir)` sets `LD_LIBRARY_PATH` on Linux and `DYLD_LIBRARY_PATH` on macOS for shared-library resolution.

### 6.3 Windows NSIS installer

Built by `electron-builder` with `nsis.oneClick: true`. The installer uses electron-builder's default installation location, creates Start Menu shortcuts and registers an uninstaller. The one-click setting means the user doesn't see an installation wizard -- it installs silently to the default location.

### 6.4 Linux AppImage

An AppImage with Electron and the basic transcription binaries, built with `linux.target: AppImage`. Optional Python packages and speaker/alignment models are installed separately. Running the AppImage needs a supported Linux system and working FUSE setup.

### 6.5 Build script (`scripts/build.sh`)

The single build script handles dependency fetching and packaging. It reads `deps.json` for all URLs and version numbers. This is the single source of truth referenced by both local builds and CI. The script downloads pre-built Windows binaries (whisper-cli from GitHub releases, ffmpeg from gyan.dev) and either builds Linux binaries from source or downloads pre-built ones. The `--debug` flag creates a `.debug-build` marker that gets bundled as an extra resource and enables the debug panel at runtime.

### 6.6 Auto-update

`electron-updater` with the `github` provider checks for new releases on startup. The version comparison (`r[0] > c[0] || ...`) prevents the updater from offering a downgrade if a newer release metadata exists but has a lower semver. This can happen during development when release tags are moved.

## 7. Supporting scripts and tests

| File | What it tests | When to run it |
|------|--------------|----------------|
| `scripts/test-merge.js` | Speaker assignment, short-turn/Unknown preservation, gaps, overlap, exclusive timelines and boundary rules | After any change to `lib/diarize-merge.js` |
| `scripts/test-capabilities.js` | GPU detection fallback, per-executable DTW support, Python/package/cache readiness, preference persistence; ~15 tests using mock spawn and stubs | After any change to `lib/capabilities.js` |
| `scripts/test-transcription-runner.js` | Pipeline orchestration: FFmpeg arg construction, whisper-is-called wiring, cancellation via AbortSignal; ~10 tests using mock spawn | After any change to `lib/transcription-runner.js` |
| `scripts/test-whisper-runner.js` | Whisper arg construction, GPU->CPU fallback, DTW->no-DTW fallback, OOM vs non-OOM classification, cancellation during retry; ~12 tests | After any change to `lib/whisper-runner.js` |
| `scripts/test-models.js` | `getModel` lookup and unknown-id error, `getModelPath`, `getDownloadUrl` default vs `hfRepo` override, `listModels` shape; ~9 tests | After any change to `lib/models.js` |
| `scripts/test-cli.js` | CLI argument parsing for every subcommand (`transcribe`, `download-model`, `list-models`, `gpu-status`), help output, error messages, exit codes, stdout/stderr separation; ~26 subprocess-based tests | After any change to `cli.js` |
| `scripts/test-queue.js` | Queue enqueue/remove/clear/getActiveItem, serial processing, error isolation (one failure doesn't stop the batch), cancellation; ~15 tests | After any change to `renderer/queue.js` |
| `scripts/test-transcript-format.js` | Pyannote detection regex, tinydiarize split-and-join formatting, rich-transcript parsing with speaker-number clamping, speaker counting; ~21 tests | After any change to `renderer/transcript-format.js` |
| `scripts/test-time-estimates.js` | Model-id to time-estimate bucket mapping including the `large-turbo` special case; ~16 tests | After any change to `renderer/time-estimates.js` |
| `scripts/test-renderer-smoke.js` | Loads every renderer script (`queue.js`, `media-extensions.js`, `time-estimates.js`, `transcript-format.js`, `job-options.js`, `renderer.js`) in a minimal browser-like vm context to catch require()-in-renderer bugs, missing globals, and syntax errors | Before any release or PR that touches renderer code |
| `scripts/test-packaging.js` | Verifies that every `require('./lib/...')` in `main.js` resolves to an existing file, that `lib/` is not in top-level `extraResources` (which would move JS modules outside the asar), that Python helpers, setup and requirements are in `extraResources`, and that app files exclude credentials and private working data | Before packaging a release |
| `scripts/test-transcript-timing.js` | Word grouping, timing sources, validation and forced-alignment fallback | After timing changes |
| `scripts/test-job-options.js` | Alignment controls and job options | After UI option changes |
| `scripts/test-diarization-setup.js` | Setup subprocess, token handling and refresh | After setup changes |
| `scripts/test-diarize-contract.py` | Python detector, privacy, output and setup contracts without models | After diarisation/helper changes |
| `scripts/test-align-contract.py` | Alignment-only loading, positional mapping and timing quality without models | After alignment/helper changes |
| `scripts/test-diarization-evaluation.js` | Scoring, denominators and missing metrics on synthetic data | After evaluator changes |
| `scripts/test-whisper-dtw.js` | Real local executable identity and populated DTW anchors | With prepared local audio and model |
| `scripts/test-audio-load.py` | Checks that ffmpeg can load a given audio file | Ad-hoc, when debugging ffmpeg issues |
| `scripts/test-diarize-pipeline.py` | End-to-end diarisation smoke check requiring the prepared speaker model and Python; inference needs no token | After changes to `lib/diarize.py` or when setting up diarization |

All JavaScript tests follow the same plain-Node pattern: no test framework, no assertions library. A `test(name, fn)` function queues tests; `assert(cond, msg)` throws on failure. The test runner prints `PASS`/`FAIL` per test and exits with code 1 on any failure. No dev dependency is added that would need maintenance across Electron version bumps.

## 8. Tech choice summary

| Choice | Why |
|--------|-----|
| Spawning child processes instead of native bindings | Avoids C++ compilation in the Electron app; isolates crashes (a whisper segfault doesn't take down the UI); keeps FFmpeg separate and replaceable; enables clean cancellation via `proc.kill()` |
| whisper.cpp rather than faster-whisper or WhisperX | Ships as a single static binary per platform; no Python dependency for basic transcription; active maintenance; Vulkan GPU support; simplest to bundle into a desktop installer |
| Electron + vanilla DOM instead of Qt/Tauri/React | Cross-platform from one JS codebase; no C++ or Rust toolchain required for contributors; no build step for the renderer (edit and reload); Electron's `extraResources` handles binary bundling cleanly |
| In-memory queue (no persistence) | Queue doesn't need to survive app restarts -- users rebuilding a transcription queue after a crash is acceptable; persistence would add file-format complexity and error handling for corrupt state |
| `deps.json` as single source of truth for versions | Both `scripts/build.sh` and CI workflows read the same file. A weekly CI job (`dep-check.yml`) checks for upstream updates and auto-opens PRs. Manual updates require changing one file |
| No ORM, no database | Single-user app with no structured query needs. Settings fit in one JSON file. The model list is a hardcoded array. Transcripts live in memory until the user saves them |
| Python subprocess for diarization rather than a bundled runtime | Pyannote's dependency tree (PyTorch, transformers, torchaudio) is too large to bundle. The subprocess pattern matches ffmpeg and whisper-cli. Users install Python and pyannote themselves if they want diarization |
| Factory + per-call interface for the transcription pipeline (`lib/transcription-runner.js`) | Long-lived dependencies (capabilities, paths, spawn, log) are bound once at startup; each call passes only job parameters (file, model, options, callbacks, signal). Makes the pipeline testable without spawning real processes and shrinks the `transcribe` IPC handler to a thin adapter |

## 9. How to orient yourself in the repo

1. **`deps.json`** -- the single source of truth for dependency versions. Read this first to understand what the app bundles.

2. **`main.js`** -- the main process: IPC handlers, settings read/write, auto-update wiring. The `transcribe` handler is now a thin adapter that delegates to the runner built at startup by `createTranscriptionRunner`.

3. **`lib/paths.js`** -- platform abstraction: how `getWhisperBinary('vulkan')` resolves to `bin/linux/vulkan/whisper-cli` on Linux and `bin/win/vulkan/whisper-cli.exe` on Windows.

4. **`lib/models.js`** -- canonical model metadata. One entry per model with filename, label, size, DTW preset, and optional `tdrz`/`hfRepo` flags. Add a model here and every consumer (download handler, runner) sees it.

5. **`lib/transcription-runner.js`** + **`lib/whisper-runner.js`** -- the FFmpeg -> Whisper -> optional alignment -> diarise pipeline. `runTranscription` composes these stages; `whisper-runner` owns arg construction and the GPU/DTW retry policy. `lib/_subprocess.js` is the shared spawn helper.

6. **`lib/capabilities.js`** -- GPU, DTW, and Python detection. `detect()` runs three probes at startup. `getActiveBackend()` shows how user preference and hardware detection combine.

7. **`lib/diarize-merge.js`** -- speaker assignment from normalised words and timelines, with structured evidence. `assignSpeakers` returns words, blocks and summaries; `mergeTranscriptWithDiarization` keeps the string API.

8. **`renderer/queue.js`** and **`renderer/renderer.js`** -- the UI side: queue state model and DOM wiring. Look at `processAll` for serial processing and `displayRichTranscript` for the speaker-colored output. Pure helpers live alongside: `renderer/transcript-format.js` (pyannote detection, tinydiarize formatting, rich parsing), `renderer/media-extensions.js`, and `renderer/time-estimates.js`.

9. **`scripts/build.sh`** and **`electron-builder.yml`** -- how the app becomes a Windows NSIS installer or Linux AppImage. `electron-builder.yml` defines `extraResources` (what goes outside the asar) and `nsis`/`AppImage` target settings.
