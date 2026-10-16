#!/usr/bin/env python3
"""Forced word alignment with a local wav2vec2 aligner, offline.

Spawned as a subprocess by the Electron app and the CLI after Whisper has
run. Re-times the words Whisper recognised against the audio with a wav2vec2
model loaded from the local cache (it never downloads), writes a result
envelope to --output, and prints JSON progress lines to stderr.

The model registry and loaders are in alignment_models.py and the path
search in alignment_core.py, both beside this file. No speech recogniser is
loaded and the recognised text is never changed. The output holds times,
scores and quality labels only, never text.

The alignment model must be prepared first with
scripts/setup-diarization.py --alignment.

Usage:
    python align.py --audio input.wav --input words.json --output out.json [--device auto|cpu|cuda]
    python align.py --check [--language en]

Input (written by lib/transcript-timing.js buildAlignmentInput):
    {"language": "en", "padMs": 200,
     "segments": [{"index": 0, "startMs": 0, "endMs": 10860, "words": ["Hello,", "and"]}]}

Output:
    {"format": "transcriber-alignment", "version": 1,
     "provider": {"name": "transcriber-align", "version", "model", "language"},
     "device", "processingSec",
     "segments": [{"index", "status": "aligned"|"failed", "reason",
                   "words": [{"startMs", "endMs", "score", "quality"}]}]}
    Each segment's words list has exactly as many entries as the input
    segment. quality is "measured" (has a score), "interpolated" (times
    but no score: none of the word's characters is known to the model, as
    with digits) or "unaligned" (no times; startMs, endMs and score are
    null). Failed segment reasons: empty-segment, outside-audio,
    no-characters, too-short, too-long, no-path, invalid-emissions,
    align-error.

stderr protocol:
    progress: {"message": "...", "percent": 30}
    error:    {"error": "...", "code": "model-not-prepared"} then exit 1

Error codes: python-unsupported, alignment-missing, alignment-unsupported,
language-unsupported, model-not-prepared, audio-invalid, alignment-failed.

--check prints one JSON object to stdout describing the environment and
always exits 0. It uses no network, loads no audio and no model.

This file is imported by scripts/setup-diarization.py and by the contract
tests, so nothing here may import torch, torchaudio, transformers or
huggingface_hub at module level, and the syntax must stay parseable by old
Python versions so that the version gate can report a clear error.
"""

import argparse
import contextlib
import importlib.util
import io
import json
import math
import os
import re
import sys
import time
import tempfile

MIN_PYTHON = (3, 10)

ENVELOPE_FORMAT = "transcriber-alignment"
ENVELOPE_VERSION = 1
# The provider names this aligner and its timing/quality rules. Bump the
# version when the numbers or labels it produces can change.
PROVIDER_NAME = "transcriber-align"
PROVIDER_VERSION = "1.0"
DEFAULT_LANGUAGE = "en"
DEFAULT_PAD_MS = 200

CHECK_STATUSES = (
    "ready",
    "model-not-prepared",
    "alignment-missing",
    "alignment-unsupported",
    "language-unsupported",
    "python-unsupported",
)

_HERE = os.path.dirname(os.path.abspath(__file__))
REQUIREMENTS_PATH = os.path.join(_HERE, "requirements.txt")
SETUP_COMMAND = "python scripts/setup-diarization.py --alignment"


class AlignError(Exception):
    """An expected failure with a stable error code for the caller."""

    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# Sibling modules
# ---------------------------------------------------------------------------

