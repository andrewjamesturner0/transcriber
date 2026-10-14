#!/usr/bin/env python3
"""Speaker diarization using pyannote.audio 4.x, offline.

Spawned as a subprocess by the Electron app and the CLI. Loads the pinned
pyannote Community-1 pipeline from the local Hugging Face cache (it never
downloads), writes a result envelope to --output, and prints JSON progress
lines to stderr for the caller to parse.

The model must be prepared first with scripts/setup-diarization.py, which
downloads it using the user's Hugging Face token. This script takes no token.

Usage:
    python diarize.py --audio input.wav --output out.json [--num-speakers N]
    python diarize.py --check [--load]

stderr protocol:
    progress: {"message": "...", "percent": 30}
    error:    {"error": "...", "code": "model-not-prepared"} then exit 1

Error codes: python-unsupported, pyannote-missing, pyannote-unsupported,
model-not-prepared, audio-invalid, diarization-failed.

--check prints one JSON object to stdout describing the environment and
always exits 0. It uses no network and loads no audio. With --load it also
loads the pipeline from the cache (slower; used by the setup helper).

This file is imported by scripts/setup-diarization.py and by the contract
tests, so nothing here may import pyannote, torch or huggingface_hub at
module level, and the syntax must stay parseable by old Python versions so
that the version gate can report a clear error.
"""

import argparse
import contextlib
import io
import json
import os
import platform
import re
import sys
import time
import wave

DEFAULT_MODEL = "pyannote/speaker-diarization-community-1"
DEFAULT_REVISION = "3533c8cf8e369892e6b79ff1bf80f7b0286a54ee"

# Files the pinned Community-1 snapshot needs, relative to the repo root.
# The revision is a commit hash, so this list cannot change underneath us:
# config.yaml names $model/segmentation and $model/embedding (pytorch_model.bin
# each) and $model/plda (xvec_transform.npz and plda.npz).
DEFAULT_MODEL_FILES = (
    "config.yaml",
    "segmentation/pytorch_model.bin",
    "embedding/pytorch_model.bin",
    "plda/xvec_transform.npz",
    "plda/plda.npz",
)

MIN_PYTHON = (3, 10)
SUPPORTED_PYANNOTE_MAJOR = 4
EXPECTED_SAMPLE_RATE = 16000
EXPECTED_CHANNELS = 1
EXPECTED_SAMPLE_WIDTH = 2  # bytes, i.e. 16-bit PCM

ENVELOPE_FORMAT = "transcriber-diarization"
ENVELOPE_VERSION = 1

CHECK_STATUSES = (
    "ready",
    "model-not-prepared",
    "pyannote-missing",
    "pyannote-unsupported",
    "python-unsupported",
)

_HERE = os.path.dirname(os.path.abspath(__file__))
REQUIREMENTS_PATH = os.path.join(_HERE, "requirements.txt")
SETUP_COMMAND = "python scripts/setup-diarization.py"


class DiarizeError(Exception):
    """An expected failure with a stable error code for the caller."""

    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

def progress(message, percent=None):
    """Print a progress line to stderr in a format the app can parse."""
    obj = {"message": message}
    if percent is not None:
        obj["percent"] = percent
    print(json.dumps(obj), file=sys.stderr, flush=True)


