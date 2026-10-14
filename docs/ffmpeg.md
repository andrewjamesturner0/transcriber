# FFmpeg in Transcriber

## How FFmpeg is used

Transcriber bundles FFmpeg as a pre-built binary in `bin/{platform}/`. It is **spawned as a child process** (not linked as a library) to convert input audio/video files to 16 kHz mono WAV format before passing them to whisper.cpp for transcription.

The conversion command is equivalent to:

```
ffmpeg -i input.mp3 -ar 16000 -ac 1 -c:a pcm_s16le -y output.wav
```

## Binary sources

| Platform | Source | Build |
|----------|--------|-------|
| Windows | [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) | `ffmpeg-release-essentials.zip` |
| Linux | [johnvansickle.com](https://johnvansickle.com/ffmpeg/) | Static build (`ffmpeg-release-amd64-static.tar.xz`) |

## Licence of the bundled binary

FFmpeg's base licence is LGPL 2.1 or later, but enabling GPL components changes
the binary's licence. See [FFmpeg's licence explanation](https://ffmpeg.org/legal.html).
The [John Van Sickle Linux builds](https://johnvansickle.com/ffmpeg/) used here
are GPLv3; the local 7.0.2 binary reports `--enable-gpl --enable-version3`.
Do not describe the bundled builds as LGPL-only.

Check each distributed binary with `ffmpeg -L` and `ffmpeg -version`, including
Windows or replacement builds. Transcriber runs it as a replaceable subprocess;
that does not remove the binary's licence and source distribution obligations.

## Replacing the bundled FFmpeg

To use a different FFmpeg binary:

1. Place your `ffmpeg` (or `ffmpeg.exe` on Windows) in the appropriate `bin/{platform}/` directory
2. The binary must support the WAV output codec (`pcm_s16le`) and the input formats you need
3. Restart Transcriber

In a packaged build, the binary is located in the app's `resources/bin/{platform}/` directory.
