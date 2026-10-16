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

Local setup/build and native Windows/Linux release steps verify each archive
against its existing SHA-256 in `deps.json` before extraction. Installed build
caches also carry a receipt tying the archive identity to the extracted binary.
A changed upstream archive is rejected; a successful hash check does not
complete the source/notice release checks below.

## Licence of the bundled binary

FFmpeg's base licence is LGPL 2.1 or later, but enabling GPL components changes
the binary's licence. See [FFmpeg's licence explanation](https://ffmpeg.org/legal.html).
Both configured suppliers describe their builds as GPLv3:
[Gyan's Windows essentials builds](https://www.gyan.dev/ffmpeg/builds/) and
[John Van Sickle's Linux static builds](https://johnvansickle.com/ffmpeg/).
The checked Linux 7.0.2 binary reports `--enable-gpl --enable-version3`.
Do not describe the bundled builds as LGPL-only.

Check each distributed binary with `ffmpeg -L` and `ffmpeg -version`, including
Windows or replacement builds. Transcriber runs it as a replaceable subprocess;
that does not remove the binary's licence and source distribution obligations.

## Outstanding release checks

The 2026-10-14 review found that `scripts/build.sh` and the remote release
workflow copy the FFmpeg executable out of the supplier archive. They do not
establish delivery of the matching Corresponding Source, including the source
and build information for libraries included in the static build. The in-app
notice and a link to FFmpeg's main repository do not settle this requirement.

Before publishing installers, complete these checks for each platform:

- [ ] Save the exact binary identity, checksum, `-version`, `-buildconf` and `-L` output.
- [ ] Retain the supplier's licence and third-party notices with the package.
- [ ] Provide matching Corresponding Source and build instructions through an
  appropriate GPLv3 distribution method, with working links from the binary's
  download location. A source archive for a different build is insufficient.

These items are not marked complete by a successful GitHub Actions build.
See [GPLv3 section 6](https://www.gnu.org/licenses/gpl-3.0.html#section6) and
[the licensing review](licensing.md).

## Replacing the bundled FFmpeg

To use a different FFmpeg binary:

1. Place your `ffmpeg` (or `ffmpeg.exe` on Windows) in the appropriate `bin/{platform}/` directory
2. The binary must support the WAV output codec (`pcm_s16le`) and the input formats you need
3. Restart Transcriber

In a packaged build, the binary is located in the app's `resources/bin/{platform}/` directory.