def emit_error(code, message):
    """Print the single error line to stderr."""
    print(json.dumps({"error": message, "code": code}), file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

def configure_environment(offline=True, environ=None):
    """Turn off telemetry (and, for inference and --check, network access).

    Must run before pyannote, huggingface_hub or torch are imported: both
    pyannote and huggingface_hub read these variables at import time.
    The values are forced rather than defaulted, so an inherited setting can
    never switch telemetry back on. pyannote treats only "true"/"1" as on.
    """
    env = os.environ if environ is None else environ
    env["PYANNOTE_METRICS_ENABLED"] = "false"
    env["HF_HUB_DISABLE_TELEMETRY"] = "1"
    if offline:
        env["HF_HUB_OFFLINE"] = "1"


def current_version_info():
    """Running Python version (a function so tests can replace it)."""
    return sys.version_info


def package_version(dist_name):
    """Installed version of a distribution, or None. Does not import it."""
    try:
        import importlib.metadata as metadata
    except ImportError:
        return None
    try:
        return metadata.version(dist_name)
    except Exception:
        return None


def _version_string(version_info):
    return ".".join(str(part) for part in tuple(version_info)[:3])


def _pip_fix():
    return 'pip install -r "%s"' % REQUIREMENTS_PATH


def python_problem(version_info=None):
    """Return (code, message) if this Python is too old, else None."""
    vi = current_version_info() if version_info is None else version_info
    if tuple(vi)[:2] < MIN_PYTHON:
        return (
            "python-unsupported",
            "Python %s is too old for speaker diarization: Python %d.%d or "
            "newer is needed. Install Python 3.10-3.13, then run: %s"
            % (_version_string(vi), MIN_PYTHON[0], MIN_PYTHON[1], _pip_fix()),
        )
    return None


def _major_version(version):
    head = str(version).split(".")[0]
    digits = ""
    for ch in head:
        if not ch.isdigit():
            break
        digits += ch
    return int(digits) if digits else None


def pyannote_problem(version):
    """Return (code, message) if pyannote.audio is missing or the wrong major
    version, else None. Only 4.x is supported."""
    if not version:
        return (
            "pyannote-missing",
            "pyannote.audio is not installed. Run: %s" % _pip_fix(),
        )
    if _major_version(version) != SUPPORTED_PYANNOTE_MAJOR:
        return (
            "pyannote-unsupported",
            "pyannote.audio %s is not supported: version %d.x is needed. "
            "Run: %s" % (version, SUPPORTED_PYANNOTE_MAJOR, _pip_fix()),
        )
    return None


def not_prepared_message(model, revision, detail=None):
    msg = (
        "The speaker diarization model (%s at revision %s) is not prepared on "
        "this computer. Set HF_TOKEN to a Hugging Face read token and run: %s"
        % (model, (revision or "main")[:12], SETUP_COMMAND)
    )
    if detail:
        msg += " (%s)" % detail
    return msg


# ---------------------------------------------------------------------------
# Model cache
# ---------------------------------------------------------------------------

def _files_from_config(config_path):
    """Weight files named by a cached config.yaml (non-default models only).

    Each "$model/<subfolder>" entry needs that subfolder's weights: the PLDA
    block loads two .npz files, everything else a pytorch_model.bin. Entries
    that point at other repositories (as the legacy 3.1 config does) are not
    checked here; the real load still reports them as model-not-prepared.
    """
    try:
        import yaml
        with open(config_path, "r", encoding="utf-8") as fp:
            config = yaml.safe_load(fp)
    except Exception:
        return ()

    needed = []

    def visit(node, key=None):
        if isinstance(node, dict):
            for k, v in node.items():
                visit(v, k)
        elif isinstance(node, list):
            for v in node:
                visit(v, key)
        elif isinstance(node, str) and node.startswith("$model/"):
            sub = node[len("$model/"):].split("@")[0].strip("/")
            if key == "plda" or sub.split("/")[-1] == "plda":
                needed.append(sub + "/xvec_transform.npz")
                needed.append(sub + "/plda.npz")
            else:
                needed.append(sub + "/pytorch_model.bin")

    visit(config)
    return tuple(needed)


def model_cache_status(model, revision):
    """Return (ready, snapshot_path, detail) for the local model cache.

    Uses huggingface_hub.try_to_load_from_cache, which only looks in the
    cache folder: no network and no weights loaded. This is much cheaper
    than an offline Pipeline.from_pretrained (which imports the whole of
    pyannote and builds three models), so it suits the startup probe. A
    full load check is available with --check --load.
    """
    try:
        from huggingface_hub import try_to_load_from_cache
    except Exception:
        return False, None, "huggingface_hub is not installed"

    def cached(filename):
        try:
            found = try_to_load_from_cache(model, filename, revision=revision)
        except Exception:
            return None
        return found if isinstance(found, str) else None

    config_path = cached("config.yaml")
    if not config_path:
        return False, None, "config.yaml is not in the cache"

    if model == DEFAULT_MODEL and revision == DEFAULT_REVISION:
        needed = DEFAULT_MODEL_FILES
    else:
        needed = _files_from_config(config_path)
    missing = [name for name in needed if name != "config.yaml" and not cached(name)]
    if missing:
        return False, None, "missing from the cache: " + ", ".join(missing)
    return True, os.path.dirname(config_path), None


def _is_cache_miss(exc):
    """True if exc (or anything it wraps) means the files are not cached.

    Matched by class name so this works without importing huggingface_hub.
    In offline mode hf_hub_download raises LocalEntryNotFoundError for a
    missing file; OfflineModeIsEnabled covers direct network attempts.
    """
    names = ("LocalEntryNotFoundError", "OfflineModeIsEnabled")
    seen = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        for klass in type(exc).__mro__:
            if klass.__name__ in names:
                return True
        exc = exc.__cause__ or exc.__context__
    return False


def load_pipeline(model, revision):
    """Load the pipeline from the local cache only. Never downloads.

    configure_environment(offline=True) must have run first, so that
    huggingface_hub is in offline mode when pyannote imports it.
    """
    try:
        from pyannote.audio import Pipeline
    except Exception as e:
        raise DiarizeError(
            "pyannote-missing",
            "pyannote.audio could not be imported (%s). Run: %s" % (e, _pip_fix()),
        )
    # pyannote prints a "Could not download ... pass a token" hint to stdout
    # on any hub error, including an offline cache miss. That hint is wrong
    # here (inference takes no token), so capture it and only pass it on to
    # stderr for unexpected failures.
    captured = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured):
            pipeline = Pipeline.from_pretrained(model, revision=revision)
    except Exception as e:
        if _is_cache_miss(e):
            raise DiarizeError("model-not-prepared", not_prepared_message(model, revision))
        if captured.getvalue().strip():
            print(captured.getvalue().strip(), file=sys.stderr, flush=True)
        raise DiarizeError(
            "diarization-failed",
            "Could not load the diarization model: %s. If the cached files are "
            "damaged, run %s again." % (e, SETUP_COMMAND),
        )
    if pipeline is None:
        raise DiarizeError("model-not-prepared", not_prepared_message(model, revision))
    return pipeline


