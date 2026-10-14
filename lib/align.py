#!/usr/bin/env python3
"""Forced word alignment using the WhisperX 3.8 alignment functions, offline.

Spawned as a subprocess by the Electron app and the CLI after Whisper has
run. Re-times the words Whisper recognised against the audio with a wav2vec2
model loaded from the local cache (it never downloads), writes a result
envelope to --output, and prints JSON progress lines to stderr.

Only whisperx.alignment is imported, never whisperx.asr: no second
recogniser is loaded and the recognised text is never changed. The output
holds times, scores and quality labels only, never text.

The alignment model and NLTK punkt_tab data must be prepared first with
scripts/setup-diarization.py --alignment.

Usage:
    python align.py --audio input.wav --input words.json --output out.json [--device auto|cpu|cuda]
    python align.py --check [--language en]

Input (written by lib/transcript-timing.js buildAlignmentInput):
    {"language": "en", "padMs": 200,
     "segments": [{"index": 0, "startMs": 0, "endMs": 10860, "words": ["Hello,", "and"]}]}

Output:
    {"format": "transcriber-alignment", "version": 1,
     "provider": {"name": "whisperx", "version", "model", "language"},
     "device", "processingSec",
     "segments": [{"index", "status": "aligned"|"failed", "reason",
                   "words": [{"startMs", "endMs", "score", "quality"}]}]}
    Each segment's words list has exactly as many entries as the input
    segment. quality is "measured" (has a score), "interpolated" (times but
    no score) or "unaligned" (no times; startMs, endMs and score are null).

stderr protocol:
    progress: {"message": "...", "percent": 30}
    error:    {"error": "...", "code": "model-not-prepared"} then exit 1

Error codes: python-unsupported, alignment-missing, alignment-unsupported,
language-unsupported, model-not-prepared, audio-invalid, alignment-failed.

--check prints one JSON object to stdout describing the environment and
always exits 0. It uses no network, loads no audio and no model.

This file is imported by scripts/setup-diarization.py and by the contract
tests, so nothing here may import whisperx, torch, transformers or nltk at
module level, and the syntax must stay parseable by old Python versions so
that the version gate can report a clear error.
"""

import argparse
import ast
import contextlib
import importlib.util
import io
import json
import logging
import math
import os
import platform
import re
import sys
import time
import wave

MIN_PYTHON = (3, 10)
SUPPORTED_WHISPERX = (3, 8)
EXPECTED_SAMPLE_RATE = 16000
EXPECTED_CHANNELS = 1
EXPECTED_SAMPLE_WIDTH = 2  # bytes, i.e. 16-bit PCM

ENVELOPE_FORMAT = "transcriber-alignment"
ENVELOPE_VERSION = 1
PROVIDER_NAME = "whisperx"
DEFAULT_LANGUAGE = "en"
DEFAULT_PAD_MS = 200
INTERPOLATE_METHOD = "nearest"

CHECK_STATUSES = (
    "ready",
    "model-not-prepared",
    "alignment-missing",
    "alignment-unsupported",
    "language-unsupported",
    "python-unsupported",
)

# Files a Hugging Face wav2vec2 alignment model needs in the cache: the
# processor (feature extractor and tokenizer vocabulary), the model config
# and one form of weights. The real load still has the final say.
HF_REQUIRED_FILES = ("config.json", "preprocessor_config.json", "vocab.json")
HF_WEIGHT_FILES = ("model.safetensors", "pytorch_model.bin",
                   "model.safetensors.index.json", "pytorch_model.bin.index.json")

_HERE = os.path.dirname(os.path.abspath(__file__))
REQUIREMENTS_PATH = os.path.join(_HERE, "requirements-alignment.txt")
SETUP_COMMAND = "python scripts/setup-diarization.py --alignment"


class AlignError(Exception):
    """An expected failure with a stable error code for the caller."""

    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code
        self.message = message


