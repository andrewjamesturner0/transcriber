# Privacy architecture

This document describes Transcriber's data processing boundary for ethics applications, IRB submissions, data management plans, and institutional reviews.

## Summary

Transcriber processes audio and video locally. No audio, transcript text, or transcription metadata is sent to a cloud inference service. There is no telemetry and no Transcriber account system.

Transcription can run without internet once the required runtime, selected speech model, and optional pyannote assets are local. The application can make separate network requests: an automatic update check can occur on startup and may download an available update, model downloads are user-initiated, and optional pyannote may fetch missing model assets.

## Local transcription flow

1. The user selects a local audio or video file.
2. Bundled FFmpeg runs as a local child process and creates a temporary 16 kHz mono WAV.
3. The selected local engine processes the WAV:
   - one of the 12 retained Whisper models runs through a local whisper.cpp child process; or
   - a supported new-family model runs through an isolated local Node 22 transcribe.cpp worker.
4. If speaker labels are enabled for a validated model, local pyannote.audio processes the same WAV and `lib/diarize-merge.js` combines its speaker segments with local word timing.
5. The transcript returns to the application and remains in memory until it is replaced or cleared, or the app exits. Copying or saving it does not clear it.
6. Temporary conversion and result files are removed after the job.

TinyDiarize is not part of the current catalogue. Pyannote is enabled only for models whose word timing has been validated with Transcriber's speaker merge. At present, that is the retained Whisper catalogue. MOSS has a built-in speaker experiment in the catalogue but is unavailable with the pinned runtime.

## Network activity

Local inference does not transmit audio, transcript text, or transcription metadata. Other application network activity is limited to:

- speech model downloads started by the user;
- pyannote model downloads when its external cache does not contain the required assets;
- automatic update checks on startup and update downloads through GitHub Releases.

Speech model downloads come from pinned Hugging Face revisions. Downloads use HTTPS, a temporary file, SHA-256 verification, and atomic installation. A saved Hugging Face bearer token is attached only to approved Hugging Face hosts; redirects to external storage do not receive it. MedASR is gated and requires accepted upstream access. MOSS cannot currently be downloaded.

These requests do not upload the selected audio, generated transcript, or transcription options. An update check necessarily sends ordinary network connection data such as the application's IP address and request headers to the update host. Hugging Face receives equivalent connection data during a model download.

## Local storage

The GUI stores application data under Electron's per-user `userData` directory:

- `settings.json` stores processing-device preference and an optional Hugging Face token;
- `models/` stores downloaded model files;
- `logs/transcriber.log` stores local diagnostic logs and rotates at 5 MB.

The renderer never receives the saved token. Runner logs redact the saved token. The standalone CLI does not read GUI settings: it accepts a token from `--hf-token` or `HF_TOKEN` and stores models in its writable per-user data directory (or `TRANSCRIBER_MODEL_DIR`).

The build includes the tiny.en model as a bundled fallback in read-only application resources. The other 11 retained Whisper model files are optional separate downloads. Writable downloaded models take priority.

## Components

| Component | Local role | Licence |
| --- | --- | --- |
| whisper.cpp | Inference for 12 retained Whisper models | MIT |
| transcribe.cpp | Inference runtime for supported new-family models | MIT |
| Node worker and Koffi | Isolated transcribe.cpp process and native binding | Node licence / MIT |
| FFmpeg | Audio and video conversion | GPLv3 for the bundled static builds |
| Speech model files | Local neural-network weights | Per-model terms shown in the catalogue and notices |
| pyannote.audio | Optional local speaker analysis | MIT |
| Electron | Desktop application framework | MIT |

For exact model licences and attribution, see the in-app model details, `NOTICE`, and `THIRD-PARTY-LICENSES.json`.

## Verification boundary

The source can be inspected to check local processing, worker isolation, download allowlisting, and token redaction. A network monitor can check that a transcription job makes no network connection after the required assets are installed.

The full Windows/Linux installed-app and offline-network acceptance matrix is still a release gate for the model playground. Do not treat development-only or limited local tests as evidence that every candidate model, platform, or Vulkan device has passed acceptance.

## Suggested wording for ethics applications

> Audio recordings will be transcribed using Transcriber (https://github.com/andrewjamesturner0/transcriber), a free, open-source desktop application that runs speech recognition locally on the researcher's computer. Inference does not transmit audio, transcript text, or transcription metadata. Separate network access may be used for a software update check on startup, user-initiated model downloads, and missing optional pyannote assets. Once all assets selected for a job are local, transcription can run without internet access. The source is available under GPLv3 for audit.

## Source code and contact

Source: https://github.com/andrewjamesturner0/transcriber

For questions about architecture or data handling, open an issue on the [GitHub repository](https://github.com/andrewjamesturner0/transcriber/issues).
