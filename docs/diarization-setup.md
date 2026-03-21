# Speaker Diarization Setup Guide

Transcriber can identify individual speakers in a recording using [pyannote.audio](https://github.com/pyannote/pyannote-audio). This is an optional advanced feature that requires Python and several large dependencies.

## Requirements

| Requirement | Detail |
|-------------|--------|
| Python | 3.9 or newer |
| PyTorch | ~500 MB – 2 GB (CPU or CUDA) |
| pyannote.audio | + dependencies (scipy, scikit-learn, etc.) |
| Models | ~300 MB (downloaded automatically on first use) |
| Hugging Face token | Required to accept model licence and download |
| **Total footprint** | **~1–10 GB** depending on GPU support |

## Windows Setup

### 1. Install Python

Download Python 3.9+ from [python.org](https://www.python.org/downloads/).

**Important:** Tick **"Add Python to PATH"** during installation. If you forget, you'll need to add it manually or reinstall.

To verify, open Command Prompt and run:

```
python --version
```

You should see `Python 3.9.x` or newer.

### 2. Install packages

```
pip install pyannote.audio torch
```

This downloads PyTorch and pyannote.audio with all dependencies. Expect ~1–2 GB on CPU, or more with CUDA support.

### 3. Get a Hugging Face token

Pyannote models are hosted on Hugging Face and require accepting a licence agreement.

1. Create an account at [huggingface.co](https://huggingface.co/join)
2. Go to [hf.co/pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1) and accept the licence
3. Also accept the licence at [hf.co/pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0)
4. Generate a token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) (read access is sufficient)

### 4. GPU setup (optional but recommended)

Diarization on CPU is **very slow** (30 min – 4 hours per hour of audio). With a CUDA GPU, it takes 1–5 minutes.

To enable GPU support:

1. Install the [NVIDIA CUDA Toolkit](https://developer.nvidia.com/cuda-downloads)
2. Reinstall PyTorch with CUDA support:
   ```
   pip install torch --index-url https://download.pytorch.org/whl/cu121
   ```
   (Replace `cu121` with your CUDA version — check with `nvcc --version`)

### 5. Configure in Transcriber

1. Open Transcriber
2. Click the hamburger menu (top right)
3. Under **Speaker Diarization**, check that the status shows "Ready"
4. Paste your Hugging Face token
5. Enable the toggle
6. Optionally set the number of speakers (or leave on "Auto-detect")

## Linux Setup

```bash
# Install Python packages
pip install pyannote.audio torch

# For GPU support (NVIDIA):
pip install torch --index-url https://download.pytorch.org/whl/cu121
```

Then follow the Hugging Face token steps above (steps 3–5).

## Troubleshooting

### "Python 3.9+ not found"

- Check that Python is on your PATH: run `python --version` or `python3 --version` in a terminal
- On Windows, try reinstalling Python with "Add to PATH" ticked
- On Windows, the Microsoft Store version of Python may not be detected — use the python.org installer instead

### "pyannote not installed"

- Run `pip install pyannote.audio` and check for errors
- If you have multiple Python versions, make sure you're installing into the right one: `python3 -m pip install pyannote.audio`

### Authentication / token errors

- Make sure you've accepted both model licences:
  - [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1)
  - [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0)
- Check that your token is valid and has read access
- The first run downloads ~300 MB of model files — ensure you have an internet connection

### Out of memory

- Close other applications to free RAM
- If using GPU, try a machine with more VRAM, or fall back to CPU
- Specify the number of speakers manually instead of auto-detect (auto-detect uses more memory)

### Very slow performance

- Diarization on CPU is inherently slow. A CUDA GPU is strongly recommended.
- Typical CPU times: 30 min – 4 hours per hour of audio
- Typical GPU times: 1–5 minutes per hour of audio
- You can cancel a running job using the Cancel button

### Diarization failed, falling back to plain transcript

- This means the diarization subprocess errored. Check the status bar for the specific error message.
- Common causes: missing token, model download failure, out of memory
- The transcription itself still succeeds — you just won't get speaker labels
