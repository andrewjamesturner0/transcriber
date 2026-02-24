# Transcriber

Private, on-device audio transcription. Your files never leave your computer.

Transcriber is a desktop app that converts audio to text using [whisper.cpp](https://github.com/ggml-org/whisper.cpp). No cloud services, no accounts, no internet required for transcription.

## Features

- **Fully local** — all processing happens on your machine
- **Multiple formats** — MP3, WAV, FLAC, M4A, OGG, WebM, WMA, AAC
- **Batch processing** — queue multiple files and transcribe them all at once
- **Model picker** — choose from Tiny (75 MB) to Large-v3 (3.1 GB), download models directly in the app
- **Speaker diarization** — identify different speakers in the audio (using TinyDiarize models)
- **Copy and save** — copy transcript to clipboard or save as a text file

## Download

Grab the latest release for your platform:

| Platform | Format |
|----------|--------|
| Windows | `.zip` — extract and run `Transcriber.exe` |
| Linux | `.AppImage` — `chmod +x` and run directly |

The app ships with the Tiny English model (75 MB). You can download larger models from within the app for better accuracy.

## Models

| Model | Size | Languages | Notes |
|-------|------|-----------|-------|
| Tiny | 75 MB | English or multilingual | Fast, good for quick drafts |
| Base | 142 MB | English or multilingual | Better accuracy, still fast |
| Small | 466 MB | English or multilingual | Good balance of speed and quality |
| Medium | 1.5 GB | English or multilingual | High accuracy, slower |
| Large v3 | 3.1 GB | Multilingual | Best accuracy, requires more RAM |

Larger models are more accurate but need more RAM and take longer to process. Start with Tiny or Base and upgrade if you need better results.

## How It Works

1. **Choose a model** — pick one from the dropdown (or download a new one)
2. **Select audio files** — click to browse or drag and drop
3. **Transcribe** — hit the button and wait for results
4. **Save or copy** — copy the transcript to your clipboard or save it as a file

The app uses FFmpeg to convert your audio to the format whisper.cpp expects, then runs whisper-cli to produce the transcript. Everything runs locally using your CPU (up to 8 threads).

## Troubleshooting

**Transcription is slow** — Larger models and longer audio take more time. Try the Tiny or Base model first. The app shows a time estimate before you start.

**Out of memory** — Large models (Medium, Large) need significant RAM. If the app crashes or hangs, switch to a smaller model.

**Unsupported file** — If a file fails, check that it's a valid audio file in one of the supported formats.

## Credits

Built with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), [FFmpeg](https://ffmpeg.org/), and [Electron](https://www.electronjs.org/). See the in-app license viewer for full open source attributions.

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE).

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for build instructions, project structure, and contributor information.
