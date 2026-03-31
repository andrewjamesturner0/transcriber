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

## LGPL 2.1 compliance

FFmpeg is licensed under the GNU Lesser General Public License version 2.1.

Because Transcriber runs FFmpeg as a **separate process** rather than linking it as a library, the LGPL re-linking obligation is satisfied automatically. Users can substitute their own FFmpeg binary by replacing the file in `bin/{platform}/`.

The pre-built binaries from the sources above are built without `--enable-gpl`, so they remain under LGPL 2.1. Even if a GPL-enabled FFmpeg build were used, this would be compatible with Transcriber's GPLv3 licence.

## Replacing the bundled FFmpeg

To use a different FFmpeg binary:

1. Place your `ffmpeg` (or `ffmpeg.exe` on Windows) in the appropriate `bin/{platform}/` directory
2. The binary must support the WAV output codec (`pcm_s16le`) and the input formats you need
3. Restart Transcriber

In a packaged build, the binary is located in the app's `resources/bin/{platform}/` directory.
