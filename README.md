# Transcriber

[![GPLv3 License](https://img.shields.io/badge/licence-GPLv3-blue.svg)](LICENSE)

Local audio and video transcription powered by OpenAI's Whisper — entirely on your machine.

Transcriber is a desktop application that transcribes audio and video files using the Whisper speech recognition model. All processing happens locally. No audio is sent anywhere and no accounts are needed.

**Download:** [Windows & Linux — GitHub Releases](https://github.com/andrewjamesturner0/transcriber/releases)

---

## Features

- **Completely local** — your audio never leaves your computer. No cloud, no telemetry, no network calls.
- **Speaker diarisation** — automatically identifies and labels speaker changes. (This is not very good however.)
- **9 Whisper model sizes** — from Tiny (fastest) to Large-v3 (most accurate). English-optimised models available.
- **8 audio and video formats** — MP3, WAV, FLAC, OGG, M4A, AAC, WMA, MP4
- **Batch processing** — queue multiple files and transcribe them sequentially
- **Cross-platform** — Windows and Linux

## Install

### Direct download

Download the latest release for your platform from the [Releases page](https://github.com/andrewjamesturner0/transcriber/releases).

| Platform | Format |
|----------|--------|
| Windows | NSIS installer or portable ZIP |
| Linux | AppImage |

Note: The packages are not signed, so will throw some warnings when installing.

## How it works

```
Your audio/video file
    → FFmpeg converts to WAV (locally)
    → whisper.cpp transcribes the audio (locally)
    → (If using an appropriate model) TinyDiarize labels speakers (locally)
    → Your transcript, ready to use
```

Transcriber wraps [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and [FFmpeg](https://ffmpeg.org) in an Electron app. The main process spawns these as child processes; no native bindings or compilation required. Models are downloaded once and stored locally; after that, Transcriber works offline.

## For researchers

If you work with sensitive recordings (participant interviews, clinical conversations, confidential data), Transcriber may be useful.

**Why local processing matters:**
- Ethics committees often prohibit uploading recordings to cloud services
- GDPR Article 25 (Data Protection by Design) favours tools that minimise data exposure
- Institutional policies may restrict third-party data processing
- Participant consent forms may specify local-only handling

**What you can tell your ethics committee:** Transcriber processes audio using machine learning models running on the local CPU. No audio, transcript text, or metadata is transmitted over any network. No third-party data processor is involved. The application makes no network connections after initial model download.

For a detailed architecture description suitable for ethics applications and data management plans, see [docs/privacy-architecture.md](docs/privacy-architecture.md).

## System requirements

- Modern CPU (Intel or AMD)
- 4 GB RAM minimum (8 GB+ recommended for larger models)
- 75 MB – 3 GB disk space per model
- No GPU required
- Internet connection for first-time model download only

## Model sizes

| Model | Size | Relative speed | Best for |
|-------|------|---------------|----------|
| Tiny / Tiny.en | ~75 MB | Fastest | Quick drafts, clear audio |
| Base / Base.en | ~150 MB | Fast | Good balance for simple recordings |
| Small / Small.en | ~500 MB | Moderate | General use |
| Medium / Medium.en | ~1.5 GB | Slower | Challenging audio, accents |
| Large-v3 | ~3 GB | Slowest | Maximum accuracy |

`.en` models are English-optimised and faster when multilingual support isn't needed.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, coding style, and the PR process.

## Sponsors

Transcriber is free software. If it's useful to you, consider [sponsoring development](https://github.com/sponsors/andrewjamesturner0).

## Built with

- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) — C/C++ Whisper inference (MIT)
- [OpenAI Whisper](https://github.com/openai/whisper) — speech recognition models (MIT)
- [FFmpeg](https://ffmpeg.org) — multimedia processing (LGPL 2.1)
- [Electron](https://www.electronjs.org) — desktop framework (MIT)
- [ggml](https://github.com/ggml-org/ggml) — tensor library (MIT)

## Licence

[GPLv3](LICENSE) — free to use, modify, and distribute. Derivative works must also be open-source under GPLv3.
