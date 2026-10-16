# Privacy architecture

Transcriber processes audio and video locally on the user's computer.
Transcription, word alignment and speaker diarisation use local processes
and prepared models. They do not upload audio or transcript text.

This document describes the data flow for ethics applications, data management
plans and institutional reviews. Model setup and application updates use the
network; a local transcription job does not need a network connection.

## Data flow

1. The user selects a local audio or video file.
2. FFmpeg converts it to a temporary 16 kHz mono PCM WAV on the local filesystem.
3. whisper.cpp transcribes that WAV with a local Whisper model.
4. If speaker labelling is on, a Python process matches the recognised words
   to the same WAV using a prepared word alignment model. It changes word
   times, not text.
5. Still for speaker labelling, a separate Python process runs Community-1
   from the local cache. Its exclusive timeline assigns one speaker at each
   time; its regular timeline records overlap. TinyDiarize models instead detect
   speaker changes within whisper.cpp.
6. The app displays the transcript. The user can copy or export it.

The pipeline deletes temporary WAV and JSON files after success, failure or
cancellation. Exported transcripts remain where the user saves them. This is
ordinary file deletion, not secure erasure. Each job has its own private
temporary directory. Completed queue results and errors stay in memory until
removed, cleared or the app closes; the queue is not saved across restarts.
The GUI also writes local logs containing file paths and subprocess output,
which may include transcript text. Logs keep a current file and one rotated
file, each bounded to 5 MiB; queued diagnostics are bounded to 1 MiB and may
be truncated or dropped with a summary. Users should treat logs and exports
as sensitive. Closing the app or installing an update stops new work, cancels
owned jobs/setup/downloads and waits for cleanup and log flushing, up to a
ten-second shutdown deadline. A timeout can leave processes or temporary
files behind.

Whisper model downloads from the GUI go to its writable
`app.getPath('userData')/models` folder; bundled `resources/models` files are
a fallback. Development GUI bundles use repository `models/` as that
fallback. The CLI reads and writes repository `models/` independently.
Optional Python models remain in the Hugging Face/torch caches used by the
selected interpreter.

## Network activity

Network use is limited to setup and application maintenance:

- Whisper model downloads initiated by the user (about 75 MB to 3.1 GB).
- Optional Python package installation and explicit speaker/alignment model
  setup. Community-1 access requires a Hugging Face account and acceptance
  of its access conditions; a Read token authenticates the download.
- Update checks on GUI startup and automatic update downloads when available.
- External documentation links opened by the user in their browser.

Speaker and alignment jobs set Hugging Face offline flags before imports and
disable pyannote/Hugging Face telemetry. Alignment also loads its models from
the local Hugging Face and torch caches only and blocks torch hub downloads
during inference. It uses no NLTK data. Missing
models produce a setup message or a declared fallback, rather than an inference
download. The Hugging Face token is passed to setup through the process
environment and is not saved by Transcriber. Later inference needs no token.

The app has no cloud transcription service, usage analytics or Transcriber
user account. It can transcribe without internet access once the models are
prepared. An update request still exposes ordinary connection information,
such as the source IP address, to the update host; it does not contain the
recording or transcript.

## Technical components

| Component | Role | Licence | Source |
|-----------|------|---------|--------|
| whisper.cpp | Speech recognition | MIT | [Source](https://github.com/ggml-org/whisper.cpp) |
| FFmpeg | Media conversion | Depends on build; LGPL or GPL | [Bundling details](ffmpeg.md) |
| Whisper models | Recognition weights | MIT | [Source](https://github.com/openai/whisper) |
| TinyDiarize | Speaker change detection | MIT | [Source](https://github.com/akashmjn/tinydiarize-whisper.cpp) |
| pyannote.audio | Optional speaker inference | MIT | [Source](https://github.com/pyannote/pyannote-audio) |
| Community-1 | Optional speaker model | CC BY 4.0 | [Model](https://huggingface.co/pyannote/speaker-diarization-community-1) |
| WhisperX and TorchAudio tutorial code | Alignment path search adapted into `lib/alignment_core.py` | BSD 2-Clause | [WhisperX](https://github.com/m-bain/whisperX/blob/v3.8.6/LICENSE), [TorchAudio](https://github.com/pytorch/audio/blob/v0.12.1/LICENSE) |
| transformers | Loads alignment models for languages other than English, French, German, Spanish and Italian | Apache-2.0 | [Source](https://github.com/huggingface/transformers) |
| English wav2vec2 model | Word alignment weights for speaker labelling | MIT | [Attribution](../NOTICE) |
| Electron | Desktop framework | MIT | [Source](https://www.electronjs.org) |

Some non-English alignment models have separate licences, including
non-commercial terms for fr/de/es/it. See [the licensing review](licensing.md)
and [the setup guide](diarization-setup.md).
Optional Python packages and models are installed separately from the app.

## Verification

The [source code](https://github.com/andrewjamesturner0/transcriber) is public
under GPLv3. Relevant code is `lib/transcription-runner.js`, `lib/diarize.py`,
`lib/align.py`, `lib/alignment_models.py`, `scripts/setup-diarization.py` and
the update handler in `main.js`.

Verify a prepared installation by running a transcription job with networking
disabled, or monitoring its processes' network activity. Distinguish inference
from setup downloads and the GUI updater. Deterministic privacy contracts are
checked in `scripts/test-diarize-contract.py` and `scripts/test-align-contract.py`.
`npm test` also exercises isolated stores/downloads, cleanup and structured
results without real models. `npm run test:electron` exercises the renderer
and lifecycle with harmless local children; Linux checks have passed locally.
Native Windows lifecycle/installer checks and real model/platform smoke
checks remain separate acceptance work; these fixtures do not prove the
behaviour on every supported installation.

## Use in ethics applications

Suggested wording, to adapt to the actual installation and local policy:

> Audio recordings will be transcribed using Transcriber, a free, open-source
> desktop application that processes recordings locally on the researcher's
> computer. Transcription and optional speaker labelling (word alignment and
> speaker diarisation) use prepared local models without uploading recordings
> or transcripts. Model
> setup and software updates use the network. Transcripts, temporary files and
> application logs are held locally and managed under the study's data handling
> procedures. The source code is available under GPLv3 for audit.

## Contact

For questions about architecture or data handling, open an issue on the
[GitHub repository](https://github.com/andrewjamesturner0/transcriber/issues).
