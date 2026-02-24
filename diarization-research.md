# Diarization Feature Exploration

Research and implementation plan for speaker diarization in the Electron/whisper.cpp transcription app.

## Current State: TinyDiarize

The app already has basic speaker diarization via whisper.cpp's **TinyDiarize** feature:

- Model: `small.en-tdrz` (488 MB), downloaded from Hugging Face
- whisper-cli flag: `--tinydiarize`
- Output: `[SPEAKER_TURN]` tokens in the transcript text
- Renderer formats these as `--- Speaker Change ---` dividers
- **Limitation**: TinyDiarize only detects speaker *changes*, not speaker *identity* (no "Speaker 1" vs "Speaker 2" labels)

## What Pyannote Provides

[Pyannote.audio](https://github.com/pyannote/pyannote-audio) is the state-of-the-art open-source speaker diarization pipeline. It answers: **"who spoke when?"**

- Assigns speaker identity labels (Speaker 1, Speaker 2, etc.) with timestamps
- Handles overlapping speech
- Can specify expected number of speakers (or auto-detect)
- Pre-trained models available on Hugging Face

### Requirements

| Requirement | Detail |
|-------------|--------|
| Python | 3.9+ |
| PyTorch | ~500 MB-2 GB (CPU or CUDA) |
| pyannote.audio | + dependencies (scipy, scikit-learn, etc.) |
| Models | ~300 MB (segmentation + embedding models) |
| HF Auth Token | Required to accept model license and download |
| **Total footprint** | **~1-10 GB** depending on GPU support |

### Performance

| Hardware | Speed (per hour of audio) |
|----------|--------------------------|
| GPU (CUDA) | 1-5 minutes |
| CPU (modern) | 30 min - 4 hours |
| CPU (older) | Impractical |

**CPU performance is the critical issue.** This app targets users without necessarily having a GPU. On CPU, pyannote is 30-240x slower than real-time, making it impractical for most use cases without a GPU.

## Integration Approaches

### 1. Subprocess (Most Feasible)

Ship a Python script (`lib/diarize.py`) and spawn it as a child process from Electron, similar to how we already spawn whisper-cli and ffmpeg.

**How it works:**
1. User installs Python 3.9+ and runs `pip install pyannote.audio` (or we provide a requirements.txt)
2. Electron spawns `python lib/diarize.py --audio input.wav --output diarization.json`
3. Main process merges diarization timestamps with whisper transcription
4. Renderer displays speaker-labeled segments

**Pros:**
- Follows existing architecture (spawn external processes)
- No Python bundling complexity
- User controls their Python environment

**Cons:**
- Requires user to install Python + PyTorch manually
- Hard to provide a smooth UX for dependency setup
- Platform-specific Python path issues (especially Windows)
- Large dependency footprint for end users

### 2. Bundled Python (Hard)

Bundle a complete Python environment (via PyInstaller, conda-pack, or embedded Python) with the app.

**Pros:** No user-facing Python setup. Self-contained.

**Cons:** Adds 500 MB-1 GB+ to app size (PyTorch alone is huge). Complex build pipeline. GPU support requires shipping CUDA libraries or detecting system CUDA. Maintenance burden.

### 3. Pyodide / WASM (Not Viable)

PyTorch does not compile to WASM. Pyannote depends on PyTorch. Dead end.

### 4. ONNX Runtime in Node.js (Theoretical)

Convert pyannote models to ONNX and run them via `onnxruntime-node`. Pyannote's pipeline is complex (VAD -> segmentation -> embedding -> clustering). Converting and reimplementing this in JS/ONNX is a significant research project. No ready-made solution exists.

## Alternatives Comparison

| Option | Effort | Quality | Dependencies | CPU Viable? |
|--------|--------|---------|-------------|-------------|
| **Enhance TinyDiarize** (current) | Low | Medium | None new | Yes |
| **Pyannote subprocess** | Very High | High | Python + PyTorch | No (too slow) |
| **WhisperX subprocess** | Very High | High | Python + PyTorch | No (too slow) |
| **Picovoice Leopard** | Medium | Medium | Commercial SDK | Yes |
| **ONNX port** | Extreme | High | onnxruntime-node | Maybe |

## Reference Projects

| Project | Stack | Diarization Approach | Notes |
|---------|-------|---------------------|-------|
| [aTrain](https://github.com/JuergenFleiss/aTrain) | Python/PyQt | Pyannote native | Pure Python app, no bundling issues |
| [noScribe](https://github.com/kaixxx/noScribe) | Electron | Pyannote via subprocess | Closest reference to our architecture |
| [Buzz](https://github.com/chidiwilliams/buzz) | Python/Qt | Partial/incomplete diarization | Shows difficulty of integration |

## Feasibility Verdict

**Possible but very costly, with a poor UX tradeoff.**

The fundamental mismatch is **Electron/Node.js vs Python/PyTorch**. Pyannote is a Python-only library with heavy dependencies. Every integration path either requires the user to install Python themselves (bad UX) or requires bundling a massive Python runtime (bad app size, complex builds).

The CPU performance problem is equally serious. Most target users won't have a GPU, and pyannote on CPU is too slow to be practical.

### Recommendation

1. **Short term:** Improve the existing TinyDiarize integration (better formatting, speaker counting heuristics, UI polish). This is free -- no new dependencies.
2. **Medium term:** If users demand real speaker identification, implement the subprocess approach as an *optional advanced feature* that requires user-installed Python.
3. **Long term:** Watch for ONNX/native ports of speaker diarization models that could run without Python.

---

## Implementation Plan: Pyannote Subprocess Approach

If proceeding with the subprocess approach as an optional advanced feature:

> **Prerequisites:** User must have Python 3.9+ and `pyannote.audio` installed. This feature is opt-in.

### Phase 1: Python Diarization Script

**Create `lib/diarize.py`:**
- Accept arguments: `--audio <path>` `--output <path>` `[--num-speakers N]` `[--hf-token TOKEN]`
- Load pyannote pipeline (`pyannote/speaker-diarization-3.1`)
- Run diarization on the audio file
- Output JSON with speaker segments:
  ```json
  [
    { "start": 0.0, "end": 3.5, "speaker": "SPEAKER_00" },
    { "start": 3.5, "end": 8.2, "speaker": "SPEAKER_01" }
  ]
  ```
- Handle errors gracefully (missing dependencies, missing HF token, model download failures)
- Print progress to stderr for Electron to capture

**Create `lib/requirements.txt`:**
```
pyannote.audio>=3.1
torch>=2.0
```

### Phase 2: Python Detection & Setup UX

- [ ] Check for `python3` / `python` on PATH
- [ ] Verify version >= 3.9 (`python --version`)
- [ ] Check if `pyannote.audio` is installed (`python -c "import pyannote.audio"`)
- [ ] Check for GPU availability (`python -c "import torch; print(torch.cuda.is_available())"`)
- [ ] Show "Python not found" or "pyannote not installed" status with setup instructions
- [ ] Link to installation guide (Python download page, pip install command)
- [ ] Show GPU warning: "Diarization on CPU is very slow. A CUDA GPU is strongly recommended."
- [ ] Show HF token input field (needed for pyannote model access)

### Phase 3: IPC & Transcription Flow

- [ ] Add `diarize` IPC handler in `main.js` — spawn `python lib/diarize.py --audio <wav> --output <json>`
- [ ] Parse stderr for progress updates, forward to renderer
- [ ] Read output JSON on completion
- [ ] Handle timeout (diarization can be very slow on CPU)
- [ ] Add "Enable speaker diarization" checkbox in UI (only shown when pyannote is available)
- [ ] When enabled, run diarization *after* whisper transcription
- [ ] Merge whisper text with pyannote speaker segments by timestamp alignment
- [ ] Fall back to TinyDiarize if pyannote fails

**Timestamp alignment logic:** Whisper outputs timestamped segments (when not using `--no-timestamps`). Pyannote outputs speaker segments with timestamps. For each whisper segment, find the overlapping pyannote speaker segment and label the text with the speaker identity.

### Phase 4: Renderer Changes

- [ ] Display speaker labels: `**Speaker 1:** Hello, how are you?`
- [ ] Color-code speakers (up to 6-8 distinct colors)
- [ ] Show speaker summary at top ("2 speakers detected")
- [ ] Diarization toggle (off by default)
- [ ] Number of speakers input (optional, helps accuracy)
- [ ] HF token storage (persist in electron-store or similar)
- [ ] Python path override (for non-standard installations)

### Phase 5: Packaging & Docs

- [ ] Include `lib/diarize.py` and `lib/requirements.txt` in `extraResources`
- [ ] Do NOT bundle Python or PyTorch (user-installed)
- [ ] Add "Speaker Diarization (Advanced)" section to README
- [ ] Installation instructions for Python + pyannote
- [ ] GPU recommendations and troubleshooting guide

## Open Questions

1. **HF token UX** — Pyannote models require accepting a license on Hugging Face and providing an auth token. How to handle this smoothly? (Token input in settings? Environment variable?)
2. **CPU viability** — Should we block/warn CPU-only users, or let them try and suffer the wait?
3. **Priority vs TinyDiarize** — Is the quality improvement over TinyDiarize worth the massive UX cost of requiring Python? Consider investing in TinyDiarize improvements first.
4. **WhisperX alternative** — WhisperX bundles both whisper + pyannote in one Python package. Could simplify the subprocess approach but adds another large dependency.