class DownloadBlocked(Exception):
    """Raised by the stand-ins for nltk.download and torch hub downloads."""


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

    Must run before huggingface_hub, transformers or whisperx are imported:
    they read these variables at import time. Values are forced, not
    defaulted, so an inherited setting cannot switch them back.
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


def _leading_ints(version, count):
    parts = []
    for piece in str(version).split(".")[:count]:
        digits = ""
        for ch in piece:
            if not ch.isdigit():
                break
            digits += ch
        if not digits:
            break
        parts.append(int(digits))
    return tuple(parts)


def whisperx_problem(version):
    """Return (code, message) if WhisperX is missing or not 3.8.x, else None."""
    if not version:
        return (
            "alignment-missing",
            "WhisperX is not installed, so word alignment is not available. "
            "Run: %s" % _pip_fix(),
        )
    if _leading_ints(version, 2) != SUPPORTED_WHISPERX:
        return (
            "alignment-unsupported",
            "WhisperX %s is not supported: version %d.%d.x is needed. Run: %s"
            % (version, SUPPORTED_WHISPERX[0], SUPPORTED_WHISPERX[1], _pip_fix()),
        )
    return None


def not_prepared_message(language, model, detail=None):
    msg = (
        "The word alignment model for language '%s' (%s) is not prepared on "
        "this computer. Run: %s %s"
        % (language, model or "unknown", SETUP_COMMAND, language)
    )
    if detail:
        msg += " (%s)" % detail
    return msg


# ---------------------------------------------------------------------------
# Language and model tables
# ---------------------------------------------------------------------------

def _whisperx_dir():
    """Folder of the installed whisperx package, found without importing it."""
    try:
        spec = importlib.util.find_spec("whisperx")
    except Exception:
        return None
    locations = list(getattr(spec, "submodule_search_locations", None) or []) if spec else []
    return locations[0] if locations else None


def _literal_assignments(path, names):
    """Read top-level literal dict assignments from a source file."""
    with open(path, "r", encoding="utf-8") as fp:
        tree = ast.parse(fp.read(), filename=path)
    found = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            if isinstance(target, ast.Name) and target.id in names:
                found[target.id] = ast.literal_eval(node.value)
    return found


def model_tables(module=None):
    """WhisperX's default model tables as {"torchaudio", "huggingface", "punkt"}.

    With an imported whisperx.alignment module, read them from it. Without
    one (--check), read the installed source files instead, because
    importing whisperx.alignment loads transformers and pandas and takes
    several seconds. If the source cannot be read, fall back to importing.
    Returns None when WhisperX is not installed.
    """
    if module is None:
        folder = _whisperx_dir()
        if folder:
            try:
                align_src = _literal_assignments(
                    os.path.join(folder, "alignment.py"),
                    ("DEFAULT_ALIGN_MODELS_TORCH", "DEFAULT_ALIGN_MODELS_HF"))
                utils_src = _literal_assignments(
                    os.path.join(folder, "utils.py"), ("PUNKT_LANGUAGES",))
                return {
                    "torchaudio": align_src["DEFAULT_ALIGN_MODELS_TORCH"],
                    "huggingface": align_src["DEFAULT_ALIGN_MODELS_HF"],
                    "punkt": utils_src.get("PUNKT_LANGUAGES", {}),
                }
            except Exception:
                pass
        try:
            import whisperx.alignment as module
        except Exception:
            return None
    return {
        "torchaudio": dict(getattr(module, "DEFAULT_ALIGN_MODELS_TORCH", {}) or {}),
        "huggingface": dict(getattr(module, "DEFAULT_ALIGN_MODELS_HF", {}) or {}),
        "punkt": dict(getattr(module, "PUNKT_LANGUAGES", {}) or {}),
    }


def normalise_language(language):
    if not isinstance(language, str):
        return None
    language = language.strip().lower()
    return language or None


def resolve_model(language, tables):
    """Return {"name", "type", "punkt"} for a language, or None if unsupported."""
    if not tables or not language:
        return None
    punkt = tables["punkt"].get(language, "english")
    if language in tables["torchaudio"]:
        return {"name": tables["torchaudio"][language], "type": "torchaudio", "punkt": punkt}
    if language in tables["huggingface"]:
        return {"name": tables["huggingface"][language], "type": "huggingface", "punkt": punkt}
    return None