def _sibling(name):
    """Import a Python sibling from this file's folder.

    By path, so it works whatever the working directory or sys.path, when
    this file is itself loaded with spec_from_file_location (the setup
    script) and in the installed resources/lib folder.
    """
    key = "transcriber_" + name
    module = sys.modules.get(key)
    if module is None:
        path = os.path.join(_HERE, name + ".py")
        spec = importlib.util.spec_from_file_location(key, path)
        if spec is None or not os.path.isfile(path):
            raise AlignError("alignment-missing",
                             "Word alignment is incomplete: %s is missing." % path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[key] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            del sys.modules[key]
            raise
    return module


def models():
    return _sibling("alignment_models")


def core():
    return _sibling("alignment_core")


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
# Environment and version gates
# ---------------------------------------------------------------------------

def configure_environment(offline=True, environ=None):
    """Turn off telemetry (and, for inference and --check, network access).

    Must run before huggingface_hub or transformers is imported: they read
    these variables at import time. Values are forced, not defaulted, so an
    inherited setting cannot switch them back.
    """
    env = os.environ if environ is None else environ
    env["HF_HUB_DISABLE_TELEMETRY"] = "1"
    if offline:
        env["HF_HUB_OFFLINE"] = "1"
        env["TRANSFORMERS_OFFLINE"] = "1"


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
            "Python %s is too old for word alignment: Python %d.%d or newer is "
            "needed. Install Python 3.10-3.13, then run: %s"
            % (_version_string(vi), MIN_PYTHON[0], MIN_PYTHON[1], _pip_fix()),
        )
    return None


def dependency_problem(model):
    """Return (code, message) if a package the model's backend needs is
    missing or too old, else None. Uses package metadata only."""
    return models().dependency_problem(model, _pip_fix(), package_version)


def not_prepared_message(language, model, detail=None):
    msg = (
        "The word alignment model for language '%s' (%s) is not prepared on "
        "this computer. Run: %s %s"
        % (language, model or "unknown", SETUP_COMMAND, language)
    )
    if detail:
        msg += " (%s)" % detail
    return msg


def provider_info():
    return {"name": PROVIDER_NAME, "version": PROVIDER_VERSION}


def backend_versions(version_info=None):
    """Versions for --check and setup. whisperx and nltk are deprecated keys,
    always null: they are no longer used and never decide readiness."""
    vi = current_version_info() if version_info is None else version_info
    return {
        "python": _version_string(vi),
        "torch": package_version("torch"),
        "torchaudio": package_version("torchaudio"),
        "transformers": package_version("transformers"),
        "whisperx": None,
        "nltk": None,
    }


# ---------------------------------------------------------------------------
# Languages and models (lib/alignment_models.py owns the registry)
# ---------------------------------------------------------------------------

def normalise_language(language):
    if not isinstance(language, str):
        return None
    language = language.strip().lower()
    return language or None


def resolve_model(language):
    """Model spec {"language", "name", "backend", "noSpaces", "licence"},
    or None if the language has no alignment model."""
    return models().resolve(language) if language else None


def unsupported_language_message(language):
    return (
        "Word alignment has no model for language '%s'. Supported languages: %s."
        % (language, ", ".join(models().languages()))
    )


def model_status(model):
    """Return (ready, path, detail) for a model's cached weights."""
    return models().cache_status(model)


# ---------------------------------------------------------------------------
# --check
# ---------------------------------------------------------------------------

def check_environment(language=DEFAULT_LANGUAGE, version_info=None):
    """Describe the alignment environment as a dict (the --check output).

    torch is imported to ask about CUDA, and torchaudio to locate an English
    or VoxPopuli checkpoint; no model is loaded.
    """
    vi = current_version_info() if version_info is None else version_info
    language = normalise_language(language) or DEFAULT_LANGUAGE
    versions = backend_versions(vi)

    cuda_available = False
    if versions["torch"]:
        try:
            import torch
            versions["torch"] = str(getattr(torch, "__version__", "")) or versions["torch"]
            cuda_available = bool(torch.cuda.is_available())
        except Exception:
            pass

    py_problem = python_problem(vi)
    model = resolve_model(language)
    # An unknown language still reports missing packages for the default
    # (torchaudio) backend first, as before.
    dep_problem = dependency_problem(model or {"language": language, "backend": "torchaudio"})
    ready = path = detail = None
    if model and not py_problem and not dep_problem:
        ready, path, detail = model_status(model)

    if py_problem or dep_problem:
        status, message = py_problem or dep_problem
    elif model is None:
        status, message = "language-unsupported", unsupported_language_message(language)
    elif not ready:
        status = "model-not-prepared"
        message = not_prepared_message(language, model["name"], detail)
    else:
        status, message = "ready", "Word alignment is ready for language '%s'." % language

    return {
        "status": status,
        "message": message,
        "language": language,
        "provider": provider_info(),
        "versions": versions,
        "pythonSupported": py_problem is None,
        "alignmentSupported": dep_problem is None,
        "languageSupported": model is not None,
        "cudaAvailable": cuda_available,
        "model": {"name": model["name"], "type": model["backend"]} if model else None,
        "modelReady": bool(ready),
        "modelPath": path if ready else None,
        # Deprecated: Punkt is no longer used. Always null.
        "punktReady": None,
        "punktPath": None,
        "requirements": REQUIREMENTS_PATH,
        "executable": sys.executable,
    }


