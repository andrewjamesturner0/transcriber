# Speaker Diarization Setup Guide

Speaker diarisation uses [pyannote.audio](https://github.com/pyannote/pyannote-audio)
with the `pyannote/speaker-diarization-community-1` model. It is optional and
needs Python plus large packages. Setup downloads the model once; after that
every job runs offline on this computer and needs no token.

## Requirements

| Requirement | Detail |
| --- | --- |
| Python | 3.10 to 3.13 |
| Packages | `lib/requirements.txt`: pyannote.audio 4.0.7, torch 2.8.0, torchaudio 2.8.0, torchcodec 0.7.0, huggingface-hub 0.36.2 |
| Disk | Several GB with CUDA builds of torch (about 6.7 GB measured on Linux) |
| Model | Community-1, downloaded once by the setup step |
| Hugging Face token | Only for that download, after accepting the model licence |

Optional word alignment adds `lib/requirements-alignment.txt` (WhisperX
3.8.6, about 0.6 GB more) and a 360 MB English model.

## 1. Install Python and packages

Install Python 3.10 or later (on Windows tick "Add Python to PATH"). Then:

```
pip install -r lib/requirements.txt
```

Windows with an NVIDIA GPU: install the CUDA build of torch first:

```
pip install torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128
```

To use a specific interpreter (for example a virtual environment), set
`TRANSCRIBER_PYTHON` to its path. The app uses that Python for checks, setup
and jobs.

## 2. Download the speaker model (once)

1. Accept the licence at
   [hf.co/pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1).
2. Create a **Read** token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens).
3. Either open Settings > Speaker Diarization, paste the token and click
   **Download speaker model**, or run:

```
HF_TOKEN=hf_... python scripts/setup-diarization.py
```

The token is passed only to this download and is not saved. Check
readiness at any time with `python scripts/setup-diarization.py --check`.

## 3. Optional: word alignment

```
pip install -r lib/requirements-alignment.txt
python scripts/setup-diarization.py --alignment          # English
python scripts/setup-diarization.py --alignment en,nl     # more languages
```

Or click **Download alignment model** in Settings. Then switch on **Align
words to the audio** in the Model card (shown while diarisation is on), or
pass `--alignment forced` on the CLI. The fr/de/es/it alignment models are
licensed CC BY-NC 4.0 (non-commercial); setup says so.

## Privacy

Jobs set `HF_HUB_OFFLINE=1`, turn pyannote metrics off and block NLTK and
torch hub downloads, so audio and text never leave the computer. Only the
setup step uses the network.

## Troubleshooting

| Status in Settings | Fix |
| --- | --- |
| Python 3.10+ not found | Install Python, or set `TRANSCRIBER_PYTHON` |
| Python 3.x is too old | Install Python 3.10 or later |
| pyannote not installed / not supported | `pip install -r lib/requirements.txt` |
| Speaker model not downloaded | Step 2 |
| Word alignment not installed | `pip install -r lib/requirements-alignment.txt` |
| Word alignment model not downloaded | Step 3 |

A setup error such as "refused access" means the licence was not accepted
for the account that owns the token. "Diarization failed ..., using plain
transcript" means the job still finished without speaker labels; the debug
log (Settings > Debug) has the full error. CPU diarisation is slow; a CUDA
GPU is strongly recommended.
