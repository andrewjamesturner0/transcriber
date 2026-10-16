#!/usr/bin/env python3
"""PCM contract checks: stdlib/stubs by default; real NumPy/PyTorch with --tensor."""

import argparse
import importlib.util
import os
import struct
import sys
import tempfile
import types
import wave
from unittest import mock

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def load(name):
    path = os.path.join(ROOT, "lib", name + ".py")
    spec = importlib.util.spec_from_file_location("pcm_test_" + name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validation():
    # Even a Python with ML packages installed must not load them for WAV validation.
    with mock.patch.dict(sys.modules, {"numpy": None, "torch": None}):
        pcm, align, diarize = (load(name) for name in ("pcm_audio", "align", "diarize"))
        with tempfile.TemporaryDirectory(prefix="pcm-audio-") as folder:
            def wav(name, frames=19, rate=16000, channels=1, width=2):
                path = os.path.join(folder, name)
                with wave.open(path, "wb") as output:
                    output.setparams((channels, width, rate, 0, "NONE", "not compressed"))
                    output.writeframes(b"\0" * frames * channels * width)
                return path

            path = wav("valid.wav")
            audio = pcm.read_wav(path)
            assert audio == {"sampleRate": 16000, "frames": 19, "channels": 1,
                             "data": b"\0" * 38}, audio
            assert align.read_wav(path) == {
                "sampleRate": 16000, "frames": 19, "durationMs": 1.1875, "data": b"\0" * 38,
            }
            assert diarize.read_wav(path) == dict(audio, durationSec=0.001)
            invalid = wav("invalid.wav", rate=44100, channels=2, width=1)
            empty = wav("empty.wav", frames=0)
            missing = os.path.join(folder, "missing.wav")
            junk = os.path.join(folder, "junk.wav")
            with open(junk, "wb") as output:
                output.write(b"invalid WAV data")
            for bad, expected in (
                (invalid, "Unsupported WAV format: sample rate is 44100 Hz, need 16000; "
                          "2 channels, need mono; 8-bit samples, need 16-bit PCM."),
                (empty, "The WAV file contains no audio."),
                (missing, "Audio file not found: %s" % missing),
                (junk, "Could not read the WAV file (file does not start with RIFF id). "
                       "Expected 16 kHz, mono, 16-bit PCM."),
            ):
                for module, error in ((pcm, pcm.PcmAudioError), (align, align.AlignError),
                                      (diarize, diarize.DiarizeError)):
                    try:
                        module.read_wav(bad)
                        raise AssertionError("invalid WAV accepted")
                    except error as exc:
                        assert str(exc) == expected, str(exc)
                        if module is not pcm:
                            assert exc.code == "audio-invalid", exc.code
    print("PASS: stdlib validation, exact stage errors and duration metadata")


def stub_conversion():
    pcm = load("pcm_audio")
    raw = struct.pack("<5h", -32768, -1, 0, 1, 32767)
    calls = []

    class Samples:
        def astype(self, dtype):
            assert dtype == "float32"
            calls.append("float32")
            return self

        def __truediv__(self, divisor):
            assert divisor == 32768.0
            return [value / divisor for value in struct.unpack("<5h", raw)]

    def frombuffer(data, dtype):
        assert data == raw and dtype == "<i2"
        calls.append("little-endian int16")
        return Samples()

    def from_numpy(samples):
        assert samples == [-1.0, -1 / 32768.0, 0.0, 1 / 32768.0, 32767 / 32768.0]
        return types.SimpleNamespace(unsqueeze=lambda axis: (axis, samples))

    modules = {"numpy": types.SimpleNamespace(frombuffer=frombuffer, float32="float32"),
               "torch": types.SimpleNamespace(from_numpy=from_numpy)}
    with mock.patch.dict(sys.modules, modules):
        axis, samples = pcm.to_waveform(raw)
        assert axis == 0 and len(samples) == 5
    assert calls == ["little-endian int16", "float32"], calls
    print("PASS: stub conversion uses little-endian int16, float32 and mono axis")


def tensor_conversion():
    # Required imports deliberately fail the command if this lane lacks either package.
    import numpy as np
    import torch

    pcm = load("pcm_audio")
    values = [-32768, -16384, -1, 0, 1, 16384, 32767]
    data = bytearray(struct.pack("<7h", *values))
    waveform = pcm.to_waveform(data)
    assert tuple(waveform.shape) == (1, 7), waveform.shape
    assert waveform.dtype == torch.float32, waveform.dtype
    assert waveform.device.type == "cpu", waveform.device
    np.testing.assert_array_equal(waveform.numpy(), np.array([values], dtype=np.float32) / 32768.0)
    data[:] = b"\0" * len(data)
    assert waveform[0, 0].item() == -1.0, "tensor must own a converted copy"
    assert tuple(pcm.to_waveform(b"").shape) == (1, 0)
    try:
        pcm.to_waveform(b"\0")
        raise AssertionError("odd-length PCM accepted")
    except ValueError:
        pass
    print("PASS: real tensor shape, float32, scaling, copy and byte-length checks")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tensor", action="store_true", help="require real NumPy/PyTorch conversion")
    args = parser.parse_args()
    validation()
    if args.tensor:
        tensor_conversion()
    else:
        stub_conversion()


if __name__ == "__main__":
    main()
