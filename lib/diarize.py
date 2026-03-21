#!/usr/bin/env python3
"""Speaker diarization using pyannote.audio.

Spawned as a subprocess by the Electron app. Outputs JSON speaker segments
and prints progress to stderr for the main process to parse.

Usage:
    python diarize.py --audio input.wav --output out.json [--hf-token TOKEN] [--num-speakers N]
"""

import argparse
import json
import sys
import os


def progress(message, percent=None):
    """Print a progress line to stderr in a format Electron can parse."""
    obj = {"message": message}
    if percent is not None:
        obj["percent"] = percent
    print(json.dumps(obj), file=sys.stderr, flush=True)


def main():
    parser = argparse.ArgumentParser(description="Speaker diarization via pyannote.audio")
    parser.add_argument("--audio", required=True, help="Path to input audio file (WAV)")
    parser.add_argument("--output", required=True, help="Path to write output JSON")
    parser.add_argument("--hf-token", default=None, help="Hugging Face auth token")
    parser.add_argument("--num-speakers", type=int, default=None, help="Expected number of speakers (optional)")
    args = parser.parse_args()

    if not os.path.isfile(args.audio):
        print(json.dumps({"error": f"Audio file not found: {args.audio}"}), file=sys.stderr, flush=True)
        sys.exit(1)

    # Import pyannote — fail gracefully if not installed
    progress("Loading pyannote.audio...")
    try:
        from pyannote.audio import Pipeline
    except ImportError:
        print(json.dumps({"error": "pyannote.audio is not installed. Run: pip install pyannote.audio"}), file=sys.stderr, flush=True)
        sys.exit(1)

    # Load the diarization pipeline
    progress("Loading diarization model (may download on first use)...", 10)
    try:
        use_token = args.hf_token or os.environ.get("HF_TOKEN")
        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            token=use_token,
        )
    except Exception as e:
        error_msg = str(e)
        hint = ""
        if "401" in error_msg or "token" in error_msg.lower() or "gated" in error_msg.lower():
            hint = (
                " — Ensure you have (1) a valid HF token with 'read' scope, "
                "(2) accepted licenses at hf.co/pyannote/speaker-diarization-3.1, "
                "hf.co/pyannote/segmentation-3.0, AND "
                "hf.co/pyannote/speaker-diarization-community-1"
            )
        elif "404" in error_msg:
            hint = " — Model not found. Check your network connection and try again."
        print(json.dumps({"error": f"Failed to load model: {error_msg}{hint}"}), file=sys.stderr, flush=True)
        sys.exit(1)

    # Move to GPU if available
    try:
        import torch
        if torch.cuda.is_available():
            pipeline.to(torch.device("cuda"))
            progress("Using GPU (CUDA)", 20)
        else:
            progress("Using CPU (this will be slow)", 20)
    except ImportError:
        progress("Using CPU (this will be slow)", 20)

    # Load audio as waveform using built-in wave module — avoids torchcodec/torchaudio
    # dependencies that don't work on Windows. Input is always 16kHz mono PCM WAV from ffmpeg.
    progress("Loading audio file...", 25)
    try:
        import wave
        import numpy as np
        import torch

        with wave.open(args.audio, "rb") as wf:
            sample_rate = wf.getframerate()
            n_frames = wf.getnframes()
            audio_bytes = wf.readframes(n_frames)
            # Convert PCM 16-bit to float32 tensor in range [-1, 1]
            audio_np = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
            waveform = torch.from_numpy(audio_np).unsqueeze(0)  # shape: (1, n_samples)
    except Exception as e:
        print(json.dumps({"error": f"Failed to load audio: {e}"}), file=sys.stderr, flush=True)
        sys.exit(1)

    # Run diarization
    progress("Running diarization...", 30)
    try:
        diarize_params = {}
        if args.num_speakers is not None:
            diarize_params["num_speakers"] = args.num_speakers

        diarization = pipeline({"waveform": waveform, "sample_rate": sample_rate}, **diarize_params)
    except Exception as e:
        print(json.dumps({"error": f"Diarization failed: {e}"}), file=sys.stderr, flush=True)
        sys.exit(1)

    # Convert to JSON segments
    # pyannote.audio 4.x returns DiarizeOutput with .speaker_diarization;
    # pyannote 3.x returns Annotation directly with .itertracks()
    progress("Processing results...", 90)
    segments = []
    annotation = getattr(diarization, 'speaker_diarization', diarization)
    for turn, _, speaker in annotation.itertracks(yield_label=True):
        segments.append({
            "start": round(turn.start, 3),
            "end": round(turn.end, 3),
            "speaker": speaker,
        })

    # Write output
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(segments, f, indent=2)

    progress("Done", 100)
    print(json.dumps({"segments": len(segments)}), file=sys.stdout, flush=True)


if __name__ == "__main__":
    main()
