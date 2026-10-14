#!/usr/bin/env python3
"""Opt-in smoke test: run lib/diarize.py end to end on real audio.

Runs diarize.py as a subprocess (the way the app does) with the cached
model, offline, and checks the result envelope. Needs pyannote.audio 4.x
installed and the model prepared. Not part of the normal test run.

Usage:
    python scripts/test-diarize-pipeline.py [--audio input.wav] [--num-speakers N]
    HF_TOKEN=hf_... python scripts/test-diarize-pipeline.py --setup

--setup runs scripts/setup-diarization.py first (reads HF_TOKEN from the
environment; downloads the model). Without it nothing is downloaded and no
token is read. --python picks the interpreter (default: TRANSCRIBER_PYTHON,
else this one). If no audio is given, a short two-tone WAV is generated.

To prove inference is offline on Linux, run it without a network:
    unshare -rn python scripts/test-diarize-pipeline.py --audio a.wav
"""

import argparse
import json
import math
import os
import struct
import subprocess
import sys
import tempfile
import wave

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DIARIZE = os.path.join(ROOT, "lib", "diarize.py")
SETUP = os.path.join(ROOT, "scripts", "setup-diarization.py")


def generate_test_wav(path, duration_s=5, sample_rate=16000):
    """Generate a mono 16kHz PCM-16 WAV with two distinct tones."""
    n_samples = int(duration_s * sample_rate)
    samples = []
    for i in range(n_samples):
        t = i / sample_rate
        freq = 440 if t < duration_s / 2 else 880
        samples.append(struct.pack('<h', int(16000 * math.sin(2 * math.pi * freq * t))))
    with wave.open(path, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b''.join(samples))
    return path


def print_stderr_line(line):
    line = line.rstrip()
    if not line:
        return
    try:
        obj = json.loads(line)
    except ValueError:
        print(f"  [stderr] {line}")
        return
    if isinstance(obj, dict) and "error" in obj:
        print(f"  ERROR ({obj.get('code')}): {obj['error']}")
    elif isinstance(obj, dict) and "message" in obj:
        pct = f" ({obj['percent']}%)" if "percent" in obj else ""
        print(f"  {obj['message']}{pct}")
    else:
        print(f"  [stderr] {line}")


def check_segments(name, segments, problems):
    if not isinstance(segments, list):
        problems.append(f"{name} is not a list")
        return
    for i, seg in enumerate(segments):
        if not isinstance(seg, dict) or set(seg) != {"start", "end", "speaker"}:
            problems.append(f"{name}[{i}] has the wrong keys: {seg}")
            continue
        if not (isinstance(seg["start"], (int, float)) and isinstance(seg["end"], (int, float))):
            problems.append(f"{name}[{i}] times are not numbers")
        elif seg["end"] < seg["start"]:
            problems.append(f"{name}[{i}] ends before it starts")
        if not isinstance(seg["speaker"], str):
            problems.append(f"{name}[{i}] speaker is not a string")


def validate_envelope(env, num_speakers):
    """Return a list of problems with the envelope (empty if valid)."""
    problems = []
    expected = {"format", "version", "regular", "exclusive", "exclusiveAvailable", "model",
                "versions", "device", "numSpeakersRequested", "audio", "processingSec"}
    if not isinstance(env, dict):
        return ["output is not a JSON object (legacy bare array?)"]
    missing = expected - set(env)
    if missing:
        problems.append(f"missing keys: {sorted(missing)}")
    if env.get("format") != "transcriber-diarization" or env.get("version") != 1:
        problems.append(f"format/version: {env.get('format')} {env.get('version')}")
    check_segments("regular", env.get("regular"), problems)
    if env.get("exclusiveAvailable") is True:
        check_segments("exclusive", env.get("exclusive"), problems)
    elif env.get("exclusiveAvailable") is False:
        if env.get("exclusive") is not None:
            problems.append("exclusive must be null when exclusiveAvailable is false")
    else:
        problems.append("exclusiveAvailable is not a boolean")
    model = env.get("model") or {}
    if not model.get("id") or not model.get("revision"):
        problems.append(f"model id/revision missing: {model}")
    versions = env.get("versions") or {}
    if set(versions) != {"python", "pyannote.audio", "torch"}:
        problems.append(f"versions keys: {sorted(versions)}")
    if env.get("device") not in ("cuda", "cpu"):
        problems.append(f"device: {env.get('device')}")
    if env.get("numSpeakersRequested") != num_speakers:
        problems.append(f"numSpeakersRequested {env.get('numSpeakersRequested')} != {num_speakers}")
    audio = env.get("audio") or {}
    if audio.get("sampleRate") != 16000 or audio.get("channels") != 1 \
            or not isinstance(audio.get("durationSec"), (int, float)) or audio["durationSec"] <= 0:
        problems.append(f"audio: {audio}")
    if not isinstance(env.get("processingSec"), (int, float)) or env["processingSec"] < 0:
        problems.append(f"processingSec: {env.get('processingSec')}")
    return problems


