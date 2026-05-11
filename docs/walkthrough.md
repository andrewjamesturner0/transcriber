# Transcriber: A Walkthrough

## 1. What the project actually is

Transcriber is a single-user, local-only Electron desktop app that transcribes audio and video files using [whisper.cpp](https://github.com/ggml-org/whisper.cpp). It runs entirely on-device. No audio, transcript text, or metadata is transmitted over a network. There are no user accounts, no cloud APIs, and no telemetry. After initial model download, the app works offline.

The target audience is anyone who needs transcription without sending audio to a cloud service: researchers with ethics-committee constraints, journalists working with sensitive recordings, and anyone who prefers to keep their data local. Windows is the primary platform; Linux is also supported. macOS packaging exists in the config but is untested.

The app converts an input media file to 16 kHz mono WAV via a bundled ffmpeg binary, runs a bundled whisper-cli binary on that WAV, optionally runs a Python-based speaker diarization pipeline, and displays the transcript. The app downloads models once from Hugging Face and caches them locally. GPU acceleration (Vulkan) is auto-detected and can be disabled.

Three constraints define the architecture:

- Local-only, offline processing: everything runs as local subprocesses. No remote inference endpoints. This drives the child-process spawning pattern and the bundling of platform-specific binaries.
- Single-user desktop app: no authentication, no database, no multi-tenancy. Settings live in a flat JSON file in the user data directory. The queue is an in-memory array.
- Cross-platform from a single codebase: Windows is primary, Linux is supported, macOS is aspirational. Path resolution, binary discovery, and environment setup all go through a shared abstraction layer in `lib/paths.js`.

## 2. The 30-second architecture

```
  media file on disk
      |
      | [ main.js: transcribe IPC handler ]
      v
  ffmpeg (child process) ──> temp 16kHz mono WAV
      |
      v
  whisper-cli (child process) ──> transcript text / JSON
      |                              |
      |                              | [ optional, if diarization enabled ]
      |                              v
      |                   diarize.py (child process) ──> speaker segments
      |                              |
      |                              v
      |                   diarize-merge.js ──> speaker-labeled transcript
      |
      v
  renderer: textarea or rich HTML display
```

The main process (`main.js`) owns the IPC handlers and transcription orchestration. The renderer (`renderer/renderer.js` + `renderer/queue.js`) owns the UI and queue state. The two communicate through Electron's context bridge (`preload.js`), which exposes a flat `window.api` object. The renderer never touches Node APIs directly; the main process never touches the DOM.

The `lib/` directory holds shared modules used by the main process and the test scripts: path resolution (`paths.js`), capability detection (`capabilities.js`), model metadata (`models.js`), the transcription pipeline (`transcription-runner.js`) and the whisper invocation/retry sub-module it composes (`whisper-runner.js`), a shared subprocess helper (`_subprocess.js`), and the diarization merge algorithm (`diarize-merge.js`).

## 3. The transcription pipeline

The transcription pipeline is the core of the application. It lives in `lib/transcription-runner.js`, extracted from what was previously a large inline function in `main.js`'s `transcribe` IPC handler. The extraction binds long-lived dependencies (capabilities, paths, spawn, log) once at construction time and accepts a small per-call object so the pipeline can be unit-tested without spawning real processes.

### 3.1 lib/transcription-runner.js -- the orchestrator

This module exports a factory: `createTranscriptionRunner({ capabilities, paths, spawn, log, tmpDir? })` returns `{ runTranscription }`. Each call takes `{ filePath, modelId, options, signal, onProgress, onDiarizeProgress }` and returns the transcript text. `main.js` builds the runner once at startup and reuses it across every `transcribe` IPC invocation.

The dependency-injection pattern serves two purposes. First, it makes the pipeline testable: `scripts/test-transcription-runner.js` passes mock spawn functions, fake binary paths, and fake capability callbacks to exercise orchestration and cancellation without touching the filesystem. Second, it isolates the pipeline from the Electron main process -- the pipeline does not `require('electron')` and does not know about `ipcMain`. It receives `onProgress(msg)` and `onDiarizeProgress(data)` callbacks; `main.js` wires those to `event.sender.send(...)`.

The pipeline runs three sequential steps:

1. **FFmpeg conversion.** The input file (audio or video) is converted to 16 kHz mono WAV (`pcm_s16le`) in a temp directory. A 15-format extension whitelist (8 audio, 7 video) controls which files pass the UI, but the pipeline itself trusts the extension to detect video vs. audio for the "Extracting audio..." / "Converting audio..." status message.

2. **Whisper transcription.** The whisper-cli binary is spawned with arguments that depend on the model type and diarization mode:

   - **Plain transcription:** `--no-timestamps` -- whisper outputs raw text, fastest path.
   - **TinyDiarize (tdrz models):** `--tinydiarize` -- the `small.en-tdrz` model was fine-tuned for speaker change detection; it emits `[SPEAKER_TURN]` markers inline. No separate diarization step needed.
   - **Pyannote diarization:** `--output-json-full` with `--dtw <preset>` -- whisper outputs per-token JSON with timestamps from DTW alignment. The JSON is later merged with pyannote speaker segments.

   The anti-corruption mode (`-mc 0 --temperature 0.4 --entropy-thold 1.8`) disables cross-segment text conditioning, preventing whisper from entering hallucination loops that produce repeating lines. These specific values come from whisper.cpp issue discussions about repetitive output on certain audio.

3. **Optional diarization.** If pyannote diarization is enabled (and the model is not tdrz), the pipeline spawns `lib/diarize.py` as a Python subprocess on the same WAV file, then merges the result with whisper's JSON output using `lib/diarize-merge.js`.

The whisper step is delegated to `lib/whisper-runner.js`, which owns arg construction, backend resolution, and two fallback chains:

- **GPU to CPU fallback.** If the active backend is `'vulkan'` and whisper exits non-zero, the runner retries with the CPU binary. It distinguishes OOM errors (`OutOfDeviceMemory`, `failed to allocate`) from other Vulkan failures: OOM doesn't disable GPU for future runs (the next file might be shorter and fit), but non-OOM errors call `capabilities.disableGpu()` which pins the session to CPU.

- **DTW to no-DTW fallback.** If whisper fails with a DTW-related error (`unknown DTW preset`, `DTW ... not built`), the runner strips `--dtw` and retries. After a DTW failure, `capabilities.disableDtw()` is called so subsequent diarization runs skip `--dtw` entirely, avoiding the failure for every file in a batch.

Keeping the retry policy in `whisper-runner.js` means `runTranscription` reads as a clean three-step composition (ffmpeg -> whisperRunner.transcribe -> optional diarize+merge) with no retry-aware branching. Subprocess spawning, logging, abort wiring, and HF-token redaction live in `lib/_subprocess.js`, shared by ffmpeg, whisper, and the diarization step.

Cancellation works through a single `AbortSignal` shared across all subprocesses. Each `_runProcess` call registers an `abort` event listener that calls `proc.kill()`. The `cancel-transcription` IPC handler calls `abort()` on the controller. Because ffmpeg and whisper run sequentially (not in parallel), killing whichever process is currently running is sufficient.

### 3.2 lib/diarize-merge.js -- the merge pipeline

This is the most complex single module in the codebase. It converts whisper's per-token JSON output and pyannote's speaker segments into a speaker-labeled transcript. The pipeline runs five stages plus a post-collapse merge, compensating for the fact that whisper's DTW-aligned word timestamps and pyannote's neural speaker boundaries come from two independent systems with slightly different clocks.

The tunable thresholds in the `DEFAULTS` object are set where they are for specific reasons:

- **`mergeGapSec: 0.5`** -- pyannote sometimes splits a single speaker turn at a pause. 0.5 seconds is roughly the threshold between a natural intra-turn pause and an actual speaker change.
- **`absorbShortSegSec: 0.3`** -- pyannote occasionally produces 100-200ms phantom segments (misidentified noise). Absorbing segments under 0.3s when flanked by the same speaker catches these.
- **`boundarySnapMaxDistSec: 3.0`** -- DTW timestamp drift typically stays within 1-2 seconds of pyannote boundaries. 3.0s provides headroom without being so wide that words far from the boundary get incorrectly snapped.
- **`smoothingMaxRunLen: 2`** -- smoothing corrects runs of 1-2 misassigned words. It stops at 2 because a 3-word run could be a genuine short utterance (e.g., "Yes, I agree."). If pyannote labelled it differently, the app trusts pyannote over smoothing.
- **`shortBlockMaxWords: 3` / `shortBlockMaxDurationSec: 2.0`** -- after collapse, a short block (e.g., a single "yeah" between longer same-speaker blocks) is merged back. The dual word-count AND duration check prevents a 3-word sentence that takes 4 seconds (which is a real utterance) from being absorbed.
- **`boundaryThirdSpeakerWindowSec: 2.0`** -- at an A->B speaker boundary, DTW drift sometimes mislabels a boundary word as a phantom speaker C. The algorithm checks whether C appears elsewhere within 2 seconds around the boundary. If C is isolated, it's drift and the word is reassigned to A or B. If C has company (a cluster), it's a genuine three-way conversation and the labels are preserved.
- **`nearestSegMaxDistSec: 5.0`** -- the last-resort fallback for words in pyannote gaps. 5 seconds limits how far a word can be from a segment before it's labelled `Unknown` rather than assigned to a far-away speaker.

The module is shared between `main.js` (production use) and `scripts/test-merge.js` (unit tests). The tests pass custom config overrides to exercise specific thresholds without modifying the defaults. Setting `DIARIZE_DEBUG=1` emits per-stage diff logs to stderr.

### 3.3 lib/diarize.py -- the Python subprocess

A standalone Python script spawned as a child process. It loads the pyannote.audio diarization pipeline, converts the WAV to a PyTorch waveform using the stdlib `wave` module (avoiding `torchcodec`/`torchaudio` dependencies that are difficult to install on Windows), runs inference, and writes speaker segments as JSON.

The subprocess protocol uses three channels:

- **stderr:** JSON progress lines (`{"message": "...", "percent": N}`) and error lines (`{"error": "..."}`). The main process parses stderr line by line in `_runDiarization`.
- **stdout:** a final JSON summary (`{"segments": 42}`).
- **output file:** the actual segments array written to a temp JSON file, read back by the caller, then deleted.

Why a subprocess instead of a Python native binding? Pyannote has heavy dependencies (PyTorch, transformers, torchaudio) that would be impractical to bundle into an Electron app. The subprocess pattern follows the same logic as ffmpeg and whisper-cli: a standalone executable that the app spawns and communicates with via stdio.

### 3.4 lib/capabilities.js -- runtime capability detection

Replaces what was once scattered global state in `main.js` (separate `gpuState`, `dtwState`, `cachedPythonCmd` variables). This module consolidates all runtime probes into a single class with injected settings callbacks.

At startup, `detect()` runs three probes concurrently:
- **GPU detection:** spawns the Vulkan whisper binary with `--help` (5s timeout), parses stderr for `ggml_vulkan:` device lines, and picks a discrete GPU (non-Intel) over integrated. The app rejects Intel GPUs because their Vulkan drivers are unreliable for ML inference.
- **DTW detection:** spawns the CPU whisper binary with `--help` and checks for `--dtw` in the output. The result is cached; `isDtwSupported()` returns `true` until probed as `false`.
- **Python detection:** tries `python3`, `python`, and `py` (Windows) with `--version`, then checks for pyannote and CUDA via import probes. Results are cached after the first call.

`getActiveBackend()` resolves the effective backend from the user's preference (auto/cpu/vulkan) and the detection result. The app persists the user preference to `settings.json` in the user data directory.

## 4. The data model

Transcriber has no database. It stores two kinds of persistent data:

### 4.1 Settings (`settings.json`)

A flat JSON file at `app.getPath('userData')/settings.json`. Read and written via `readSettings()` and `writeSettings()` in `main.js`. Keys currently include:

- `gpuBackend`: `'auto'`, `'cpu'`, or `'vulkan'`

There is no schema enforcement or migration logic because there is only one key and a missing key defaults to `'auto'`. If more settings are added, the `{ ...existing, ...data }` merge in `writeSettings()` ensures new keys don't clobber old ones.

### 4.2 Models (`models/`)

Model files are `.bin` files downloaded from Hugging Face. `lib/models.js` owns the canonical list (13 entries) along with every per-model fact: filename, label, size, DTW preset, the optional `tdrz` flag, and the optional `hfRepo` override (only `small.en-tdrz` uses it, to pull from `akashmjn/tinydiarize-whisper.cpp` instead of the default `ggerganov/whisper.cpp`). Adding a model is a single-entry edit; the `download-model` IPC handler and the transcription runner both consult the same module via `models.getModel(id)`, `models.getModelPath(id)`, and `models.getDownloadUrl(id)`.

Model download state is computed at runtime: `models.listModels()` maps the spec array, adding a `downloaded` boolean by checking `fs.existsSync()` on each model's path. There is no separate download-state store. If a model file exists, it's downloaded; if not, it isn't.

### 4.3 Log file (`transcriber.log`)

A plain text append-only log at `app.getPath('userData')/logs/transcriber.log`. Rotated when it exceeds 5 MB (the old log is renamed to `transcriber.log.old`, overwriting any previous old log). The log captures all subprocess launches, their stdout/stderr, exit codes, GPU detection results, and diarization failures. In debug builds (marked by a `.debug-build` marker file or `DEBUG_BUILD=1` env var), a debug panel in the settings menu exposes log viewing.

## 5. The UI layer

The renderer consists of five scripts loaded in `index.html`, in order: `queue.js`, `media-extensions.js`, `time-estimates.js`, `transcript-format.js`, then `renderer.js`. The first four are pure modules (no DOM, no IPC) using the same dual `module.exports` / `window.<namespace>` pattern as `queue.js`, so they are testable in plain Node. `renderer.js` consumes them through `window.mediaExtensions`, `window.timeEstimates`, and `window.transcriptFormat`. There is no framework, no build step, and no bundler. The constraints that drove this: (a) the UI is a single screen with no routing, so a framework adds complexity without benefit; (b) avoiding a build step means contributors can change the renderer code and reload the app without running a watcher; (c) the UI is simple enough (a model picker, a file queue, a transcript output) that vanilla DOM manipulation is sufficient.

### 5.1 renderer/queue.js -- the queue state model

A pure state model with no DOM dependencies. Exports a `createQueue()` factory that returns an object with `enqueue`, `remove`, `clear`, `getItems`, `getSummary`, `getActiveItem`, and `processAll`. Items flow through states: `pending` -> `processing` -> `done` | `error`.

`processAll` processes pending items serially. It accepts an `AbortSignal` and an `onChange` callback. After each item completes or fails, `onChange` fires so the renderer can update the queue list. Error in one item does not stop the queue -- the next pending item proceeds. This is intentional: a corrupt file that crashes ffmpeg shouldn't prevent the rest of the batch from transcribing.

The module runs in both Node (test scripts) and the browser (renderer) via the `if (typeof module !== 'undefined')` check at the bottom.

### 5.2 renderer/renderer.js -- the UI logic

Wires the DOM elements to user actions and IPC events. Key behaviours:

- **File selection** works through both a click-to-browse button (native dialog via `dialog.showOpenDialog`) and drag-and-drop. Dropped files are filtered against a whitelist of 15 extensions. Files that don't match are rejected with a status message.
- **Model download** streams progress from the main process via `download-progress` events. The download button appears only for undownloaded models, determined by the `downloaded` boolean from `get-models`.
- **Transcription** is kicked off by the Transcribe button, which calls `queue.processAll` with a callback that invokes `window.api.transcribe`. The UI shows a progress spinner, an elapsed timer, and a cancel button. After processing, the queue is cleared (completed items are discarded from the UI -- transcripts are shown in the output area, not retained in the queue).
- **Rich display for diarized output:** when pyannote diarization succeeds (detected by `transcriptFormat.isPyannoteDiarized`, a `[N speakers detected]` header check), the renderer replaces the plain textarea with a `div.transcript-rich` containing speaker-colored spans. The block parsing is done by `transcriptFormat.parseRichTranscript`, which clamps speaker numbers above 8 to the highest CSS class. Eight CSS classes (`speaker-1` through `speaker-8`) provide distinct colors. The textarea is kept in sync (hidden) as the plain-text copy/save source.
- **Settings menu** (hamburger icon) contains the anti-corruption toggle, diarization setup, and an optional debug panel. The diarization section disables the enable toggle if Python or pyannote is not found, and shows CUDA detection status.
- **Auto-update** uses `electron-updater`'s GitHub provider. The renderer listens for `update-available` (shows "Downloading...") and `update-downloaded` (shows "Update ready -- click to restart"). Version comparison prevents offering downgrades.

### 5.3 preload.js -- the context bridge

A flat list of `contextBridge.exposeInMainWorld` calls. Each function maps to an `ipcRenderer.invoke` or `ipcRenderer.on` call. There is no wrapper or abstraction layer -- the renderer calls `window.api.transcribe(...)` directly. This is deliberate: with only ~20 IPC channels and a single window, indirection through a typed API layer would add maintenance cost without reducing coupling.

## 6. Packaging and deployment

### 6.1 Why Electron

Electron was chosen because it provides a cross-platform desktop shell with native file dialogs, auto-updates, and a Chromium renderer -- all from JavaScript. The alternative would be a native GUI toolkit (Qt, GTK, WinUI), but that would require either C++ development or Python packaging (which is notoriously fragile on Windows). Electron's `extraResources` mechanism in `electron-builder.yml` allows bundling arbitrary binary directories alongside the asar, which is critical for shipping ffmpeg and whisper-cli.

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

Built by `electron-builder` with `nsis.oneClick: true`. The installer places the app in Program Files, creates Start Menu shortcuts, and registers an uninstaller. The one-click setting means the user doesn't see an installation wizard -- it installs silently to the default location.

### 6.4 Linux AppImage

A self-contained AppImage that bundles all dependencies. Built by `electron-builder` with `linux.target: AppImage`. No system dependencies required beyond a working FUSE setup.

### 6.5 Build script (`scripts/build.sh`)

The single build script handles dependency fetching and packaging. It reads `deps.json` for all URLs and version numbers. This is the single source of truth referenced by both local builds and CI. The script downloads pre-built Windows binaries (whisper-cli from GitHub releases, ffmpeg from gyan.dev) and either builds Linux binaries from source or downloads pre-built ones. The `--debug` flag creates a `.debug-build` marker that gets bundled as an extra resource and enables the debug panel at runtime.

### 6.6 Auto-update

`electron-updater` with the `github` provider checks for new releases on startup. The version comparison (`r[0] > c[0] || ...`) prevents the updater from offering a downgrade if a newer release metadata exists but has a lower semver. This can happen during development when release tags are moved.

## 7. Supporting scripts and tests

| File | What it tests | When to run it |
|------|--------------|----------------|
| `scripts/test-merge.js` | All 5 stages of the diarization merge pipeline plus post-collapse merging; ~40 test cases covering segment-level fallback, word-level token assignment, boundary refinement, smoothing, short-block merge, and config overrides | After any change to `lib/diarize-merge.js` |
| `scripts/test-capabilities.js` | GPU detection fallback, DTW probe caching, Python detection caching, preference persistence; ~15 tests using mock spawn and stubs | After any change to `lib/capabilities.js` |
| `scripts/test-transcription-runner.js` | Pipeline orchestration: FFmpeg arg construction, whisper-is-called wiring, cancellation via AbortSignal; ~10 tests using mock spawn | After any change to `lib/transcription-runner.js` |
| `scripts/test-whisper-runner.js` | Whisper arg construction, GPU->CPU fallback, DTW->no-DTW fallback, OOM vs non-OOM classification, cancellation during retry; ~12 tests | After any change to `lib/whisper-runner.js` |
| `scripts/test-models.js` | `getModel` lookup and unknown-id error, `getModelPath`, `getDownloadUrl` default vs `hfRepo` override, `listModels` shape; ~9 tests | After any change to `lib/models.js` |
| `scripts/test-queue.js` | Queue enqueue/remove/clear/getActiveItem, serial processing, error isolation (one failure doesn't stop the batch), cancellation; ~15 tests | After any change to `renderer/queue.js` |
| `scripts/test-transcript-format.js` | Pyannote detection regex, tinydiarize split-and-join formatting, rich-transcript parsing with speaker-number clamping, speaker counting; ~21 tests | After any change to `renderer/transcript-format.js` |
| `scripts/test-time-estimates.js` | Model-id to time-estimate bucket mapping including the `large-turbo` special case; ~16 tests | After any change to `renderer/time-estimates.js` |
| `scripts/test-renderer-smoke.js` | Loads every renderer script (`queue.js`, `media-extensions.js`, `time-estimates.js`, `transcript-format.js`, `renderer.js`) in a minimal browser-like vm context to catch require()-in-renderer bugs, missing globals, and syntax errors | Before any release or PR that touches renderer code |
| `scripts/test-packaging.js` | Verifies that every `require('./lib/...')` in `main.js` resolves to an existing file, that `lib/` is not in top-level `extraResources` (which would move JS modules outside the asar), and that `lib/diarize.py` IS in `extraResources` | Before packaging a release |
| `scripts/test-audio-load.py` | Checks that ffmpeg can load a given audio file | Ad-hoc, when debugging ffmpeg issues |
| `scripts/test-diarize-pipeline.py` | End-to-end diarization test requiring Python, pyannote, and a Hugging Face token | After changes to `lib/diarize.py` or when setting up diarization |

All JavaScript tests follow the same plain-Node pattern: no test framework, no assertions library. A `test(name, fn)` function queues tests; `assert(cond, msg)` throws on failure. The test runner prints `PASS`/`FAIL` per test and exits with code 1 on any failure. This avoids adding a dev dependency that would need to be maintained across Electron version bumps.

## 8. Tech choice summary

| Choice | Why |
|--------|-----|
| Spawning child processes instead of native bindings | Avoids C++ compilation in the Electron app; isolates crashes (a whisper segfault doesn't take down the UI); satisfies LGPL compliance for ffmpeg without re-linking; enables clean cancellation via `proc.kill()` |
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

5. **`lib/transcription-runner.js`** + **`lib/whisper-runner.js`** -- the FFmpeg -> whisper -> diarize pipeline. `runTranscription` is the three-step composition; `whisper-runner` owns arg construction and the GPU/DTW retry policy. `lib/_subprocess.js` is the shared spawn helper.

6. **`lib/capabilities.js`** -- GPU, DTW, and Python detection. `detect()` runs three probes at startup. `getActiveBackend()` shows how user preference and hardware detection combine.

7. **`lib/diarize-merge.js`** -- the five-stage merge pipeline plus post-collapse short-block merge. The `DEFAULTS` object documents every tunable threshold. The `mergeTranscriptWithDiarization` orchestrator wires them together.

8. **`renderer/queue.js`** and **`renderer/renderer.js`** -- the UI side: queue state model and DOM wiring. Look at `processAll` for serial processing and `displayRichTranscript` for the speaker-colored output. Pure helpers live alongside: `renderer/transcript-format.js` (pyannote detection, tinydiarize formatting, rich parsing), `renderer/media-extensions.js`, and `renderer/time-estimates.js`.

9. **`scripts/build.sh`** and **`electron-builder.yml`** -- how the app becomes a Windows NSIS installer or Linux AppImage. `electron-builder.yml` defines `extraResources` (what goes outside the asar) and `nsis`/`AppImage` target settings.

That is the whole project.