# ---------------------------------------------------------------------------
# Input and audio
# ---------------------------------------------------------------------------

def _is_time(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and value >= 0)


def read_input(path):
    """Read and validate the --input JSON. Returns a normalised dict."""
    def bad(detail):
        return AlignError("alignment-failed", "Malformed alignment input: %s." % detail)

    try:
        with open(path, "r", encoding="utf-8") as fp:
            data = json.load(fp)
    except (OSError, ValueError) as e:
        raise AlignError("alignment-failed", "Could not read the alignment input (%s)." % e)
    if not isinstance(data, dict):
        raise bad("not a JSON object")
    pad = data.get("padMs", DEFAULT_PAD_MS)
    if pad is None:
        pad = DEFAULT_PAD_MS
    if not _is_time(pad):
        raise bad("padMs must be a number of milliseconds")
    segments = data.get("segments")
    if not isinstance(segments, list):
        raise bad("segments must be a list")
    seen = set()
    out = []
    for n, seg in enumerate(segments):
        if not isinstance(seg, dict):
            raise bad("segment %d is not an object" % n)
        index = seg.get("index")
        if not isinstance(index, int) or isinstance(index, bool) or index in seen:
            raise bad("segment %d needs a unique integer index" % n)
        seen.add(index)
        start, end = seg.get("startMs"), seg.get("endMs")
        if not _is_time(start) or not _is_time(end) or end < start:
            raise bad("segment %d has invalid startMs/endMs" % n)
        words = seg.get("words")
        if not isinstance(words, list) or not all(isinstance(w, str) for w in words):
            raise bad("segment %d words must be a list of strings" % n)
        out.append({"index": index, "startMs": start, "endMs": end, "words": words})
    return {"language": normalise_language(data.get("language")), "padMs": pad, "segments": out}


def read_wav(path):
    """Validate shared PCM input and retain this stage's duration metadata."""
    pcm = _sibling("pcm_audio")
    try:
        audio = pcm.read_wav(path)
    except pcm.PcmAudioError as e:
        raise AlignError("audio-invalid", str(e))
    return {
        "sampleRate": audio["sampleRate"],
        "frames": audio["frames"],
        "durationMs": audio["frames"] * 1000.0 / audio["sampleRate"],
        "data": audio["data"],
    }


def to_waveform(data):
    """Convert PCM bytes lazily, after offline environment setup."""
    return _sibling("pcm_audio").to_waveform(data)


def segment_window(segment, pad_ms, duration_ms):
    """[start, end] in ms: the segment span padded, clamped to the audio.

    Returns None when the window starts at or after the end of the audio.
    """
    start = max(0.0, segment["startMs"] - pad_ms)
    end = min(float(duration_ms), segment["endMs"] + pad_ms)
    if start >= duration_ms or end <= start:
        return None
    return start, end


# ---------------------------------------------------------------------------
# Inference
# ---------------------------------------------------------------------------

def _is_out_of_memory(exc):
    return "OutOfMemory" in type(exc).__name__ or "out of memory" in str(exc).lower()