def run_check(python):
    proc = subprocess.run([python, DIARIZE, "--check"], stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True)
    try:
        return json.loads(proc.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        print(f"FAIL: diarize.py --check gave no JSON (exit {proc.returncode})")
        print(proc.stderr[-1000:])
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Smoke-test diarize.py end to end (offline)")
    parser.add_argument("--audio", default=None, help="Path to a 16 kHz mono 16-bit WAV (optional)")
    parser.add_argument("--num-speakers", type=int, default=None)
    parser.add_argument("--python", default=os.environ.get("TRANSCRIBER_PYTHON") or sys.executable,
                        help="Interpreter with pyannote.audio installed")
    parser.add_argument("--setup", action="store_true",
                        help="Run setup-diarization.py first (uses HF_TOKEN; downloads the model)")
    args = parser.parse_args()

    if args.setup:
        print("Running setup-diarization.py (token read from HF_TOKEN by the helper)...")
        proc = subprocess.run([args.python, SETUP], stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True)
        for line in proc.stderr.splitlines():
            print_stderr_line(line)
        if proc.returncode != 0:
            print("\nFAIL: setup did not complete")
            sys.exit(1)

    status = run_check(args.python)
    print(f"diarize.py --check: {status['status']} (pyannote {status['versions'].get('pyannote.audio')}, "
          f"torch {status['versions'].get('torch')}, CUDA {status.get('cudaAvailable')})")
    if status["status"] != "ready":
        print(f"\nFAIL: not ready: {status.get('message')}")
        sys.exit(1)

    if args.audio:
        wav_path = args.audio
    else:
        wav_path = os.path.join(tempfile.gettempdir(), "test_diarize_pipeline.wav")
        print(f"No audio provided, generating test WAV: {wav_path}")
        generate_test_wav(wav_path)

    output_path = os.path.join(tempfile.gettempdir(), "test_diarize_output.json")
    if os.path.exists(output_path):
        os.remove(output_path)

    cmd = [args.python, DIARIZE, "--audio", wav_path, "--output", output_path]
    if args.num_speakers:
        cmd += ["--num-speakers", str(args.num_speakers)]
    print(f"Running: {' '.join(cmd)}")
    print("-" * 60)

    # No token in the child environment: inference must not need one.
    env = {k: v for k, v in os.environ.items() if k not in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN")}
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    for line in proc.stderr:
        print_stderr_line(line)
    stdout = proc.stdout.read()
    proc.wait()
    print("-" * 60)
    print(f"Exit code: {proc.returncode}")
    if stdout.strip():
        print(f"Stdout: {stdout.strip()}")

    if proc.returncode != 0:
        print("\nFAIL: diarize.py exited with an error")
        sys.exit(1)
    if not os.path.isfile(output_path):
        print(f"\nFAIL: output file not created: {output_path}")
        sys.exit(1)

    with open(output_path, "r", encoding="utf-8") as f:
        envelope = json.load(f)
    problems = validate_envelope(envelope, args.num_speakers)
    if problems:
        print("\nFAIL: envelope problems:")
        for p in problems:
            print(f"  - {p}")
        sys.exit(1)

    print(f"\nOutput: {output_path}")
    print(f"Model: {envelope['model']['id']} @ {envelope['model']['revision'][:12]}, device {envelope['device']}, "
          f"{envelope['processingSec']}s for {envelope['audio']['durationSec']}s of audio")
    print(f"Regular segments: {len(envelope['regular'])}, exclusive: "
          f"{len(envelope['exclusive']) if envelope['exclusive'] is not None else 'not available'}")
    for seg in envelope["regular"][:10]:
        print(f"  {seg['start']:8.3f} - {seg['end']:8.3f}  {seg['speaker']}")
    if len(envelope["regular"]) > 10:
        print(f"  ... ({len(envelope['regular']) - 10} more)")
    print("\nPASS: diarization completed and the envelope is valid")


if __name__ == "__main__":
    main()
