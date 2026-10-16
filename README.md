# Transcriber

[![GPLv3 License](https://img.shields.io/badge/licence-GPLv3-blue.svg)](LICENSE)

Local audio and video transcription powered by OpenAI's Whisper. All processing on-device.

Transcriber is a desktop application that transcribes audio and video files using the Whisper speech recognition model. All processing happens locally. No audio is sent anywhere. Basic transcription needs no account; optional speaker model setup needs a Hugging Face account.

**Download:** [Windows & Linux; GitHub Releases](https://github.com/andrewjamesturner0/transcriber/releases)

---

## Features

- Local processing. Your audio and transcript stay on your computer. Model downloads and update checks use the network; transcription runs offline with telemetry disabled.
- Speaker diarisation, with built-in speaker change detection and optional advanced speaker labels via [pyannote.audio](#speaker-labels-advanced)
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
    -> (Optional) Label speakers: match each word to the audio, then work out
       who spoke when with pyannote.audio (locally). TinyDiarize models
       instead mark speaker changes during transcription.
    -> Your transcript, ready to use
```

Transcriber wraps [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and [FFmpeg](https://ffmpeg.org) in an Electron app. The main process spawns these as child processes; no native bindings or compilation required. Models are downloaded once and stored locally; after that, Transcriber works offline. For details on FFmpeg bundling and licensing, see [docs/ffmpeg.md](docs/ffmpeg.md).

## Speaker labels (advanced)

Turn on **Label speakers** in Settings to mark who said each line. It runs on
your computer and does two things in every labelled job: a word alignment
model matches each recognised word to the audio, then
[pyannote.audio](https://github.com/pyannote/pyannote-audio) with the
Community-1 model works out who spoke when. There is one switch and no
partial mode. It does not change the words, identify people by name or
separate voices that overlap, and it is not perfect: on the one recording
measured so far, 1.4% of words still went to the wrong speaker.

It needs software and models that the app does not bundle:

| You need | Licence | How you get it |
| --- | --- | --- |
| Python 3.10 to 3.13 | PSF License | python.org |
| pyannote.audio 4.0.7, PyTorch 2.8.0, torchaudio 2.8.0, torchcodec 0.7.0, huggingface-hub 0.36.2, Transformers 4.57.6 | MIT, BSD-3-Clause, BSD-2-Clause, BSD-3-Clause, Apache-2.0, Apache-2.0 | `pip install -r lib/requirements.txt` (about 7 GB with CUDA) |
| Community-1 speaker model (33 MB) | CC BY 4.0 | Download once; needs a Hugging Face account that has accepted the model's access conditions, and a Read token |
| English word alignment model (361 MB) | MIT | Download once; no account |

Setup in short:

1. Install Python 3.10 to 3.13 and run `pip install -r lib/requirements.txt`
   (Windows with an NVIDIA GPU: install the CUDA build of PyTorch first).
2. Accept the conditions on the [Community-1 model page](https://huggingface.co/pyannote/speaker-diarization-community-1)
   and create a [Hugging Face Read token](https://huggingface.co/settings/tokens).
3. In Settings > Speaker Labels, paste the token and click **Download speaker
   models**. The token is used for this download only and is not saved.
4. When both models show as ready, turn on **Label speakers**. Jobs then run
   offline and need no token.

A CUDA GPU is strongly recommended; on a CPU labelling is slow. Other
languages need their own alignment model, and the French, German, Spanish
and Italian ones are for non-commercial use only. The
[setup guide](docs/diarization-setup.md) lists every component and licence,
and covers other languages and troubleshooting. On the CLI, `--diarize` runs
the same two steps.

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
- [WhisperX](https://github.com/m-bain/whisperX) and [TorchAudio](https://github.com/pytorch/audio): word-alignment path search adapted into Transcriber (BSD-2-Clause)
- [Transformers](https://github.com/huggingface/transformers): loader for alignment models in languages other than English, French, German, Spanish and Italian (Apache-2.0)
- [PyTorch](https://pytorch.org) and [torchaudio](https://github.com/pytorch/audio): machine learning framework and audio models (BSD-3-Clause, BSD-2-Clause)
- [pyannote Community-1](https://huggingface.co/pyannote/speaker-diarization-community-1): speaker model (CC BY 4.0); wav2vec 2.0 English alignment model (MIT)
- [NumPy](https://numpy.org): numerical computing (BSD-3-Clause)

## Licence

Transcriber's code uses [GPL-3.0-only](LICENSE). You may use it, including
commercially, and modify it. Distributing copies or modified versions requires
following the GPL's notice and source requirements.

Third-party software, fonts and downloaded models keep their own licences.
Some optional alignment weights have non-commercial terms. See [the licensing review](docs/licensing.md)
for the component list, evidence and outstanding release requirements.
