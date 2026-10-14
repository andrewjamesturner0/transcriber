# Transcriber

[![GPLv3 License](https://img.shields.io/badge/licence-GPLv3-blue.svg)](LICENSE)

Local audio and video transcription powered by OpenAI's Whisper. All processing on-device.

Transcriber is a desktop application that transcribes audio and video files using the Whisper speech recognition model. All processing happens locally. No audio is sent anywhere. Basic transcription needs no account; optional speaker model setup needs a Hugging Face account.

**Download:** [Windows & Linux; GitHub Releases](https://github.com/andrewjamesturner0/transcriber/releases)

---

## Features

- Local processing. Your audio and transcript stay on your computer. Model downloads and update checks use the network; transcription runs offline with telemetry disabled.
- Speaker diarisation, with built-in speaker change detection and optional advanced speaker identification via [pyannote.audio](#speaker-diarization-advanced)
- 13 Whisper models, from Tiny (fastest) to Large-v3 (most accurate), including turbo and quantized variants. English-optimised models available.
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

Note: The packages are not signed, so will throw some warnings when installing.

## How it works

```
Your audio/video file
    -> FFmpeg converts to WAV (locally)
    -> whisper.cpp transcribes the audio (locally)
    -> (Optional) Align words to the audio (locally)
    -> (Optional) Label speakers with pyannote.audio, or detect changes with TinyDiarize (locally)
    -> Your transcript, ready to use
```

Transcriber wraps [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and [FFmpeg](https://ffmpeg.org) in an Electron app. The main process spawns these as child processes; no native bindings or compilation required. Models are downloaded once and stored locally; after that, Transcriber works offline. For details on FFmpeg bundling and licensing, see [docs/ffmpeg.md](docs/ffmpeg.md).

## Speaker Diarization (Advanced)

TinyDiarize provides basic speaker change detection with the Small.en +
Speaker ID model. Optional [pyannote.audio](https://github.com/pyannote/pyannote-audio)
uses Community-1 to label speakers. Its exclusive timeline chooses one speaker
at each time; the regular timeline is kept for overlap evidence. Neither
option identifies people by name or separates mixed voices.

### Setup (Windows and Linux)

1. Install Python 3.10 to 3.13 (on Windows tick "Add Python to PATH").
2. Install the pinned packages: `pip install -r lib/requirements.txt`.
3. Accept the conditions on the [Community-1 model page](https://huggingface.co/pyannote/speaker-diarization-community-1)
   and create a [Hugging Face Read token](https://huggingface.co/settings/tokens).
4. In Settings > Speaker Diarization, paste the token and click
   **Download speaker model**. The token is used for setup and is not saved.
5. When setup says ready, enable speaker diarisation. Later jobs need no token
   and load the model from the local cache.

Python packages take several GB (about 6.7 GB with CUDA on the tested Linux
setup), plus model storage. A CUDA GPU is recommended; CPU diarisation is slow.
See [the setup guide](docs/diarization-setup.md) for Windows CUDA installation,
CLI setup and `TRANSCRIBER_PYTHON` to select a virtual environment.

### Optional word alignment

Install `lib/requirements-alignment.txt`, then click **Download alignment model**
in Settings or run `python scripts/setup-diarization.py --alignment`. Turn on
**Align words to the audio** in the Model card while diarisation is enabled.
On the CLI, use `--diarize --alignment forced`.

Alignment matches the recognised words to the recording. It adds an extra
step and cannot recover words Whisper omitted. If it fails, the job reports
that it is using Whisper timing. The default keeps ordinary Whisper timing and flash attention. DTW is an
experimental CLI option (`--dtw`); it needs flash attention off, which can
also change the recognised text. The first speaker scores favour forced alignment on one
recording; independent validation is still pending. See
[the pipeline guide](docs/diarization.md) and [partial benchmark results](docs/diarization-evaluation.md#results).
The fr/de/es/it alignment models have non-commercial licences; setup warns
before downloading them.

## For researchers

If you work with sensitive recordings (participant interviews, clinical conversations, confidential data), Transcriber may be useful.

Recordings and transcripts stay on the local CPU or GPU during processing.
Model setup uses the network, and the GUI checks for updates and may download
them. Transcription works without a network connection once the models are
prepared. Check this behaviour against your institution's data handling rules.

For a description suitable for ethics applications and data management plans, see [docs/privacy-architecture.md](docs/privacy-architecture.md).

## System requirements

- Modern CPU (Intel or AMD)
- 4 GB RAM minimum (8 GB+ recommended for larger models)
- 75 MB - 3.1 GB disk space per Whisper model; several GB more for optional Python packages and models
- GPU optional. Vulkan-capable GPU auto-detected for faster transcription; falls back to CPU if unavailable.
- Internet connection for model setup and updates; offline transcription after setup

## Model sizes

| Model | Size | Relative speed | Best for |
|-------|------|---------------|----------|
| Tiny / Tiny.en | ~75 MB | Fastest | Quick drafts, clear audio |
| Base / Base.en | ~142 MB | Fast | Good balance for simple recordings |
| Small / Small.en | ~466 MB | Moderate | General use |
| Small.en + Speaker ID | ~488 MB | Moderate | Speaker change detection (TinyDiarize) |
| Medium / Medium.en | ~1.5 GB | Slower | Challenging audio, accents |
| Large-v3 Turbo Q5 | ~574 MB | Fast | Good accuracy at a fraction of the size |
| Large-v3 Q5 | ~1.1 GB | Moderate | Large-v3 accuracy, smaller download |
| Large-v3 Turbo | ~1.6 GB | Moderate | Close to Large-v3 accuracy, faster |
| Large-v3 | ~3.1 GB | Slowest | Maximum accuracy |

`.en` models are English-optimised and faster when multilingual support is not needed. Q5 models use 5-bit quantization to reduce file size, with some quality trade-off.

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
- [OpenAI Whisper](https://github.com/openai/whisper): speech recognition models (MIT)
- [FFmpeg](https://ffmpeg.org): multimedia processing (configured Windows and Linux builds are GPLv3)
- [Electron](https://www.electronjs.org): desktop framework (MIT)
- [ggml](https://github.com/ggml-org/ggml): tensor library (MIT)
- [pyannote.audio](https://github.com/pyannote/pyannote-audio): speaker diarization (MIT)
- [WhisperX](https://github.com/m-bain/whisperX): optional word alignment (BSD-2-Clause)
- [PyTorch](https://pytorch.org): machine learning framework (BSD-3-Clause)
- [NumPy](https://numpy.org): numerical computing (BSD-3-Clause)

## Licence

Transcriber's code uses [GPL-3.0-only](LICENSE). You may use it, including
commercially, and modify it. Distributing copies or modified versions requires
following the GPL's notice and source requirements.

Third-party software, fonts and downloaded models keep their own licences.
Some optional alignment weights have non-commercial terms, and the downloaded
Punkt tokenizer data has unclarified terms. See [the licensing review](docs/licensing.md)
for the component list, evidence and outstanding release requirements.
