# Transcriber: A Walkthrough

## 1. What the project is

Transcriber is a single-user Electron desktop app for local audio and video transcription. It has no cloud inference, account system, telemetry, database, or persistent queue. Windows x64 and Linux x64 are the supported package targets for the current model playground.

The app keeps whisper.cpp as the reliable engine for 12 retained Whisper models and adds seven curated new-family entries through transcribe.cpp. The catalogue has 19 entries in total. Parakeet, Moonshine, and Nemotron are Candidates. Qwen3-ASR, Canary, MedASR, and MOSS are Experimental. MOSS is visible but unavailable because the pinned transcribe.cpp 0.1.3 runtime does not support it.

Catalogue inclusion is not a recommendation. The current General purpose baseline is Whisper Small, and Whisper Large v3 supplies the Translation and Accuracy first baselines. New-family entries must pass the evidence gates in [model-validation.md](model-validation.md) before promotion.

## 2. The architecture in one view

```text
media file on disk
  |
  | GUI IPC request or CLI command
  v
FFmpeg child process -> temporary 16 kHz mono WAV
  |
  v
catalogue-driven engine adapter
  |-- whisper.cpp child process
  `-- framed Node 22 transcribe.cpp worker
  |
  v
engine-neutral transcript result
  |
  | optional, only for validated word timing
  v
pyannote subprocess -> diarize-merge.js -> speaker-labelled text
  |
  v
