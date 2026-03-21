#!/usr/bin/env python3
"""Test 2: Full diarization pipeline end-to-end.

Runs diarize.py as a subprocess (same way the Electron app does) and
checks that it produces valid output. Requires pyannote.audio + a
valid HF token.

Usage:
    python scripts/test-diarize-pipeline.py --hf-token TOKEN [--audio input.wav]

If no audio file is given, generates a short test WAV.
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


def generate_test_wav(path, duration_s=5, sample_rate=16000):
    """Generate a mono 16kHz PCM-16 WAV with two distinct tones."""
    n_samples = int(duration_s * sample_rate)
    samples = []
    for i in range(n_samples):
        t = i / sample_rate
        if t < duration_s / 2:
            val = int(16000 * math.sin(2 * math.pi * 440 * t))
        else:
            val = int(16000 * math.sin(2 * math.pi * 880 * t))
        samples.append(struct.pack('<h', val))

    with wave.open(path, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b''.join(samples))
    return path


def find_python():
    """Find a working Python 3 command."""
    import shutil
    for cmd in ['python3', 'python', 'py']:
        if shutil.which(cmd):
            return cmd
    return 'python3'


def main():
    parser = argparse.ArgumentParser(description="Test diarize.py end-to-end")
    parser.add_argument("--hf-token", required=True, help="Hugging Face token")
    parser.add_argument("--audio", default=None, help="Path to WAV file (optional)")
    parser.add_argument("--num-speakers", type=int, default=None)
    args = parser.parse_args()

    diarize_script = os.path.join(os.path.dirname(__file__), '..', 'lib', 'diarize.py')
    diarize_script = os.path.abspath(diarize_script)

    if not os.path.isfile(diarize_script):
        print(f"ERROR: diarize.py not found at {diarize_script}")
        sys.exit(1)

    # Prepare audio
    if args.audio:
        wav_path = args.audio
    else:
        wav_path = os.path.join(tempfile.gettempdir(), "test_diarize_pipeline.wav")
        print(f"No audio provided, generating test WAV: {wav_path}")
        generate_test_wav(wav_path)

    output_path = os.path.join(tempfile.gettempdir(), "test_diarize_output.json")

    # Build command — same as Electron does
    python_cmd = find_python()
    cmd = [
        python_cmd, diarize_script,
        '--audio', wav_path,
        '--output', output_path,
        '--hf-token', args.hf_token,
    ]
    if args.num_speakers:
        cmd += ['--num-speakers', str(args.num_speakers)]

    print(f"Running: {python_cmd} lib/diarize.py --audio {wav_path} --output {output_path} --hf-token hf_***")
    print("-" * 60)

    # Run diarize.py, streaming stderr in real time
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    # Print stderr lines as they arrive (progress messages)
    for line in proc.stderr:
        line = line.rstrip()
        # Try to parse as JSON progress
        try:
            obj = json.loads(line)
            if "error" in obj:
                print(f"  ERROR: {obj['error']}")
            elif "message" in obj:
                pct = f" ({obj['percent']}%)" if "percent" in obj else ""
                print(f"  {obj['message']}{pct}")
            else:
                print(f"  [stderr] {line}")
        except json.JSONDecodeError:
            # Non-JSON stderr (warnings etc) — show first line only for brevity
            if "torchcodec" in line.lower():
                print("  [warning] torchcodec not available (expected on Windows)")
            elif line.strip():
                print(f"  [stderr] {line}")

    stdout = proc.stdout.read()
    proc.wait()

    print("-" * 60)
    print(f"Exit code: {proc.returncode}")

    if proc.returncode != 0:
        print("\nFAIL: diarize.py exited with error")
        sys.exit(1)

    # Check stdout
    if stdout.strip():
        try:
            result = json.loads(stdout.strip())
            print(f"Stdout: {result}")
        except json.JSONDecodeError:
            print(f"Stdout (raw): {stdout.strip()}")

    # Check output file
    if os.path.isfile(output_path):
        with open(output_path, 'r') as f:
            segments = json.load(f)
        print(f"\nOutput: {output_path}")
        print(f"Segments: {len(segments)}")
        for seg in segments[:10]:
            print(f"  {seg['start']:8.3f} - {seg['end']:8.3f}  {seg['speaker']}")
        if len(segments) > 10:
            print(f"  ... ({len(segments) - 10} more)")
        print("\nPASS: Diarization completed successfully")
    else:
        print(f"\nFAIL: Output file not created: {output_path}")
        sys.exit(1)


if __name__ == "__main__":
    main()