# ---------------------------------------------------------------------------
# --check
# ---------------------------------------------------------------------------

def check_environment(model=DEFAULT_MODEL, revision=DEFAULT_REVISION, load=False,
                      version_info=None):
    """Describe the diarization environment as a dict (the --check output).

    Versions come from package metadata, so pyannote is not imported unless
    load=True. torch is imported to ask about CUDA.
    """
    vi = current_version_info() if version_info is None else version_info
    pyannote_version = package_version("pyannote.audio")

    torch_version = None
    cuda_available = False
    try:
        import torch
        torch_version = str(getattr(torch, "__version__", "")) or package_version("torch")
        cuda_available = bool(torch.cuda.is_available())
    except Exception:
        torch_version = None

    py_problem = python_problem(vi)
    pa_problem = pyannote_problem(pyannote_version)
    model_ready, model_path, detail = model_cache_status(model, revision)

    problem = py_problem or pa_problem
    if problem:
        status, message = problem
    elif not model_ready:
        status, message = "model-not-prepared", not_prepared_message(model, revision, detail)
    else:
        status, message = "ready", "Speaker diarization is ready."
        if load:
            try:
                load_pipeline(model, revision)
            except DiarizeError as e:
                status, message = "model-not-prepared", e.message
                model_ready = False

    return {
        "status": status,
        "message": message,
        "versions": {
            "python": _version_string(vi),
            "pyannote.audio": pyannote_version,
            "torch": torch_version,
        },
        "pythonSupported": py_problem is None,
        "pyannoteSupported": pyannote_version is not None and pa_problem is None,
        "cudaAvailable": cuda_available,
        "model": {"id": model, "revision": revision},
        "modelReady": bool(model_ready),
        "modelPath": model_path if model_ready else None,
        "loadChecked": bool(load and status == "ready"),
        "requirements": REQUIREMENTS_PATH,
        "executable": sys.executable,
    }


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------