def unsupported_language_message(language, tables):
    known = sorted(set(tables["torchaudio"]) | set(tables["huggingface"])) if tables else []
    return (
        "Word alignment has no model for language '%s'. Supported languages: %s."
        % (language, ", ".join(known) if known else "none found")
    )


# ---------------------------------------------------------------------------
# Cache checks (no network, no model load)
# ---------------------------------------------------------------------------

def torchaudio_checkpoint_path(model_name):
    """Where torch hub keeps a torchaudio bundle's weights.

    torchaudio fetches https://download.pytorch.org/torchaudio/models/<_path>
    with torch.hub.load_state_dict_from_url, which saves it as
    <torch hub dir>/checkpoints/<basename>.
    """
    import torch.hub
    import torchaudio.pipelines

    bundle = getattr(torchaudio.pipelines, model_name)
    basename = os.path.basename(str(bundle._path))
    return os.path.join(torch.hub.get_dir(), "checkpoints", basename)


def huggingface_model_status(repo_id):
    """Return (ready, snapshot_path, detail) from the Hugging Face cache only."""
    try:
        from huggingface_hub import try_to_load_from_cache
    except Exception:
        return False, None, "huggingface_hub is not installed"

    def cached(filename):
        try:
            found = try_to_load_from_cache(repo_id, filename)
        except Exception:
            return None
        return found if isinstance(found, str) else None

    missing = [name for name in HF_REQUIRED_FILES if not cached(name)]
    weights = [name for name in HF_WEIGHT_FILES if cached(name)]
    if not weights:
        missing.append("model weights")
    if missing:
        return False, None, "missing from the cache: " + ", ".join(missing)
    return True, os.path.dirname(cached(HF_REQUIRED_FILES[0])), None


def punkt_status(punkt_language):
    """Return (ready, path) for NLTK punkt_tab data for one language."""
    try:
        import nltk.data
    except Exception:
        return False, None
    try:
        return True, str(nltk.data.find("tokenizers/punkt_tab/%s/" % punkt_language))
    except LookupError:
        return False, None
    except Exception:
        return False, None


def model_status(model):
    """Return (ready, path, detail) for an alignment model's cached weights."""
    if model["type"] == "torchaudio":
        try:
            path = torchaudio_checkpoint_path(model["name"])
        except Exception as e:
            return False, None, "could not locate the torchaudio checkpoint (%s)" % e
        if os.path.isfile(path):
            return True, path, None
        return False, None, "%s is missing" % path
    return huggingface_model_status(model["name"])


def assets_status(language, model):
    """Readiness of everything inference needs for one language."""
    m_ready, m_path, m_detail = model_status(model)
    p_ready, p_path = punkt_status(model["punkt"])
    details = []
    if not m_ready:
        details.append(m_detail or "model weights are missing")
    if not p_ready:
        details.append("NLTK punkt_tab data for %s is missing" % model["punkt"])
    return {
        "ready": m_ready and p_ready,
        "modelReady": m_ready,
        "modelPath": m_path,
        "punktReady": p_ready,
        "punktPath": p_path,
        "detail": "; ".join(details) or None,
    }


# ---------------------------------------------------------------------------
# --check
# ---------------------------------------------------------------------------

