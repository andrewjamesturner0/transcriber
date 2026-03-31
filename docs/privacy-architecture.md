# Privacy architecture

This document describes Transcriber's data processing architecture for use in ethics applications, IRB submissions, data management plans, and institutional data governance reviews.

## Summary

Transcriber is a desktop application that processes audio and video files locally on the user's computer. **No data is transmitted over any network during transcription.** There is no cloud component, no remote API, no telemetry, and no user accounts.

## Data flow

1. The user selects an audio or video file from their local filesystem.
2. FFmpeg (running as a local process) converts the file to WAV format. The converted file is stored temporarily on the local filesystem.
3. whisper.cpp (running as a local process) processes the WAV file using a Whisper model stored on the local filesystem. The transcript is generated in memory and passed to the application.
4. If diarisation is enabled, pyannote.audio (or TinyDiarize for the small.en-tdrz model) identifies distinct speakers and labels transcript segments accordingly. This runs locally.
5. The transcript is displayed in the application interface. It remains in application memory until the user copies or exports it.

**At no point in this process is any data transmitted over a network.**

## Network activity

Transcriber makes **no network connections during transcription**. No audio, text, or metadata is transmitted at any point in the transcription process.

Network activity is limited to:
- Model downloads (75 MB – 3.1 GB per model, once per model, initiated by the user)
- An automatic update check on startup (queries GitHub Releases for newer versions; no user data is sent)

The application:
- Does not transmit audio, text, or metadata
- Does not collect usage analytics or telemetry
- Does not require an internet connection after model download
- Does not require user accounts or registration

## Technical components

| Component | Role | Licence | Source |
|-----------|------|---------|--------|
| whisper.cpp | Speech-to-text inference | MIT | https://github.com/ggml-org/whisper.cpp |
| FFmpeg | Audio/video format conversion | LGPL 2.1 | https://ffmpeg.org |
| Whisper models | Neural network weights | MIT | https://github.com/openai/whisper |
| TinyDiarize | Speaker change detection | MIT | Integrated with whisper.cpp |
| pyannote.audio | Speaker diarisation (optional) | MIT | https://github.com/pyannote/pyannote-audio |
| Electron | Application framework | MIT | https://www.electronjs.org |

All components run locally. No component makes network requests during transcription.

## Source code

Transcriber is free and open-source software released under the GNU General Public License v3.0. The complete source code is available at:

https://github.com/andrewjamesturner0/transcriber

The source code can be audited to verify the claims made in this document.

## Verification

Because Transcriber is open-source (GPLv3), the architecture described here can be independently verified by:
1. Inspecting the source code
2. Monitoring network activity during operation (the application makes no connections)
3. Running the application in a network-isolated environment (it functions identically)

## Use in ethics applications

Suggested language for ethics board submissions:

> Audio recordings will be transcribed using Transcriber (https://github.com/andrewjamesturner0/transcriber), a free, open-source desktop application that processes audio locally on the researcher's computer. No audio data is transmitted to cloud services or third parties during transcription. The software's source code is publicly available under the GNU General Public License v3.0 and can be audited to verify this claim. A detailed privacy architecture document is available at https://github.com/andrewjamesturner0/transcriber/blob/master/docs/privacy-architecture.md.

## Contact

For questions about Transcriber's architecture or data handling, open an issue on the [GitHub repository](https://github.com/andrewjamesturner0/transcriber/issues).