def read_wav(path):
    """Read and validate a 16 kHz, mono, 16-bit PCM WAV (what FFmpeg writes).

    Uses the built-in wave module rather than torchaudio/torchcodec, which
    do not decode reliably on Windows. Returns the raw PCM bytes.
    """
    if not os.path.isfile(path):
        raise DiarizeError("audio-invalid", "Audio file not found: %s" % path)
    try:
        with wave.open(path, "rb") as wf:
            channels = wf.getnchannels()
            width = wf.getsampwidth()
            rate = wf.getframerate()
            comptype = wf.getcomptype()
            frames = wf.getnframes()
            data = wf.readframes(frames)
    except (wave.Error, EOFError, OSError) as e:
        raise DiarizeError(
            "audio-invalid",
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
        raise DiarizeError("audio-invalid", "Unsupported WAV format: %s." % "; ".join(problems))
    if frames == 0:
        raise DiarizeError("audio-invalid", "The WAV file contains no audio.")

    return {
        "sampleRate": rate,
        "channels": channels,
        "frames": frames,
        "durationSec": round(frames / float(rate), 3),
        "data": data,
    }


def to_waveform(data):
    """Convert little-endian 16-bit PCM bytes to a (1, n) float32 tensor."""
    import numpy as np
    import torch

    samples = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
    return torch.from_numpy(samples).unsqueeze(0)


# ---------------------------------------------------------------------------
# Inference
# ---------------------------------------------------------------------------

def import_pyannote():
    """Import pyannote.audio and enforce the 4.x gate. Returns its version."""
    try:
        import pyannote.audio as pyannote_audio
    except Exception as e:
        code, message = pyannote_problem(None)
        raise DiarizeError(code, "%s (import failed: %s)" % (message, e))
    version = getattr(pyannote_audio, "__version__", None) or package_version("pyannote.audio")
    problem = pyannote_problem(version)
    if problem:
        raise DiarizeError(*problem)
    return str(version)


def select_device(pipeline):
    """Move the pipeline to CUDA when available. Returns "cuda" or "cpu"."""
    try:
        import torch
        if torch.cuda.is_available():
            pipeline.to(torch.device("cuda"))
            progress("Using GPU (CUDA)", 20)
            return "cuda"
    except Exception as e:
        progress("Could not use the GPU (%s), using CPU" % e, 20)
        return "cpu"
    progress("Using CPU (this will be slow)", 20)
    return "cpu"


def annotation_to_segments(annotation):
    segments = []
    for turn, _, speaker in annotation.itertracks(yield_label=True):
        segments.append({
            "start": round(float(turn.start), 3),
            "end": round(float(turn.end), 3),
            "speaker": str(speaker),
        })
    return segments


def build_envelope(output, model, revision, versions, device, num_speakers,
                   audio, processing_sec):
    """Build the result envelope from a pyannote pipeline output.

    pyannote 4.x returns DiarizeOutput with speaker_diarization and
    exclusive_speaker_diarization. If the exclusive timeline is absent,
    "exclusive" is null: it is never filled from the regular one.
    """
    regular = getattr(output, "speaker_diarization", None)
    if regular is None and hasattr(output, "itertracks"):
        regular = output
    if regular is None:
        raise DiarizeError("diarization-failed", "The pipeline returned no speaker timeline.")
    exclusive = getattr(output, "exclusive_speaker_diarization", None)

    return {
        "format": ENVELOPE_FORMAT,
        "version": ENVELOPE_VERSION,
        "regular": annotation_to_segments(regular),
        "exclusive": annotation_to_segments(exclusive) if exclusive is not None else None,
        "exclusiveAvailable": exclusive is not None,
        "model": {"id": model, "revision": revision},
        "versions": versions,
        "device": device,
        "numSpeakersRequested": num_speakers,
        "audio": {
            "sampleRate": audio["sampleRate"],
            "channels": audio["channels"],
            "durationSec": audio["durationSec"],
        },
        "processingSec": processing_sec,
    }


def run(args):
    """Run diarization for parsed args and return the envelope dict.

    Raises DiarizeError for every expected failure.
    """
    configure_environment(offline=True)

    problem = python_problem()
    if problem:
        raise DiarizeError(*problem)

    audio = read_wav(args.audio)

    progress("Loading pyannote.audio...", 5)
    pyannote_version = import_pyannote()

    progress("Loading diarization model from the local cache...", 10)
    pipeline = load_pipeline(args.model, args.revision)

    device = select_device(pipeline)

    progress("Loading audio file...", 25)
    try:
        waveform = to_waveform(audio["data"])
    except Exception as e:
        raise DiarizeError("audio-invalid", "Failed to load audio: %s" % e)

    params = {}
    if args.num_speakers is not None:
        params["num_speakers"] = args.num_speakers

    progress("Running diarization...", 30)
    # processingSec times the pipeline call only (not imports or model load),
    # so it can be compared with the audio duration.
    started = time.time()
    try:
        output = pipeline({"waveform": waveform, "sample_rate": audio["sampleRate"]}, **params)
    except Exception as e:
        raise DiarizeError("diarization-failed", "Diarization failed: %s" % e)
    processing_sec = round(time.time() - started, 3)

    progress("Processing results...", 90)
    import torch
    versions = {
        "python": platform.python_version(),
        "pyannote.audio": pyannote_version,
        "torch": str(getattr(torch, "__version__", "")) or None,
    }
    return build_envelope(output, args.model, args.revision, versions, device,
                          args.num_speakers, audio, processing_sec)


def write_envelope(path, envelope):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(envelope, f, indent=2)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

class _ScrubbingParser(argparse.ArgumentParser):
    """argparse echoes unrecognised arguments; never echo a token."""

    def error(self, message):
        argparse.ArgumentParser.error(self, re.sub(r"hf_\S+", "hf_***", message))


def build_parser():
    parser = _ScrubbingParser(description="Speaker diarization via pyannote.audio (offline)")
    parser.add_argument("--audio", help="Path to input WAV (16 kHz, mono, 16-bit PCM)")
    parser.add_argument("--output", help="Path to write the result envelope JSON")
    parser.add_argument("--num-speakers", type=int, default=None,
                        help="Expected number of speakers (optional)")
    parser.add_argument("--check", action="store_true",
                        help="Print environment and model readiness as JSON, then exit")
    parser.add_argument("--load", action="store_true",
                        help="With --check, also load the pipeline from the cache")
    parser.add_argument("--model", default=DEFAULT_MODEL,
                        help="Pipeline repository id (for evaluation only)")
    parser.add_argument("--revision", default=DEFAULT_REVISION,
                        help="Pipeline revision (for evaluation only)")
    # Accepted for compatibility with older callers and ignored: inference
    # runs offline and never uses a token.
    parser.add_argument("--hf-token", default=None, help=argparse.SUPPRESS)
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    args.hf_token = None  # ignored; see build_parser

    if args.check:
        configure_environment(offline=True)
        result = check_environment(args.model, args.revision, load=args.load)
        print(json.dumps(result), flush=True)
        return 0

    if not args.audio or not args.output:
        parser.error("--audio and --output are required unless --check is given")

    try:
        envelope = run(args)
        write_envelope(args.output, envelope)
    except DiarizeError as e:
        emit_error(e.code, e.message)
        return 1
    except Exception as e:
        emit_error("diarization-failed", "Unexpected error: %s" % e)
        return 1

    progress("Done", 100)
    print(json.dumps({
        "segments": len(envelope["regular"]),
        "exclusiveSegments": len(envelope["exclusive"]) if envelope["exclusive"] is not None else None,
    }), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