def check_environment(language=DEFAULT_LANGUAGE, version_info=None):
    """Describe the alignment environment as a dict (the --check output).

    WhisperX is not imported (see model_tables); torch is imported to ask
    about CUDA and torchaudio to locate the checkpoint.
    """
    vi = current_version_info() if version_info is None else version_info
    language = normalise_language(language) or DEFAULT_LANGUAGE
    versions = {
        "python": _version_string(vi),
        "whisperx": package_version("whisperx"),
        "torch": package_version("torch"),
        "torchaudio": package_version("torchaudio"),
        "transformers": package_version("transformers"),
        "nltk": package_version("nltk"),
    }

    cuda_available = False
    try:
        import torch
        versions["torch"] = str(getattr(torch, "__version__", "")) or versions["torch"]
        cuda_available = bool(torch.cuda.is_available())
    except Exception:
        pass

    py_problem = python_problem(vi)
    wx_problem = whisperx_problem(versions["whisperx"])
    tables = model_tables() if versions["whisperx"] else None
    model = resolve_model(language, tables)
    assets = assets_status(language, model) if model else None

    if py_problem or wx_problem:
        status, message = py_problem or wx_problem
    elif model is None:
        status, message = "language-unsupported", unsupported_language_message(language, tables)
    elif not assets["ready"]:
        status = "model-not-prepared"
        message = not_prepared_message(language, model["name"], assets["detail"])
    else:
        status, message = "ready", "Word alignment is ready for language '%s'." % language

    return {
        "status": status,
        "message": message,
        "language": language,
        "versions": versions,
        "pythonSupported": py_problem is None,
        "alignmentSupported": wx_problem is None,
        "languageSupported": (model is not None) if tables is not None else None,
        "cudaAvailable": cuda_available,
        "model": {"name": model["name"], "type": model["type"]} if model else None,
        "modelReady": bool(assets and assets["modelReady"]),
        "modelPath": assets["modelPath"] if assets else None,
        "punktReady": bool(assets and assets["punktReady"]),
        "punktPath": assets["punktPath"] if assets else None,
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
    """Read and validate a 16 kHz, mono, 16-bit PCM WAV (what FFmpeg writes).

    Uses the built-in wave module, as lib/diarize.py does. Returns the raw
    PCM bytes and the duration.
    """
    if not os.path.isfile(path):
        raise AlignError("audio-invalid", "Audio file not found: %s" % path)
    try:
        with wave.open(path, "rb") as wf:
            channels = wf.getnchannels()
            width = wf.getsampwidth()
            rate = wf.getframerate()
            comptype = wf.getcomptype()
            frames = wf.getnframes()
            data = wf.readframes(frames)
    except (wave.Error, EOFError, OSError) as e:
        raise AlignError(
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
        raise AlignError("audio-invalid", "Unsupported WAV format: %s." % "; ".join(problems))
    if frames == 0:
        raise AlignError("audio-invalid", "The WAV file contains no audio.")

    return {
        "sampleRate": rate,
        "frames": frames,
        "durationMs": frames * 1000.0 / rate,
        "data": data,
    }


def to_waveform(data):
    """Convert little-endian 16-bit PCM bytes to a (1, n) float32 tensor."""
    import numpy as np
    import torch

    samples = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
    return torch.from_numpy(samples).unsqueeze(0)


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
# Mapping WhisperX words back to the input words
# ---------------------------------------------------------------------------

def lcs_pairs(a, b):
    """Index pairs (i, j) of a longest common subsequence of a and b.

    Exact string equality. Prefers the earliest match, so identical lists
    map one to one.
    """
    n, m = len(a), len(b)
    if n == 0 or m == 0:
        return []
    table = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        row, below = table[i], table[i + 1]
        ai = a[i]
        for j in range(m - 1, -1, -1):
            if ai == b[j]:
                row[j] = below[j + 1] + 1
            else:
                row[j] = below[j] if below[j] >= row[j + 1] else row[j + 1]
    pairs = []
    i = j = 0
    while i < n and j < m:
        if a[i] == b[j] and table[i][j] == table[i + 1][j + 1] + 1:
            pairs.append((i, j))
            i += 1
            j += 1
        elif table[i + 1][j] >= table[i][j + 1]:
            i += 1
        else:
            j += 1
    return pairs


UNALIGNED = {"startMs": None, "endMs": None, "score": None, "quality": "unaligned"}


def _finite(value):
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def word_timing(word):
    """Timing record for one WhisperX word (times in seconds, absolute)."""
    start = _finite(word.get("start"))
    end = _finite(word.get("end"))
    if start is None or end is None or start < 0 or end < start:
        return dict(UNALIGNED)
    score = _finite(word.get("score"))
    return {
        "startMs": int(round(start * 1000)),
        "endMs": int(round(end * 1000)),
        "score": round(score, 3) if score is not None else None,
        "quality": "measured" if score is not None else "interpolated",
    }


def map_words(input_words, output_words):
    """One timing record per input word, matched by exact text in order."""
    texts = [w.get("word") if isinstance(w, dict) else None for w in output_words]
    result = [dict(UNALIGNED) for _ in input_words]
    for i, j in lcs_pairs(input_words, texts):
        result[i] = word_timing(output_words[j])
    return result


def output_words(aligned):
    """All words WhisperX returned for one align() call, in order."""
    words = []
    for seg in (aligned or {}).get("segments") or []:
        words.extend(w for w in (seg.get("words") or []) if isinstance(w, dict))
    return words


# ---------------------------------------------------------------------------
# Inference
# ---------------------------------------------------------------------------

def _refuse_nltk_download(*args, **kwargs):
    raise DownloadBlocked("NLTK data download blocked during inference")


def _refuse_url_download(*args, **kwargs):
    raise DownloadBlocked("model download blocked during inference")


def import_alignment():
    """Import whisperx.alignment and enforce the 3.8.x gate.

    Returns (module, version). Also replaces nltk.download and torch hub's
    downloader with functions that raise, so a missing asset can never
    trigger a network call, and quietens WhisperX's logger (its warnings
    quote segment text).
    """
    version = package_version("whisperx")
    problem = whisperx_problem(version)
    if problem:
        raise AlignError(*problem)
    try:
        import whisperx.alignment as module
    except Exception as e:
        code, message = whisperx_problem(None)
        raise AlignError(code, "%s (import failed: %s)" % (message, e))
    logging.getLogger("whisperx").setLevel(logging.ERROR)

    import nltk
    nltk.download = _refuse_nltk_download
    try:
        import nltk.downloader
        nltk.downloader.download = _refuse_nltk_download
    except Exception:
        pass
    import torch.hub
    torch.hub.download_url_to_file = _refuse_url_download
    return module, str(version)


def _is_cache_miss(exc):
    """True if exc (or anything it wraps) means files are not cached."""
    names = ("LocalEntryNotFoundError", "OfflineModeIsEnabled", "DownloadBlocked")
    seen = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        for klass in type(exc).__mro__:
            if klass.__name__ in names:
                return True
        exc = exc.__cause__ or exc.__context__
    return False


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


def load_model(module, language, model, device):
    """Load the alignment model from the local cache only. Never downloads.

    Returns (model, metadata, device). If loading on the GPU fails for a
    reason other than a cache miss, tries the CPU once.
    """
    captured = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured):
            loaded, metadata = module.load_align_model(
                language, device, model_name=model["name"], model_cache_only=True)
        return loaded, metadata, device
    except Exception as e:
        # WhisperX turns any Hugging Face load failure into ValueError; we
        # checked the files are cached, so treat it as missing or damaged.
        if _is_cache_miss(e) or (model["type"] == "huggingface" and isinstance(e, ValueError)):
            raise AlignError("model-not-prepared",
                             not_prepared_message(language, model["name"],
                                                  "could not load it from the cache"))
        if device != "cpu":
            progress("Could not load the alignment model on the GPU (%s), using CPU" % e, 20)
            return load_model(module, language, model, "cpu")
        raise AlignError(
            "alignment-failed",
            "Could not load the alignment model: %s. If the cached files are "
            "damaged, run %s %s again." % (e, SETUP_COMMAND, language),
        )


def align_segments(module, segments, pad_ms, duration_ms, loaded, metadata, waveform, device,
                   not_prepared=None):
    """Align each input segment separately and map words back. Returns the
    output segment list. Raises AlignError for whole-step failures.

    One align() call per input segment: WhisperX splits and merges its
    output by sentence, so this is the only way to know which input segment
    each returned word belongs to.
    """
    results = []
    attempted = errors = 0
    first_error = None
    total = len(segments)
    last_percent = None
    for n, seg in enumerate(segments):
        words = seg["words"]
        record = {"index": seg["index"], "status": "failed", "reason": None,
                  "words": [dict(UNALIGNED) for _ in words]}
        results.append(record)

        window = segment_window(seg, pad_ms, duration_ms)
        if not words:
            record["reason"] = "empty-segment"
        elif window is None:
            record["reason"] = "outside-audio"
        else:
            attempted += 1
            transcript = [{"start": window[0] / 1000.0, "end": window[1] / 1000.0,
                           "text": " ".join(words)}]
            try:
                aligned = module.align(transcript, loaded, metadata, waveform, device,
                                       interpolate_method=INTERPOLATE_METHOD,
                                       return_char_alignments=False)
            except Exception as e:
                if _is_cache_miss(e):
                    raise AlignError("model-not-prepared", not_prepared or str(e))
                if _is_out_of_memory(e):
                    raise AlignError("alignment-failed", "Word alignment ran out of memory: %s" % e)
                errors += 1
                first_error = first_error or e
                record["reason"] = "align-error"
                aligned = None
            if aligned is not None:
                returned = output_words(aligned)
                if returned:
                    record["status"] = "aligned"
                    record["words"] = map_words(words, returned)
                else:
                    record["reason"] = "no-words-returned"

        percent = 25 + int(70 * (n + 1) / total)
        if last_percent is None or percent - last_percent >= 5 or n + 1 == total:
            progress("Aligning words (%d of %d segments)..." % (n + 1, total), percent)
            last_percent = percent

    if attempted and errors == attempted:
        raise AlignError("alignment-failed",
                         "Word alignment failed for every segment: %s: %s"
                         % (type(first_error).__name__, first_error))
    return results


def build_envelope(whisperx_version, model_name, language, device, processing_sec, segments):
    return {
        "format": ENVELOPE_FORMAT,
        "version": ENVELOPE_VERSION,
        "provider": {"name": PROVIDER_NAME, "version": whisperx_version,
                     "model": model_name, "language": language},
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

    progress("Loading WhisperX alignment...", 5)
    module, whisperx_version = import_alignment()

    language = request["language"]
    tables = model_tables(module)
    model = resolve_model(language, tables)
    if model is None:
        if not language:
            raise AlignError("language-unsupported", "No language was given for word alignment.")
        raise AlignError("language-unsupported", unsupported_language_message(language, tables))

    assets = assets_status(language, model)
    if not assets["ready"]:
        raise AlignError("model-not-prepared",
                         not_prepared_message(language, model["name"], assets["detail"]))

    device = select_device(getattr(args, "device", "auto") or "auto")
    segments = request["segments"]
    if not segments:
        progress("Nothing to align", 90)
        return build_envelope(whisperx_version, model["name"], language, device, 0.0, [])

    progress("Loading the alignment model from the local cache...", 20)
    loaded, metadata, device = load_model(module, language, model, device)

    try:
        waveform = to_waveform(audio["data"])
    except Exception as e:
        raise AlignError("audio-invalid", "Failed to load audio: %s" % e)

    progress("Aligning words...", 25)
    # processingSec times the alignment calls only (not imports or model
    # load), so it can be compared with the audio duration.
    started = time.time()
    try:
        results = align_segments(module, segments, request["padMs"], audio["durationMs"],
                                 loaded, metadata, waveform, device,
                                 not_prepared_message(language, model["name"],
                                                      "a download was needed during alignment"))
    except AlignError:
        raise
    except Exception as e:
        raise AlignError("alignment-failed", "Word alignment failed: %s" % e)
    processing_sec = round(time.time() - started, 3)

    return build_envelope(whisperx_version, model["name"], language, device,
                          processing_sec, results)


def write_envelope(path, envelope):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(envelope, f, indent=2)


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
    parser = _ScrubbingParser(description="Forced word alignment via WhisperX (offline)")
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
        result = check_environment(args.language)
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