renderer output or CLI stdout
```

`main.js` owns Electron IPC, writable settings, safe model downloads, selected-file handles, and GUI job lifetime. `cli.js` uses the same catalogue and transcription runner without loading Electron. It takes configuration from flags and environment variables and uses its own writable model directory.

The renderer uses a narrow context bridge from `preload.js`. It never receives filesystem paths, model checksums, the saved Hugging Face token, or native worker objects.

## 3. The catalogue contract

`lib/model-catalogue.js` is the shared source of truth for all 19 models. Each record includes:

- stable ID, display name, task, and maturity status;
- engine and model family;
- immutable source revision, file name, checksum, and download size;
- licence, attribution, gating, and source links;
- languages and language-selection behaviour;
- supported translation pairs;
- timestamp level and pyannote validation;
- built-in speaker behaviour and audio limits;
- CPU/Vulkan support, memory guidance, repetition control, and known issues.

The same module validates GUI and CLI job options. Callers ask the catalogue whether a choice is valid rather than branching on model family names.

`lib/models.js` is the filesystem and download facade. It checks downloaded state by expected-file existence, selects a writable download before the bundled fallback, builds pinned Hugging Face URLs, and installs downloads only after SHA-256 verification.

TinyDiarize and `small.en-tdrz` are not in this catalogue.

## 4. The transcription pipeline

### 4.1 Conversion and limits

`lib/transcription-runner.js` converts each input to a collision-safe temporary WAV through bundled FFmpeg. After conversion it reads the WAV duration and enforces any catalogue audio limit before inference. MedASR, for example, rejects a file longer than about 400 seconds. The renderer queue catches that per-file error and continues with later pending files.

### 4.2 Engine selection

`lib/engine-adapters.js` selects an adapter from the model's `engine` field.

For the retained Whisper models, `lib/whisper-runner.js` starts `whisper-cli`. It owns Whisper arguments, Reduce repeated text sampling flags, translation language arguments, DTW probing, and Vulkan-to-CPU fallback. A Whisper Vulkan failure retries on CPU. A DTW-specific failure retries without DTW and disables DTW for later jobs in that session.

For supported new-family entries, `lib/transcribe-runner.js` maps catalogue options to `lib/transcribe-worker-client.js`. The client exchanges one JSON frame per line with `worker/transcribe-worker.mjs`. Protocol output stays on stdout and diagnostics stay on stderr. The worker supports load, transcribe, cancel, unload, and shutdown requests, reuses a model across serial jobs, and can be restarted after a crash. Native work therefore stays outside Electron's main process.

Both adapters return the shape validated by `lib/transcript-result.js`. It always includes text, model, engine, and backend. Selected or detected language, segments, words, tokens, timings, and truncation data appear only when the engine returned them. The application does not invent absent timing detail.

### 4.3 Cancellation and cleanup

FFmpeg, whisper.cpp, pyannote, and the transcribe.cpp worker all connect to the active job's abort path. GUI jobs are mutually exclusive. CLI Ctrl+C aborts the current pipeline, awaits worker shutdown, and exits with status 130. Temporary WAV and result files are removed in `finally` blocks.

## 5. Speaker labelling

Speaker labelling is a current-job option, not an application setting. It uses pyannote only for models whose word timing has passed Transcriber's merge validation. At present, the 12 retained Whisper models have that flag. New-family word-timed models remain disabled for pyannote until the separate speaker evidence gates pass.

When enabled, whisper.cpp returns full JSON with token timing. `lib/diarize.py` runs pyannote on the same WAV and writes speaker segments. `lib/diarize-merge.js` normalises token/word timing, assigns words to speaker segments, refines boundaries, smooths isolated errors, and formats speaker-labelled text.

MOSS has generated built-in speaker labels, but it is deferred with the current runtime and is not a pyannote input. TinyDiarize is no longer supported.

## 6. Data and storage

Transcriber has no database.

### 6.1 Settings

The GUI stores a flat `settings.json` under Electron's `app.getPath('userData')`. The persisted application-wide values are:

- `gpuBackend`: `auto`, `cpu`, or `vulkan`;
- `hfToken`: the optional saved Hugging Face token used for pyannote setup and gated model downloads.

The token is never returned to the renderer. The renderer receives only `hfTokenConfigured` and safe GPU/pyannote status.

Current-job choices do not persist here. Job mode, source language, target language, speaker labels, expected speakers, and Reduce repeated text remain in the main Job options section.

### 6.2 Models

Packaged GUI downloads go to `app.getPath('userData')/models`. The CLI uses `TRANSCRIBER_MODEL_DIR` when present, otherwise `%LOCALAPPDATA%/Transcriber/models` on Windows or `$XDG_DATA_HOME/transcriber/models` on Linux, with `~/.local/share/transcriber/models` as the Linux default.

Both launch paths prefer a matching writable download and fall back to the bundled `models/` resource. The build bundles Tiny English as the initial fallback. There is no model database, deletion UI, or version picker.

Downloads use a `.download` temporary file, enforce HTTPS redirects, check SHA-256, and rename atomically. A Hugging Face bearer token is sent only to approved Hugging Face hosts. Redirects to external object storage do not receive it.

### 6.3 Logs

The GUI log is `logs/transcriber.log` under Electron user data. It rotates at 5 MB. Debug builds expose open-log actions. The main process redacts the saved Hugging Face token from runner log messages.

## 7. The UI

The renderer is vanilla HTML, CSS, and JavaScript with no bundler.

The default flow is:

1. Model.
2. Job options.
3. Audio files.
4. Transcribe.

`renderer/model-chooser.js` supplies the progressive model chooser. The default screen shows one selected-model summary. Change opens six task-first suggestions, and the searchable full view reaches all 19 entries. Wider-list selection passes through model details. Maturity, limitations, gating, and MOSS deferral come from catalogue data.

`renderer/job-options.js` keeps core and advanced disclosures stable while model capability changes. Unsupported controls stay visible in an open layer, disabled with a model-specific reason. Settings holds only device preference, pyannote/Hugging Face setup, and logs.

`renderer/queue.js` processes items serially and isolates per-file errors. `renderer/transcript-format.js` keeps one plain-text copy/save source while optionally presenting speaker-coloured rich output.

## 8. Packaging

The application packages two inference paths:

- whisper.cpp CPU and Vulkan executables and libraries under `bin/{win,linux}/`;
- the transcribe.cpp JavaScript binding, Koffi, target native provider, and worker under `app.asar.unpacked`.

FFmpeg and the bundled model fallback live in Electron resources. Downloaded models do not write into those read-only package resources.

`scripts/verify-transcribe-runtime.js` checks exact package versions, lockfile integrity, and target native libraries. `scripts/smoke-packaged-worker.js` checks that an installed/unpacked Electron executable can start the worker protocol. Windows and Linux release jobs run their native checks. Local Linux packaging has been exercised, but final Windows, physical Vulkan, and full model acceptance remain release gates rather than completed claims.

## 9. Privacy boundary

Audio conversion, inference, speaker analysis, and transcript formatting are local. Transcription itself makes no network request once all required assets are installed.

Network activity outside transcription includes:

- user-initiated speech model downloads;
- pyannote model downloads on first use or when its cache is missing;
- automatic update checks and update downloads through GitHub Releases.

No audio or transcript is sent in those requests. See [privacy-architecture.md](privacy-architecture.md) for the precise boundary.

## 10. Tests and evidence

The fast suite consists of 20 plain-Node JavaScript test files:

```bash
for test_file in scripts/test-*.js; do node "$test_file" || exit 1; done
```

It covers catalogue contracts, option validation, secure downloads, CLI behaviour, result normalisation, both engine adapters, worker framing/recovery, conversion and duration limits, pyannote merging, queue isolation, renderer/UI contracts, packaging, and validation-harness rules.

Real pyannote, real-model, Windows installed-app, physical Vulkan, long-audio, multilingual, and offline-network acceptance are separate evidence tasks. Candidate status and pyannote flags must not change merely because a fast test passes.

## 11. Where to start

1. Read `deps.json` and `package.json` for exact runtime pins.
2. Read `lib/model-catalogue.js` for model facts and option rules.
3. Read `lib/transcription-runner.js` and `lib/engine-adapters.js` for orchestration.
4. Read the selected engine adapter: `lib/whisper-runner.js` or `lib/transcribe-runner.js` plus `lib/transcribe-worker-client.js`.
5. Read `main.js`, `preload.js`, and the renderer helpers for the GUI boundary.
6. Read `scripts/test-packaging.js` and `electron-builder.yml` before changing packaged paths.
7. Read [model-validation.md](model-validation.md) before changing a model's status or pyannote capability.
