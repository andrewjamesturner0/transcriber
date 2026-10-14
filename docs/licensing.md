# Licensing review

Reviewed on 2026-10-14 against the optional package pins, the model choices in
`lib/align.py`/WhisperX 3.8.6, the bundled font metadata and the packaging rules.
The disclosures below describe the components, not a blanket clearance of
every supported installation or model.

## What the app includes

Transcriber's own code is GPL-3.0-only, as declared in `package.json`. Its
[licence](../LICENSE) does not replace the terms of third-party components.

| Component | Terms | Disclosure and evidence |
| --- | --- | --- |
| whisper.cpp, ggml and Whisper weights | MIT | Existing notices retained in [NOTICE](../NOTICE) and the in-app component list. |
| Electron/Chromium | MIT and third-party terms | Electron's own `LICENSE.electron.txt` and `LICENSES.chromium.html` accompany the checked Linux unpacked package. The short in-app entry is not the whole Chromium notice bundle. |
| Runtime npm packages | Their own licences | Licence files, including electron-updater's, are retained under `node_modules` in the checked app archive. This is not a fresh audit of every transitive dependency. |
| FFmpeg | Configured Windows and Linux builds: GPLv3 | Both [Gyan](https://www.gyan.dev/ffmpeg/builds/) and [John Van Sickle](https://johnvansickle.com/ffmpeg/) say their builds are GPLv3. See [the source-delivery gap](ffmpeg.md#outstanding-release-checks). |
| DM Sans and DM Mono | SIL Open Font License 1.1 | The embedded font copyright notices match the upstream [DM Sans](https://github.com/google/fonts/blob/main/ofl/dmsans/OFL.txt) and [DM Mono](https://github.com/google/fonts/blob/main/ofl/dmmono/OFL.txt) notices. Full licence files now ship beside the fonts and appear in the in-app list. |

The packager includes [NOTICE](../NOTICE), [the component list](../THIRD-PARTY-LICENSES.json),
the GPL text and `renderer/fonts/`. It excludes credentials, research recordings
and local environments. This was checked against the Linux archive; Windows
installer inspection is still outstanding.

## Optional software and downloaded assets

The app does not bundle Python, Python packages, Community-1, alignment weights
or Punkt data. Installing or downloading them separately does not remove their
usage or redistribution conditions.

| Component | Terms | Assessment |
| --- | --- | --- |
| pyannote.audio 4.0.7 | MIT | Matches its [versioned licence](https://github.com/pyannote/pyannote-audio/blob/4.0.7/LICENSE). |
| Community-1 speaker model | CC BY 4.0 | Matches the [model card](https://huggingface.co/pyannote/speaker-diarization-community-1). This is separate from pyannote.audio's code licence. Hugging Face's contact-sharing/access conditions apply to the initial download; they do not mean audio processing is hosted. |
| WhisperX 3.8.6 | BSD 2-Clause | Matches its [versioned licence](https://github.com/m-bain/whisperX/blob/v3.8.6/LICENSE). This covers the software, not every asset it loads. |
| English alignment weights | MIT | [Torchaudio 2.8's bundle documentation](https://docs.pytorch.org/audio/2.8.0/generated/torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H.html) states that these weights are MIT. The LibriSpeech training corpus has its own CC BY 4.0 terms; do not substitute the corpus licence for the model licence. |
| fr/de/es/it alignment weights | CC BY-NC 4.0 | WhisperX selects VoxPopuli bundles for these languages. [Torchaudio documents their non-commercial terms](https://docs.pytorch.org/audio/2.8.0/generated/torchaudio.pipelines.VOXPOPULI_ASR_BASE_10K_FR.html). Setup already warns; NOTICE and the in-app list now include them too. |
| Other language alignment weights | Per model | Resolve the model from the installed WhisperX table and check its exact upstream model card. This review does not clear every language. |
| NLTK software / Punkt tokenizer data | Apache-2.0 software / unclarified data terms | NLTK's [licensing overview](https://github.com/nltk/nltk_data/blob/gh-pages/LICENSE-OVERVIEW.md) and [dataset list](https://github.com/nltk/nltk_data/blob/gh-pages/DATASET-LICENSES.md) explicitly distinguish dataset terms and flag Punkt as unclarified. The [punkt_tab package entry](https://github.com/nltk/nltk_data/blob/gh-pages/packages/tokenizers/punkt_tab.xml) has no licence attribute. |

The optional requirements also install PyTorch, torchaudio, torchcodec,
huggingface-hub and transitive packages. They retain their package licences;
this review does not certify the entire Python/CUDA dependency tree for
redistribution. A future bundled Python environment needs its own full inventory.

## Outstanding questions

- [ ] Establish the terms for the Punkt tokenizer data with the rights holders,
  or replace its use with a path that does not need these pretrained assets.
  Even the English alignment feature includes this unresolved dependency;
  the English model's MIT licence is not clearance of the complete feature.
- [ ] Complete the [FFmpeg release checks](ffmpeg.md#outstanding-release-checks)
  for exact source, build information and supplier notices. The current build
  workflow copies binaries but does not establish matching source delivery.
- [ ] Inspect Windows installer notices and review other language models before
  making broader claims about them.

No processing behaviour or model choice was changed to resolve these open
questions. The setup guide and in-app disclosures now expose the limits of
what has been checked. A successful packaging job is not a licensing sign-off.
