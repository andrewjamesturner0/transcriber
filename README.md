# Transcriber

[![GPLv3 License](https://img.shields.io/badge/licence-GPLv3-blue.svg)](LICENSE)

Local audio and video transcription with a curated choice of on-device speech models.

Transcriber is a desktop application that transcribes audio and video files with whisper.cpp and transcribe.cpp. Inference runs locally and does not send audio, transcript text, or transcription metadata to a remote service. No Transcriber account is needed.

**Download:** [Windows & Linux; GitHub Releases](https://github.com/andrewjamesturner0/transcriber/releases)

---

## Features

- Local inference. Audio, transcript text, and transcription metadata are not sent to a cloud inference service, and there is no telemetry. Model downloads are user-initiated, optional pyannote may fetch missing model assets, and an automatic update check can occur when the application starts.
- Optional speaker labelling through [pyannote.audio](#speaker-diarization-advanced) for models whose word timing has been validated with Transcriber's merge pipeline.
- A curated catalogue of 19 models: 12 retained Whisper choices and seven Candidate or Experimental choices from other model families. MOSS remains listed but unavailable until the pinned runtime supports it.
- GPU acceleration via Vulkan, with automatic detection and CPU fallback
- Audio and video input: 9 audio formats (MP3, WAV, FLAC, OGG, M4A, AAC, WMA, WebM, DSS) and 7 video formats (MP4, MOV, AVI, MKV, WMV, FLV, 3GP). DSS is the Olympus/Philips dictation format (Standard Play only; DSS Pro/DSS2 not supported).
- Batch processing. Queue multiple files and transcribe them sequentially.
- Windows and Linux

## Install

### Direct download

Download the latest release for your platform from the [Releases page](https://github.com/andrewjamesturner0/transcriber/releases).

| Platform | Format |
|----------|--------|
| Windows | NSIS installer (.exe) |
| Linux | AppImage |

Note: The packages are not signed, so your system may show warnings during installation.

## How it works

```
Your audio/video file
    -> FFmpeg converts to WAV (locally)
    -> whisper.cpp or an isolated transcribe.cpp worker transcribes it (locally)
    -> (Optional) pyannote.audio labels speakers for a validated model (locally)
    -> Your transcript, ready to use
```

Transcriber wraps [whisper.cpp](https://github.com/ggml-org/whisper.cpp), [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp), and [FFmpeg](https://ffmpeg.org) in an Electron app. whisper.cpp and FFmpeg run as child processes. transcribe.cpp runs through a separate Node 22 worker so a native failure does not close Electron. User-selected models are downloaded into writable per-user storage; the bundled Tiny English model remains the fallback. Once all assets selected for a job, including optional pyannote assets, are stored locally, transcription can run without internet access. The application may still check for software updates on startup. For details on the bundled GPLv3 FFmpeg builds and compliance, see [docs/ffmpeg.md](docs/ffmpeg.md).

## Speaker Diarization (Advanced)

Transcriber can use pyannote.audio to label *who* said *what*. TinyDiarize and the old `small.en-tdrz` model are no longer in the catalogue. Pyannote is offered only for models whose word timing has been validated with Transcriber's speaker merge. At present, that is the 12 retained Whisper models.

This uses [pyannote.audio](https://github.com/pyannote/pyannote-audio), an open-source speaker diarization pipeline, running as a subprocess. It requires Python and several large dependencies installed separately. **A CUDA GPU is strongly recommended**; CPU diarization is very slow.

### Setup (Windows)

1. Install Python 3.9+ from [python.org](https://www.python.org/downloads/). Tick "Add to PATH" during install.
2. Install dependencies. Open Command Prompt and run:
   ```
   pip install pyannote.audio torch
   ```
3. Get a Hugging Face token:
   - Create an account at [huggingface.co](https://huggingface.co/join)
   - Accept **all three** model licences (you must click "Agree" on each page while logged in):
     - [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1)
     - [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0)
     - [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1)
   - Generate a token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens). A Read token is sufficient.
4. Optional: install CUDA for GPU acceleration. See [NVIDIA CUDA Toolkit](https://developer.nvidia.com/cuda-downloads).
5. In Transcriber, open Settings and save the token under Speaker labelling setup. Enable speaker labels for the current file queue under Job options in the main window.

### Setup (Linux)

```bash
pip install pyannote.audio torch
```

Then follow steps 3-5 above.

For more detail and troubleshooting, see [docs/diarization-setup.md](docs/diarization-setup.md).

## For researchers

If you work with sensitive recordings (participant interviews, clinical conversations, confidential data), Transcriber may be useful.

**Why local processing matters:**
- Ethics committees often prohibit uploading recordings to cloud services
- GDPR Article 25 (Data Protection by Design) favours tools that minimise data exposure
- Institutional policies may restrict third-party data processing
- Participant consent forms may specify local-only handling

**What you can tell your ethics committee:** Transcriber runs speech-model inference on the local computer and does not transmit audio, transcript text, or transcription metadata. Separate network connections can occur: the application can check for updates on startup, model downloads are started by the user, and optional pyannote may fetch missing model assets. Transcription can run without internet access once all assets selected for the job are local.

For a description suitable for ethics applications and data management plans, see [docs/privacy-architecture.md](docs/privacy-architecture.md).

## System requirements

- Modern CPU (Intel or AMD)
- 4 GB RAM minimum (8 GB+ recommended for larger models)
- 34 MB to 3.1 GB disk space per model in the current catalogue
- GPU optional. Vulkan-capable GPU auto-detected for faster transcription; falls back to CPU if unavailable.
- Internet access for user-initiated model downloads, missing optional pyannote assets, and automatic software update checks. Transcription can run without internet once all selected assets are local.

## Model catalogue

The catalogue contains 12 retained Whisper models plus Parakeet 110M, Moonshine Tiny, Nemotron 3.5, Qwen3-ASR 0.6B, Canary 180M Flash, MedASR, and MOSS Transcribe-Diarize. Whisper Small is the General purpose baseline. Whisper Large v3 is the Translation and Accuracy first baseline. The new-family entries remain Candidate or Experimental: inclusion does not mean that they have passed the release acceptance matrix.

MOSS is visible for planning but cannot be downloaded or run with the pinned transcribe.cpp 0.1.3 runtime. MedASR is gated and needs accepted Hugging Face access plus a saved token. TinyDiarize and `small.en-tdrz` are absent.

Run `node cli.js list-models` for the complete current list, including task, status, languages, size, licence, capabilities, availability, and downloaded state. See [Model validation](docs/model-validation.md) for the evidence needed before a candidate can be promoted.

## CLI

Transcriber also has a command-line interface that runs the same pipeline without launching the GUI. It is useful on headless servers and for batch or agent workflows. The entry point is `node cli.js`; subcommands cover transcription, model download, model listing, and GPU detection. Output goes to stdout, progress goes to stderr, exit codes are 0 for success and non-zero for failure (130 on Ctrl+C).

```bash
node cli.js transcribe interview.mp3 --model small.en > interview.txt
```

See [docs/cli.md](docs/cli.md) for the full reference.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, coding style, and the PR process.

## Sponsors

Transcriber is free software. If it's useful to you, consider [sponsoring development](https://github.com/sponsors/andrewjamesturner0).

## Built with

- [whisper.cpp](https://github.com/ggml-org/whisper.cpp): C/C++ Whisper inference (MIT)
- [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp): local inference for the additional model families (MIT)
- [OpenAI Whisper](https://github.com/openai/whisper): speech recognition models (MIT)
- [FFmpeg](https://ffmpeg.org): multimedia processing (bundled static builds: GPLv3)
- [Electron](https://www.electronjs.org): desktop framework (MIT)
- [ggml](https://github.com/ggml-org/ggml): tensor library (MIT)
- [pyannote.audio](https://github.com/pyannote/pyannote-audio): speaker diarization (MIT)
- [PyTorch](https://pytorch.org): machine learning framework (BSD-3-Clause)
- [NumPy](https://numpy.org): numerical computing (BSD-3-Clause)

## Licence

[GPLv3](LICENSE): free to use, modify, and distribute. Derivative works must also be open-source under GPLv3.