def select_device(requested):
    """Return "cuda" or "cpu" for --device auto|cpu|cuda."""
    if requested == "cpu":
        progress("Using CPU", 15)
        return "cpu"
    try:
        import torch
        available = bool(torch.cuda.is_available())
    except Exception:
        available = False
    if available:
        progress("Using GPU (CUDA)", 15)
        return "cuda"
    if requested == "cuda":
        progress("CUDA is not available, using CPU", 15)
    else:
        progress("Using CPU", 15)
    return "cpu"


def load_model(model, device):
    """Load the alignment model from the local cache only. Never downloads.

    Returns (loaded model, device). The weights are read on the CPU first,
    so a missing or damaged cache is reported as model-not-prepared and
    never confused with a GPU problem; if moving to the GPU fails, the CPU
    is used.
    """
    m = models()
    language = model["language"]

    def not_prepared(detail):
        return not_prepared_message(language, model["name"], detail)

    captured = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured):
            loaded = m.load(model, _pip_fix(), not_prepared)
    except m.ModelError as e:
        raise AlignError(e.code, e.message)
    except Exception as e:
        raise AlignError("alignment-failed", "Could not load the alignment model: %s" % e)
    if device != "cpu":
        try:
            loaded.to(device)
        except m.DeviceError as e:
            progress("Could not load the alignment model on the GPU (%s), using CPU" % e, 20)
            device = "cpu"
    return loaded, device


def align_segments(loaded, model, segments, pad_ms, audio, waveform, not_prepared=None):
    """Align each input segment separately. Returns the output segment list.
    Raises AlignError for whole-step failures.

    Each segment is cropped from the shared waveform, run through the model
    once and aligned on its own, so every returned time belongs to its own
    segment and window.
    """
    m, c = models(), core()
    results = []
    attempted = errors = 0
    first_error = None
    total = len(segments)
    last_percent = None
    for n, seg in enumerate(segments):
        words = seg["words"]
        record = {"index": seg["index"], "status": "failed", "reason": None,
                  "words": [dict(c.UNALIGNED) for _ in words]}
        results.append(record)

        window = segment_window(seg, pad_ms, audio["durationMs"])
        if not words:
            record["reason"] = "empty-segment"
        elif window is None:
            record["reason"] = "outside-audio"
        else:
            start, end = c.crop_samples(window[0], window[1], audio["frames"])
            problem = c.crop_problem(start, end)
            if problem:
                record["reason"] = problem
            else:
                attempted += 1
                try:
                    emission = loaded.emissions(waveform[:, start:end])
                    result = c.align_segment(emission, words, loaded.dictionary, loaded.blank_id,
                                             model["noSpaces"], start, end)
                except Exception as e:
                    if m.is_cache_miss(e):
                        raise AlignError("model-not-prepared", not_prepared or str(e))
                    if _is_out_of_memory(e):
                        raise AlignError("alignment-failed", "Word alignment ran out of memory: %s" % e)
                    errors += 1
                    first_error = first_error or e
                    record["reason"] = "align-error"
                else:
                    record.update(result)

        percent = 25 + int(70 * (n + 1) / total)
        if last_percent is None or percent - last_percent >= 5 or n + 1 == total:
            progress("Matching words to the audio (%d of %d segments)..." % (n + 1, total), percent)
            last_percent = percent

    if attempted and errors == attempted:
        raise AlignError("alignment-failed",
                         "Word alignment failed for every segment: %s: %s"
                         % (type(first_error).__name__, first_error))
    return results


def build_envelope(model_name, language, device, processing_sec, segments):
    provider = provider_info()
    provider.update({"model": model_name, "language": language})
    return {
        "format": ENVELOPE_FORMAT,
        "version": ENVELOPE_VERSION,
        "provider": provider,
        "device": device,
        "processingSec": processing_sec,
        "segments": segments,
    }


