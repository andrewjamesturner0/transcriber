"""Shared WAV validation and PCM conversion, with no heavy imports at load time.

Use the standard-library decoder: torchaudio/torchcodec do not decode
reliably on Windows. Inference accepts FFmpeg's 16 kHz mono 16-bit PCM.
"""

import os
import wave

EXPECTED_SAMPLE_RATE = 16000
EXPECTED_CHANNELS = 1
EXPECTED_SAMPLE_WIDTH = 2


class PcmAudioError(Exception):
    """Invalid input audio; callers supply their stage's error code."""


def read_wav(path):
    """Return validated PCM bytes and frame metadata, without rounding time."""
    if not os.path.isfile(path):
        raise PcmAudioError("Audio file not found: %s" % path)
    try:
        with wave.open(path, "rb") as wf:
            channels = wf.getnchannels()
            width = wf.getsampwidth()
            rate = wf.getframerate()
            comptype = wf.getcomptype()
            frames = wf.getnframes()
            data = wf.readframes(frames)
    except (wave.Error, EOFError, OSError) as e:
        raise PcmAudioError(
            "Could not read the WAV file (%s). Expected 16 kHz, mono, 16-bit PCM." % e,
        )

    problems = []
    if rate != EXPECTED_SAMPLE_RATE:
        problems.append("sample rate is %d Hz, need %d" % (rate, EXPECTED_SAMPLE_RATE))
    if channels != EXPECTED_CHANNELS:
        problems.append("%d channels, need mono" % channels)
    if width != EXPECTED_SAMPLE_WIDTH or comptype != "NONE":
        problems.append("%d-bit samples, need 16-bit PCM" % (width * 8))
    if problems:
        raise PcmAudioError("Unsupported WAV format: %s." % "; ".join(problems))
    if frames == 0:
        raise PcmAudioError("The WAV file contains no audio.")

    return {
        "sampleRate": rate,
        "frames": frames,
        "channels": channels,
        "data": data,
    }


def to_waveform(data):
    """Convert little-endian 16-bit PCM bytes to a (1, n) float32 tensor."""
    import numpy as np
    import torch

    samples = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
    return torch.from_numpy(samples).unsqueeze(0)
