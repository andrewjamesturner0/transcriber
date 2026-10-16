# Speaker Labelling Setup Guide

Speaker labelling marks who said each line of a transcript. It is optional,
runs entirely on your computer, and is switched on with one setting:
**Label speakers**. There is no partial mode. Every labelled job runs both
parts below, so both must be set up before the switch can be turned on.

1. Word alignment: a wav2vec 2.0 model matches each word of Whisper's
   transcript to the audio, so each word gets a more accurate time and is
   more likely to go to the right speaker. It changes when words are placed,
   never which words were recognised.
2. Speaker diarisation: [pyannote.audio](https://github.com/pyannote/pyannote-audio)
   with the Community-1 model works out who spoke when.

Speaker labelling does not identify people by name, and it does not separate
voices that speak at the same time. It is not perfect. On the one recording
measured so far, alignment halved the words given to the wrong speaker, from
2.7% to 1.4%; all of the remaining errors were close to a change of speaker.

## What you need

You install the Python software yourself; the app does not bundle it. You
then download two models once, from inside the app or with one command. The
app ships only its own code, which includes alignment code adapted from
WhisperX and TorchAudio.

### Software you install

One command installs all of these: `pip install -r lib/requirements.txt`.
The versions are pinned in that file.

| Component | Version | What it does | Licence |
| --- | --- | --- | --- |
| [Python](https://www.python.org/downloads/) | 3.10 to 3.13 | Runs the speaker labelling helpers | PSF License |
| [PyTorch](https://github.com/pytorch/pytorch) (`torch`) | 2.8.0 | Runs both models | BSD-3-Clause |
| [torchaudio](https://github.com/pytorch/audio) | 2.8.0 | Loads audio; provides the English, French, German, Spanish and Italian alignment models | BSD-2-Clause |
| [torchcodec](https://github.com/pytorch/torchcodec) | 0.7.0 | Audio decoding for pyannote.audio | BSD-3-Clause |
| [pyannote.audio](https://github.com/pyannote/pyannote-audio) | 4.0.7 | Speaker diarisation | MIT |
| [huggingface-hub](https://github.com/huggingface/huggingface_hub) | 0.36.2 | Downloads and caches the speaker model | Apache-2.0 |
| [Transformers](https://github.com/huggingface/transformers) | 4.57.6 | Loads the alignment models for languages other than the five above | Apache-2.0 |

pip also installs the packages these depend on (for example PyTorch
Lightning, NumPy and pyannote's support packages), each under its own
licence. On Windows with an NVIDIA GPU you install the CUDA build of PyTorch
first (step 1). It includes NVIDIA's CUDA runtime libraries, which come under
NVIDIA's own licence terms.

Disk space: about 7 GB for the packages with CUDA builds, measured on
Linux. CPU-only builds are smaller.

### Models you download once

| Model | Size | What it does | Comes from | Licence | Account needed |
| --- | ---: | --- | --- | --- | --- |
| [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1), pinned revision `3533c8cf8e36` | 33 MB | Speaker diarisation | Hugging Face | CC BY 4.0 | Yes: a Hugging Face account that has accepted the model's access conditions, and a Read token |
| wav2vec 2.0 English alignment model (`WAV2VEC2_ASR_BASE_960H`) | 361 MB | Word alignment for English | download.pytorch.org | MIT | No |

The token is used only for the Community-1 download. It is passed to the
download process as an environment variable, is never saved, and is not
needed again.
The Community-1 licence (CC BY 4.0) is separate from pyannote.audio's code
licence (MIT); Hugging Face's access conditions apply to the download itself.

### Other languages

The app prepares the English alignment model. A transcript in another
language is still labelled, but if that language's alignment model has not
been downloaded, the job says so and assigns speakers using Whisper's own
word timing, which is less accurate. To prepare more languages, run:

```
python scripts/setup-diarization.py --alignment en,nl
```

Each language has its own model and licence:

| Languages | Model | Licence |
| --- | --- | --- |
| French, German, Spanish, Italian | VoxPopuli models from torchaudio | **CC BY-NC 4.0: non-commercial use only.** Setup warns before downloading them |
| The other supported languages | Hugging Face models listed in `lib/alignment_models.py` | Check each model's page; this project has not reviewed them all |

### Code that ships with the app

| Component | Licence | Notice |
| --- | --- | --- |
| Alignment path search in `lib/alignment_core.py`, adapted from [WhisperX 3.8.6](https://github.com/m-bain/whisperX) and the [TorchAudio v0.12.1 tutorial](https://github.com/pytorch/audio) | BSD-2-Clause | `lib/third_party/`, [NOTICE](../NOTICE) and the in-app licence list |

WhisperX itself and NLTK's Punkt sentence data are not installed or used.
An older version of this app may have installed them; updating does not
remove them, and the app never deletes packages or data.

For the evidence behind each licence and the questions still open, see
[the licensing review](licensing.md).

## Setup

### 1. Install Python and the packages

Install Python 3.10 to 3.13. On Windows, tick "Add Python to PATH" in the
installer.

Windows with an NVIDIA GPU only: install the CUDA build of PyTorch first,
because the PyPI version is CPU-only on Windows:

```
pip install torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128
```

Then, on every system:

```
pip install -r lib/requirements.txt
```

In an installed copy of the app, `requirements.txt` is in the `resources\lib`
folder of the install directory.

To use a particular interpreter (for example a virtual environment), set
`TRANSCRIBER_PYTHON` to its path. The app uses that Python for checks,
downloads and jobs.

### 2. Get access to the speaker model

1. Sign in to Hugging Face and accept the access conditions at
   [hf.co/pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1).
2. Create a **Read** token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens).

### 3. Download both models

In the app: open Settings, paste the token under **Speaker Labels**, and
click **Download speaker models**. This downloads whichever of the two
models is missing. If only the alignment model is missing, no token is asked
for.

Or from a terminal:

```
HF_TOKEN=hf_... python scripts/setup-diarization.py --alignment
```

After downloading, each model is checked in a fresh offline process. Check
readiness at any time with
`python scripts/setup-diarization.py --check --alignment`.

### 4. Turn on Label speakers

When Settings shows both the speaker model and the word alignment model as
ready, turn on **Label speakers**. Optionally set the number of speakers;
otherwise it is detected. A CUDA GPU is strongly recommended: on a CPU,
labelling takes much longer than transcription.

## Privacy

Only setup uses the network. During a job, the helpers set
`HF_HUB_OFFLINE=1`, turn pyannote's metrics off, load alignment models with
`local_files_only` and block torch hub downloads. A job never downloads a
missing model; audio and text never leave the computer.

## Troubleshooting

| Status in Settings | Fix |
| --- | --- |
| Python 3.10+ not found | Install Python 3.10 to 3.13, or set `TRANSCRIBER_PYTHON` |
| Python 3.x is too old | Install Python 3.10 to 3.13 |
| pyannote not installed / not supported | `pip install -r lib/requirements.txt` |
| Word alignment packages not installed / needs newer packages | `pip install -r lib/requirements.txt` |
| Speaker model not downloaded | Steps 2 and 3 |
| Word alignment model not downloaded | Step 3 (no token needed) |

A setup error such as "refused access" means the access conditions were not
accepted for the account that owns the token.

On Windows without Developer Mode, Hugging Face's cache cannot use symlinks
and stores plain copies instead. This is expected and harmless. Earlier
versions could fail the first download with `WinError 1314`; clicking
Download again completed it.

During a job, "Word alignment failed ..., using Whisper word timings" means
speakers were still labelled, but with less accurate timing. "Speaker
labelling failed ..., using plain transcript" means the job finished without
speaker labels. The debug log (Settings > Debug) has the full error.