def run(args):
    """Run alignment for parsed args and return the envelope dict.

    Raises AlignError for every expected failure.
    """
    configure_environment(offline=True)

    problem = python_problem()
    if problem:
        raise AlignError(*problem)

    request = read_input(args.input)
    audio = read_wav(args.audio)

    progress("Loading word alignment...", 5)
    language = request["language"]
    model = resolve_model(language)
    if model is None:
        if not language:
            raise AlignError("language-unsupported", "No language was given for word alignment.")
        raise AlignError("language-unsupported", unsupported_language_message(language))
    problem = dependency_problem(model)
    if problem:
        raise AlignError(*problem)

    ready, _, detail = model_status(model)
    if not ready:
        raise AlignError("model-not-prepared", not_prepared_message(language, model["name"], detail))

    device = select_device(getattr(args, "device", "auto") or "auto")
    segments = request["segments"]
    if not segments:
        progress("Nothing to align", 90)
        return build_envelope(model["name"], language, device, 0.0, [])

    progress("Loading the alignment model from the local cache...", 20)
    loaded, device = load_model(model, device)

    try:
        waveform = to_waveform(audio["data"])
    except Exception as e:
        raise AlignError("audio-invalid", "Failed to load audio: %s" % e)

    progress("Matching words to the audio...", 25)
    # processingSec times the alignment loop only (not imports or model
    # load), so it can be compared with the audio duration.
    started = time.time()
    try:
        results = align_segments(loaded, model, segments, request["padMs"], audio, waveform,
                                 not_prepared_message(language, model["name"],
                                                      "a download was needed during alignment"))
    except AlignError:
        raise
    except Exception as e:
        raise AlignError("alignment-failed", "Word alignment failed: %s" % e)
    processing_sec = round(time.time() - started, 3)

    return build_envelope(model["name"], language, device, processing_sec, results)


def fetch_model(language):
    """Setup only (network allowed): download the language's model into the
    standard cache, or just read it if it is already there."""
    model = resolve_model(normalise_language(language))
    if model is None:
        raise AlignError("language-unsupported", unsupported_language_message(language))
    models().fetch(model)


def write_envelope(path, envelope):
    """Publish JSON from a private file, including when replacing an old file."""
    parent = os.path.dirname(os.path.abspath(path))
    fd, temporary = tempfile.mkstemp(prefix=".transcriber-result-", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(envelope, f, indent=2)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def summarise(envelope):
    counts = {"measured": 0, "interpolated": 0, "unaligned": 0}
    words = failed = 0
    for seg in envelope["segments"]:
        if seg["status"] != "aligned":
            failed += 1
        for w in seg["words"]:
            words += 1
            counts[w["quality"]] += 1
    summary = {"segments": len(envelope["segments"]), "failedSegments": failed, "words": words}
    summary.update(counts)
    return summary


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

class _ScrubbingParser(argparse.ArgumentParser):
    """argparse echoes unrecognised arguments; never echo a token."""

    def error(self, message):
        argparse.ArgumentParser.error(self, re.sub(r"hf_\S+", "hf_***", message))


def build_parser():
    parser = _ScrubbingParser(description="Forced word alignment with a local wav2vec2 model (offline)")
    parser.add_argument("--audio", help="Path to input WAV (16 kHz, mono, 16-bit PCM)")
    parser.add_argument("--input", help="Path to the words JSON to align")
    parser.add_argument("--output", help="Path to write the result envelope JSON")
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto",
                        help="Where to run the model (default: CUDA when available)")
    parser.add_argument("--check", action="store_true",
                        help="Print environment and model readiness as JSON, then exit")
    parser.add_argument("--language", default=DEFAULT_LANGUAGE,
                        help="With --check, the language to check (default: en)")
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.check:
        configure_environment(offline=True)
        try:
            result = check_environment(args.language)
        except AlignError as e:
            # For example a sibling module missing from an installation.
            result = {"status": e.code, "message": e.message, "provider": provider_info()}
        print(json.dumps(result), flush=True)
        return 0

    if not args.audio or not args.input or not args.output:
        parser.error("--audio, --input and --output are required unless --check is given")

    try:
        envelope = run(args)
        write_envelope(args.output, envelope)
    except AlignError as e:
        emit_error(e.code, e.message)
        return 1
    except Exception as e:
        emit_error("alignment-failed", "Unexpected error: %s" % e)
        return 1

    progress("Done", 100)
    print(json.dumps(summarise(envelope)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
