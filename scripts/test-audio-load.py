#!/usr/bin/env python3
"""Test 1: WAV audio loading (the step that keeps failing on Windows).

Generates a short test WAV file and verifies it can be loaded as a
waveform tensor using only the built-in wave module + numpy + torch.
No torchaudio or torchcodec required.

Usage:
    python scripts/test-audio-load.py [path-to-wav]

If no WAV path is given, generates a 2-second sine wave test file.
"""

import json
import os
import struct
import sys
import tempfile
import wave


def generate_test_wav(path, duration_s=2, sample_rate=16000):
    """Generate a mono 16kHz PCM-16 WAV with a simple sine wave."""
    import math
    n_samples = int(duration_s * sample_rate)
    samples = []
    for i in range(n_samples):
        t = i / sample_rate
        # Two tones to simulate two "speakers" in different halves
        if t < duration_s / 2:
            val = int(16000 * math.sin(2 * math.pi * 440 * t))  # 440 Hz
        else:
            val = int(16000 * math.sin(2 * math.pi * 880 * t))  # 880 Hz
        samples.append(struct.pack('<h', val))

    with wave.open(path, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b''.join(samples))
    return path


def test_load(wav_path):
    """Load a WAV file the same way diarize.py does."""
    print(f"Loading: {wav_path}")

    import numpy as np
    import torch

    with wave.open(wav_path, 'rb') as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        sample_rate = wf.getframerate()
        n_frames = wf.getnframes()
        audio_bytes = wf.readframes(n_frames)

    print(f"  Channels: {n_channels}, Sample width: {sampwidth}, Rate: {sample_rate}, Frames: {n_frames}")

    audio_np = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    waveform = torch.from_numpy(audio_np).unsqueeze(0)

    print(f"  Tensor shape: {waveform.shape}, dtype: {waveform.dtype}")
    print(f"  Duration: {waveform.shape[1] / sample_rate:.2f}s")
    print(f"  Range: [{waveform.min():.4f}, {waveform.max():.4f}]")

    return {"waveform": waveform, "sample_rate": sample_rate}


def main():
    if len(sys.argv) > 1:
        wav_path = sys.argv[1]
        if not os.path.isfile(wav_path):
            print(f"ERROR: File not found: {wav_path}")
            sys.exit(1)
    else:
        wav_path = os.path.join(tempfile.gettempdir(), "test_diarize_audio.wav")
        print(f"No WAV provided, generating test file: {wav_path}")
        generate_test_wav(wav_path)

    try:
        result = test_load(wav_path)
        print("\nPASS: Audio loaded successfully as waveform tensor")
        print(f"  Ready for pipeline({{\"waveform\": ..., \"sample_rate\": {result['sample_rate']}}})")
    except Exception as e:
        print(f"\nFAIL: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
