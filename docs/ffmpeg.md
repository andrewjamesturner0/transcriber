# FFmpeg in Transcriber

## How FFmpeg is used

Transcriber bundles FFmpeg as a pre-built binary in `bin/{platform}/`. It is **spawned as a child process** (not linked as a library) to convert input audio/video files to 16 kHz mono WAV before passing them to the selected whisper.cpp or transcribe.cpp engine.

The conversion command is equivalent to:

```
ffmpeg -i input.mp3 -ar 16000 -ac 1 -c:a pcm_s16le -y output.wav
```

## Binary sources

| Platform | Source | Build |
|----------|--------|-------|
| Windows | [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) | `ffmpeg-release-essentials.zip` |
| Linux | [johnvansickle.com](https://johnvansickle.com/ffmpeg/) | Static build (`ffmpeg-release-amd64-static.tar.xz`) |

## GPLv3 compliance

The configured Windows and Linux FFmpeg binaries are static GPLv3 builds:

- gyan.dev states that all of its static Windows builds, including the configured release essentials build, are licensed as GPLv3.
- johnvansickle.com states that its Linux static builds are GPLv3. The currently bundled Linux binary also reports `--enable-gpl --enable-version3` in its configuration.

[FFmpeg's licensing guidance](https://ffmpeg.org/legal.html) explains that enabling GPL-covered parts makes the GPL apply to the resulting FFmpeg build. `--enable-version3` selects version 3-compatible licensing terms. Transcriber is licensed under GPLv3, so these bundled FFmpeg builds are licence-compatible with it.

Running FFmpeg as a separate process describes the application architecture. It does not change or avoid the GPL obligations for distributing the bundled binary. The GPLv3 licence text is available from the [GNU Project](https://www.gnu.org/licenses/gpl-3.0.html). The configured [Windows build page](https://www.gyan.dev/ffmpeg/builds/) and [Linux build page](https://johnvansickle.com/ffmpeg/) provide build and source details, and FFmpeg publishes its [source downloads and repository links](https://ffmpeg.org/download.html#get-sources).

## Replacing the bundled FFmpeg

To use a different FFmpeg binary:

1. Place your `ffmpeg` (or `ffmpeg.exe` on Windows) in the appropriate `bin/{platform}/` directory.
2. The binary must support the WAV output codec (`pcm_s16le`) and the input formats you need.
3. Restart Transcriber.

In a packaged build, the binary is located in the app's `resources/bin/{platform}/` directory.
