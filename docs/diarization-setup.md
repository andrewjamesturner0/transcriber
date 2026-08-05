# Speaker diarization setup guide

Transcriber can label individual speakers with [pyannote.audio](https://github.com/pyannote/pyannote-audio). This optional local feature requires Python, PyTorch, pyannote, and gated Hugging Face model access.

Pyannote can be selected only for a model whose word timing has been validated with Transcriber's merge pipeline. At present, that is the 12 retained Whisper models. TinyDiarize is no longer supported.

## Requirements

| Requirement | Detail |
| --- | --- |
| Python | 3.9 or newer |
| PyTorch | Roughly 500 MB to 2 GB for CPU or CUDA variants |
| pyannote.audio | Includes scipy, scikit-learn, and other dependencies |
| Pyannote models | Roughly 300 MB, fetched into pyannote's external cache on first use |
| Hugging Face token | Read access after accepting the model terms |

CUDA is optional but strongly recommended for long recordings. CUDA accelerates pyannote only; Transcriber's speech-model GPU setting uses the supported Vulkan path.

## Windows setup

1. Install Python 3.9 or newer from [python.org](https://www.python.org/downloads/) and select "Add Python to PATH".
2. Open Command Prompt and install the packages:

   ```text
   pip install pyannote.audio torch
   ```

3. Sign in to Hugging Face and accept access for all three model repositories:

   - [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1)
   - [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0)
   - [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1)

4. Create a Read token at [Hugging Face tokens](https://huggingface.co/settings/tokens).
5. Open Transcriber Settings. Under Speaker labelling setup, confirm that Python and pyannote were detected and save the token.
6. In the main window, open Job options and enable Speaker labels for the current job. Expected speakers is under Advanced options.

## Linux setup

```bash
python3 -m pip install pyannote.audio torch
```

Then accept the three model repositories, create a Read token, and complete steps 5-6 above.

For NVIDIA CUDA, install the matching PyTorch build from the official PyTorch instructions. Do not assume that a CUDA toolkit version and a hard-coded wheel index always match.

## What the token is used for

The GUI saves the token in Electron's per-user `settings.json`. It is not returned to the renderer. pyannote receives it only when speaker labelling runs. The same saved token can authorise a gated catalogue model download such as MedASR after the user has accepted that model's upstream access terms.

The standalone CLI does not read GUI settings. Supply `--hf-token <token>` or set `HF_TOKEN`. Avoid putting a token directly into shared shell history or logs.

## Troubleshooting

### Python not found

- Run `python --version` or `python3 --version` in a new terminal.
- On Windows, use the python.org installer and enable PATH integration.
- If several Python versions exist, install packages with the exact interpreter, for example `python3 -m pip install pyannote.audio`.

### Pyannote not installed

- Run `python -m pip install pyannote.audio torch` and inspect any installation error.
- Reopen Settings so Transcriber refreshes its Python and pyannote status.

### Authentication failed

- Confirm that all three pyannote repository pages show granted access.
- Confirm that the token is a valid Read token.
- The first use needs network access so pyannote can fill its own model cache.
- Check the local application log for a redacted error message.

### Out of memory or slow processing

- Close other applications or use a machine with more RAM/VRAM.
- Use CUDA for pyannote when an NVIDIA GPU is available.
- Set Expected speakers when that information is known.
- Cancel stops the active local job.

### Speaker labelling failed

The transcription can still return a plain transcript if the pyannote step fails. Check the application log for missing access, model download, Python, or memory errors.
