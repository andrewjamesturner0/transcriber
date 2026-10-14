#!/usr/bin/env python3
"""Contract tests for lib/align.py and scripts/setup-diarization.py --alignment.

Runs with a plain Python: whisperx, torch, torchaudio, nltk and
huggingface_hub are not needed. An import hook supplies stub versions of
them (and of numpy, if it is not installed) and records the environment at
the moment each one is imported. Nothing is downloaded and no real model is
loaded.

Covers: offline variables set before import, the result envelope, padding
and time origins, word mapping by text in order (LCS), measured /
interpolated / unaligned words, failed segments, cache-only assets with
downloads blocked, version and language gates, WAV and input validation,
--check, and the setup helper's --alignment flow.

Usage:
    python3 scripts/test-align-contract.py
"""

import contextlib
import importlib
import importlib.abc
import importlib.machinery
import importlib.util
import io
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import types
import wave

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ALIGN_PATH = os.path.join(ROOT, "lib", "align.py")
DIARIZE_PATH = os.path.join(ROOT, "lib", "diarize.py")
SETUP_PATH = os.path.join(ROOT, "scripts", "setup-diarization.py")

SPEAKER_MODEL = "pyannote/speaker-diarization-community-1"
SPEAKER_REVISION = "3533c8cf8e369892e6b79ff1bf80f7b0286a54ee"
EN_MODEL = "WAV2VEC2_ASR_BASE_960H"
EN_FILE = "wav2vec2_fairseq_base_ls960_asr_ls960.pth"
NL_MODEL = "jonatasgrosman/wav2vec2-large-xlsr-53-dutch"
WATCHED_ENV = ("HF_HUB_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "TRANSFORMERS_OFFLINE")
TOKEN_VARS = ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN")
SECRET = "hf_TESTSECRET0123456789"
VERSIONS = {"whisperx": "3.8.6", "torch": "2.8.0", "torchaudio": "2.8.0",
            "transformers": "4.57.6", "nltk": "3.10.3"}

# --- Helpers ----------------------------------------------------------------

passed = 0
failed = 0
_queue = []


def section(title):
    _queue.append((title, None))


def test(name):
    def wrap(fn):
        _queue.append((name, fn))
        return fn
    return wrap


def run_all():
    global passed, failed
    for name, fn in _queue:
        if fn is None:
            print("\n%s\n" % name)
            continue
        reset_state()
        saved_env = dict(os.environ)
        try:
            fn()
            print("  PASS: %s" % name)
            passed += 1
        except Exception as e:  # noqa: BLE001 - report every failure
            print("  FAIL: %s -- %s: %s" % (name, type(e).__name__, e))
            failed += 1
        finally:
            os.environ.clear()
            os.environ.update(saved_env)
    print("\n%d passed, %d failed" % (passed, failed))
    shutil.rmtree(TMP, ignore_errors=True)
    sys.exit(1 if failed else 0)


def check(cond, msg="assertion failed"):
    if not cond:
        raise AssertionError(msg)


TMP = tempfile.mkdtemp(prefix="align-contract-")


def write_wav(name, rate=16000, channels=1, width=2, seconds=3.0):
    path = os.path.join(TMP, name)
    frames = int(rate * seconds)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(width)
        wf.setframerate(rate)
        sample = b"\x80" if width == 1 else struct.pack("<h", 1000)
        wf.writeframes(sample * channels * frames)
    return path


# --- Stub modules -----------------------------------------------------------

STATE = {}


def default_align_words(seg):
    """Echo every word with a time and score, 100 ms apart from the window start."""
    words = []
    for k, text in enumerate(seg["text"].split(" ")):
        start = seg["start"] + 0.1 * (k + 1)
        words.append({"word": text, "start": start, "end": start + 0.05, "score": 0.9})
    return words


def reset_state():
    hub_dir = tempfile.mkdtemp(dir=TMP)
    STATE.clear()
    STATE.update({
        "cuda": False,
        "env_at_import": {},
        "hub_dir": hub_dir,
        "punkt": {"english", "dutch"},      # languages with punkt_tab data
        "hf_cache": set(),                  # (repo, filename)
        "align_impl": default_align_words,  # fn(segment) -> words, or raises
        "align_calls": [],
        "load_calls": [],
        "load_error": None,                 # exception instance to raise from load
        "load_downloads": False,            # load calls torch hub download (setup)
        "nltk_downloads": [],
        "url_downloads": [],
        "snapshot_calls": [],
        "speaker_cache": set(),
        "download_offline": [],
    })
    for name in list(sys.modules):
        if name in STUBS or name.startswith("transcriber_"):
            del sys.modules[name]


def fill_en_checkpoint():
    folder = os.path.join(STATE["hub_dir"], "checkpoints")
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, EN_FILE), "wb") as f:
        f.write(b"weights")


def fill_hf(repo=NL_MODEL, files=("config.json", "preprocessor_config.json", "vocab.json",
                                   "model.safetensors")):
    for f in files:
        STATE["hf_cache"].add((repo, f))


def fill_speaker():
    for f in ("config.yaml", "segmentation/pytorch_model.bin", "embedding/pytorch_model.bin",
              "plda/xvec_transform.npz", "plda/plda.npz"):
        STATE["speaker_cache"].add((SPEAKER_MODEL, SPEAKER_REVISION, f))


class FakeTensor(object):
    def __init__(self, arr):
        self.arr = arr
        self.shape = (len(arr),)

    def unsqueeze(self, dim):
        t = FakeTensor(self.arr)
        t.shape = (1, len(self.arr))
        return t


def build_torch(m):
    m.__version__ = "2.8.0+stub"
    m.cuda = types.SimpleNamespace(is_available=lambda: STATE["cuda"])
    m.from_numpy = FakeTensor


def build_torch_hub(m):
    m.get_dir = lambda: STATE["hub_dir"]

    def download_url_to_file(url, dst, *args, **kwargs):
        STATE["url_downloads"].append({"url": url, "offline": os.environ.get("HF_HUB_OFFLINE")})
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as f:
            f.write(b"weights")

    m.download_url_to_file = download_url_to_file


def build_torchaudio(m):
    pass


def build_torchaudio_pipelines(m):
    m.WAV2VEC2_ASR_BASE_960H = types.SimpleNamespace(_path=EN_FILE)
    m.VOXPOPULI_ASR_BASE_10K_FR = types.SimpleNamespace(_path="wav2vec2_voxpopuli_base_10k_asr_fr.pt")


def build_nltk(m):
    def download(package, quiet=False, raise_on_error=False, **kwargs):
        STATE["nltk_downloads"].append({"package": package,
                                        "offline": os.environ.get("HF_HUB_OFFLINE")})
        STATE["punkt"].update({"english", "dutch", "french"})
        return True

    m.download = download


def build_nltk_data(m):
    def find(resource):
        parts = resource.strip("/").split("/")
        if parts[:2] == ["tokenizers", "punkt_tab"] and parts[2] in STATE["punkt"]:
            return "/nltk_data/" + resource.strip("/")
        raise LookupError("Resource %s not found" % resource)

    m.find = find


def build_nltk_downloader(m):
    m.download = sys.modules["nltk"].download


def build_hub(m):
    class LocalEntryNotFoundError(FileNotFoundError):
        pass

    m.LocalEntryNotFoundError = LocalEntryNotFoundError

    def try_to_load_from_cache(repo_id, filename, cache_dir=None, revision=None, repo_type=None):
        if revision is None and (repo_id, filename) in STATE["hf_cache"]:
            return "/hf/models--%s/snapshots/main/%s" % (repo_id.replace("/", "--"), filename)
        if (repo_id, revision, filename) in STATE["speaker_cache"]:
            return "/hf/models--%s/snapshots/%s/%s" % (repo_id.replace("/", "--"), revision, filename)
        return None

    def snapshot_download(repo_id, revision=None, token=None, **kwargs):
        STATE["snapshot_calls"].append({"repo_id": repo_id, "token": token,
                                        "offline": os.environ.get("HF_HUB_OFFLINE")})
        fill_speaker()
        return "/hf/models--%s/snapshots/%s" % (repo_id.replace("/", "--"), revision)

    m.try_to_load_from_cache = try_to_load_from_cache
    m.snapshot_download = snapshot_download


def build_whisperx(m):
    pass


def build_whisperx_alignment(m):
    m.DEFAULT_ALIGN_MODELS_TORCH = {"en": EN_MODEL, "fr": "VOXPOPULI_ASR_BASE_10K_FR"}
    m.DEFAULT_ALIGN_MODELS_HF = {"nl": NL_MODEL}
    m.PUNKT_LANGUAGES = {"en": "english", "nl": "dutch", "fr": "french"}

    def load_align_model(language_code, device, model_name=None, model_dir=None,
                         model_cache_only=False):
        name = model_name or m.DEFAULT_ALIGN_MODELS_TORCH.get(language_code) or \
            m.DEFAULT_ALIGN_MODELS_HF.get(language_code)
        STATE["load_calls"].append({"language": language_code, "device": device,
                                    "model_name": model_name, "cache_only": model_cache_only,
                                    "offline": os.environ.get("HF_HUB_OFFLINE")})
        print("stdout noise from load_align_model")
        if STATE["load_error"] is not None:
            raise STATE["load_error"]
        if name in m.DEFAULT_ALIGN_MODELS_TORCH.values():
            pipelines = sys.modules["torchaudio.pipelines"]
            filename = getattr(pipelines, name)._path
            path = os.path.join(STATE["hub_dir"], "checkpoints", filename)
            if STATE["load_downloads"] or not os.path.exists(path):
                # What torch.hub.load_state_dict_from_url does on a miss.
                sys.modules["torch.hub"].download_url_to_file(
                    "https://download.pytorch.org/torchaudio/models/" + filename, path)
            kind = "torchaudio"
        else:
            if model_cache_only and (name, "config.json") not in STATE["hf_cache"]:
                raise ValueError('The chosen align_model "%s" could not be found' % name)
            fill_hf(name)
            kind = "huggingface"
        return ("model", name), {"language": language_code, "dictionary": {}, "type": kind}

    def align(transcript, model, align_model_metadata, audio, device,
              interpolate_method="nearest", return_char_alignments=False, **kwargs):
        lang = align_model_metadata["language"]
        punkt = m.PUNKT_LANGUAGES.get(lang, "english")
        if punkt not in STATE["punkt"]:
            sys.modules["nltk"].download("punkt_tab", quiet=True)  # what WhisperX does
        segments = []
        for seg in transcript:
            STATE["align_calls"].append({"start": seg["start"], "end": seg["end"],
                                         "text": seg["text"], "device": device,
                                         "interpolate": interpolate_method,
                                         "audio_shape": getattr(audio, "shape", None)})
            words = STATE["align_impl"](seg)
            segments.append({"start": seg["start"], "end": seg["end"], "text": seg["text"],
                             "words": words})
        return {"segments": segments,
                "word_segments": [w for s in segments for w in s["words"]]}

    m.load_align_model = load_align_model
    m.align = align


STUBS = {
    "torch": build_torch,
    "torch.hub": build_torch_hub,
    "torchaudio": build_torchaudio,
    "torchaudio.pipelines": build_torchaudio_pipelines,
    "nltk": build_nltk,
    "nltk.data": build_nltk_data,
    "nltk.downloader": build_nltk_downloader,
    "huggingface_hub": build_hub,
    "whisperx": build_whisperx,
    "whisperx.alignment": build_whisperx_alignment,
    "pyannote": lambda m: None,
    "pyannote.audio": lambda m: setattr(m, "__version__", "4.0.7"),
}
PACKAGES = ("torch", "torchaudio", "nltk", "whisperx", "pyannote")

try:
    import numpy  # noqa: F401 - real numpy is fine when present
except ImportError:
    class _FakeArray(list):
        def astype(self, dtype):
            return _FakeArray(self)

        def __truediv__(self, other):
            return _FakeArray(x / other for x in self)

    def _build_numpy(m):
        m.float32 = "float32"
        m.frombuffer = lambda data, dtype=None: _FakeArray(
            struct.unpack("<%dh" % (len(data) // 2), data))

    STUBS["numpy"] = _build_numpy


class StubFinder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, fullname, path, target=None):
        if fullname in STUBS:
            return importlib.machinery.ModuleSpec(
                fullname, self, is_package=fullname in PACKAGES)
        return None

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        STATE["env_at_import"][module.__name__] = dict(
            (k, os.environ.get(k)) for k in WATCHED_ENV)
        STUBS[module.__name__](module)


sys.meta_path.insert(0, StubFinder())


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_align(versions=None):
    a = load_module(ALIGN_PATH, "transcriber_align_test")
    a.SCRIPT_PATH = ALIGN_PATH
    table = dict(VERSIONS) if versions is None else versions
    a.package_version = lambda name: table.get(name)
    return a


def load_diarize():
    d = load_module(DIARIZE_PATH, "transcriber_diarize_test")
    d.SCRIPT_PATH = DIARIZE_PATH
    table = {"pyannote.audio": "4.0.7", "torch": "2.8.0"}
    d.package_version = lambda name: table.get(name)
    return d


def run_main(module, argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = module.main(argv)
        except SystemExit as e:
            code = e.code
    return code, out.getvalue(), err.getvalue()


def error_line(stderr):
    for line in stderr.splitlines():
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict) and "error" in obj:
            return obj
    return None


GOOD_WAV = None


def good_wav():
    global GOOD_WAV
    if GOOD_WAV is None:
        GOOD_WAV = write_wav("good.wav")  # 3.0 s
    return GOOD_WAV


def tmp_path(name):
    p = os.path.join(TMP, name)
    if os.path.exists(p):
        os.remove(p)
    return p


def write_input(segments, language="en", pad_ms=200, name="in.json", raw=None):
    path = tmp_path(name)
    with open(path, "w", encoding="utf-8") as f:
        if raw is not None:
            f.write(raw)
        else:
            data = {"language": language, "segments": segments}
            if pad_ms is not None:
                data["padMs"] = pad_ms
            json.dump(data, f)
    return path


def seg(index, start_ms, end_ms, words):
    return {"index": index, "startMs": start_ms, "endMs": end_ms, "words": list(words)}


def align_run(segments, *extra, language="en", pad_ms=200, wav=None, versions=None,
              ready=True):
    """Run align.main and return (code, envelope or None, stdout, stderr)."""
    if ready:
        fill_en_checkpoint()
    a = load_align(versions)
    inp = write_input(segments, language=language, pad_ms=pad_ms)
    out = tmp_path("out.json")
    code, stdout, stderr = run_main(a, ["--audio", wav or good_wav(), "--input", inp,
                                        "--output", out] + list(extra))
    env = None
    if os.path.exists(out):
        with open(out, encoding="utf-8") as f:
            env = json.load(f)
    return code, env, stdout, stderr


def words_of(env, index):
    for s in env["segments"]:
        if s["index"] == index:
            return s["words"]
    raise AssertionError("segment %s missing" % index)


# --- Tests: environment and imports -----------------------------------------

section("Environment tests")


@test("importing lib/align.py imports no heavy modules")
def _():
    load_align()
    check(STATE["env_at_import"] == {}, "imported: %s" % list(STATE["env_at_import"]))


@test("inference sets offline and telemetry variables before whisperx/torch/nltk import")
def _():
    os.environ["HF_HUB_OFFLINE"] = "0"           # must be overridden
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "0"
    os.environ.pop("TRANSFORMERS_OFFLINE", None)
    code, env, _, err = align_run([seg(0, 500, 1500, ["Hello", "there"])])
    check(code == 0, "exit %s: %s" % (code, err))
    expected = {"HF_HUB_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "TRANSFORMERS_OFFLINE": "1"}
    for name in ("whisperx", "whisperx.alignment", "torch", "nltk"):
        check(STATE["env_at_import"].get(name) == expected,
              "%s imported with %s" % (name, STATE["env_at_import"].get(name)))
    call = STATE["load_calls"][0]
    check(call["cache_only"] is True and call["offline"] == "1", "load %s" % call)
    check(call["model_name"] == EN_MODEL, "model name passed explicitly")


@test("only whisperx.alignment is imported, never the recogniser")
def _():
    code, _, _, err = align_run([seg(0, 500, 1500, ["Hello"])])
    check(code == 0, err)
    check("whisperx.asr" not in sys.modules and "faster_whisper" not in sys.modules, "asr imported")


@test("--check reads model tables from source without importing whisperx.alignment")
def _():
    folder = tempfile.mkdtemp(dir=TMP)
    with open(os.path.join(folder, "alignment.py"), "w") as f:
        f.write("import torch\nDEFAULT_ALIGN_MODELS_TORCH = {'en': '%s'}\n"
                "DEFAULT_ALIGN_MODELS_HF = {'nl': '%s'}\n" % (EN_MODEL, NL_MODEL))
    with open(os.path.join(folder, "utils.py"), "w") as f:
        f.write("PUNKT_LANGUAGES = {'en': 'english', 'nl': 'dutch'}\n")
    fill_en_checkpoint()
    a = load_align()
    a._whisperx_dir = lambda: folder
    os.environ.pop("TRANSFORMERS_OFFLINE", None)
    code, out, _ = run_main(a, ["--check"])
    res = json.loads(out)
    check(code == 0 and res["status"] == "ready", out)
    check("whisperx.alignment" not in STATE["env_at_import"], "whisperx.alignment imported")
    expected = {"HF_HUB_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "TRANSFORMERS_OFFLINE": "1"}
    check(STATE["env_at_import"].get("torch") == expected, "torch env %s" % STATE["env_at_import"].get("torch"))
    check(a.model_tables()["huggingface"] == {"nl": NL_MODEL}, "tables from source")


# --- Tests: envelope and timing ----------------------------------------------

section("Envelope and timing tests")


@test("envelope has exactly the documented fields")
def _():
    code, env, out, err = align_run([seg(0, 500, 1500, ["Hello", "there"])])
    check(code == 0, err)
    check(set(env) == {"format", "version", "provider", "device", "processingSec", "segments"},
          "keys %s" % sorted(env))
    check(env["format"] == "transcriber-alignment" and env["version"] == 1, "format/version")
    check(env["provider"] == {"name": "whisperx", "version": "3.8.6", "model": EN_MODEL,
                              "language": "en"}, "provider %s" % env["provider"])
    check(env["device"] == "cpu" and isinstance(env["processingSec"], (int, float)), "device/time")
    s = env["segments"][0]
    check(set(s) == {"index", "status", "reason", "words"}, "segment keys %s" % sorted(s))
    check(s["status"] == "aligned" and s["reason"] is None, "status")
    for w in s["words"]:
        check(set(w) == {"startMs", "endMs", "score", "quality"}, "word keys %s" % sorted(w))
    summary = json.loads(out.strip().splitlines()[-1])
    check(summary == {"segments": 1, "failedSegments": 0, "words": 2, "measured": 2,
                      "interpolated": 0, "unaligned": 0}, "stdout %s" % summary)
    progress = [json.loads(l) for l in err.splitlines() if l.startswith("{")]
    check(all("message" in p for p in progress), "progress lines keep message")
    check(any(p.get("percent") == 100 for p in progress), "Done line")
    check("stdout noise" not in out, "load_align_model output kept off stdout")


@test("padding: window is [start - pad, end + pad] clamped to the audio; times are absolute ms")
def _():
    segments = [seg(0, 1000, 2000, ["a", "b"]),     # padded both sides
                seg(1, 100, 900, ["c"]),            # start clamps to 0
                seg(2, 2500, 2950, ["d"])]          # end clamps to 3000
    code, env, _, err = align_run(segments, pad_ms=200)
    check(code == 0, err)
    calls = STATE["align_calls"]
    check(len(calls) == 3, "one align() call per input segment")
    check(abs(calls[0]["start"] - 0.8) < 1e-9 and abs(calls[0]["end"] - 2.2) < 1e-9, calls[0])
    check(calls[1]["start"] == 0.0 and abs(calls[1]["end"] - 1.1) < 1e-9, calls[1])
    check(abs(calls[2]["start"] - 2.3) < 1e-9 and calls[2]["end"] == 3.0, calls[2])
    check(calls[0]["text"] == "a b", "text is the words joined by single spaces")
    check(calls[0]["interpolate"] == "nearest", "interpolate method")
    check(calls[0]["audio_shape"] == (1, 48000), "whole waveform passed: %s" % (calls[0]["audio_shape"],))
    w = words_of(env, 0)
    # The stub places word k at window start + 0.1 * (k + 1) seconds.
    check(w[0]["startMs"] == 900 and w[0]["endMs"] == 950, "absolute ms %s" % w[0])
    check(w[1]["startMs"] == 1000, "second word %s" % w[1])
    check(words_of(env, 1)[0]["startMs"] == 100, "clamped window origin")


@test("padMs 0 and missing padMs (default 200)")
def _():
    code, env, _, err = align_run([seg(0, 1000, 2000, ["a"])], pad_ms=0)
    check(code == 0, err)
    check(STATE["align_calls"][0]["start"] == 1.0 and STATE["align_calls"][0]["end"] == 2.0, "pad 0")
    reset_state()
    code, env, _, err = align_run([seg(0, 1000, 2000, ["a"])], pad_ms=None)
    check(code == 0, err)
    check(abs(STATE["align_calls"][0]["start"] - 0.8) < 1e-9, "default pad")


@test("a window that starts after the audio ends -> failed outside-audio, not sent to WhisperX")
def _():
    code, env, _, err = align_run([seg(0, 500, 900, ["x"]), seg(1, 3300, 4000, ["late", "words"])])
    check(code == 0, err)
    s = env["segments"][1]
    check(s["status"] == "failed" and s["reason"] == "outside-audio", s)
    check([w["quality"] for w in s["words"]] == ["unaligned", "unaligned"], s["words"])
    check(len(STATE["align_calls"]) == 1, "only the first segment aligned")


@test("punctuation, numbers and names are sent and matched exactly")
def _():
    words = ["$12.6", "U.S.", "O'Brien", "said,", "3%"]
    code, env, _, err = align_run([seg(0, 0, 2000, words)])
    check(code == 0, err)
    check(STATE["align_calls"][0]["text"] == "$12.6 U.S. O'Brien said, 3%", STATE["align_calls"][0]["text"])
    w = words_of(env, 0)
    check(len(w) == 5 and all(x["quality"] == "measured" for x in w), w)
    check([x["startMs"] for x in w] == [100, 200, 300, 400, 500], [x["startMs"] for x in w])


@test("measured, interpolated and unaligned words")
def _():
    def impl(s):
        return [
            {"word": "one", "start": 0.1, "end": 0.2, "score": 0.81234},
            {"word": "two", "start": 0.3, "end": 0.4},                       # no score
            {"word": "three"},                                               # no times
            {"word": "four", "start": float("nan"), "end": 0.6, "score": 0.5},
            {"word": "five", "start": 0.9, "end": 0.8, "score": 0.5},        # end < start
        ]
    STATE["align_impl"] = impl
    code, env, out, err = align_run([seg(0, 0, 1000, ["one", "two", "three", "four", "five"])])
    check(code == 0, err)
    w = words_of(env, 0)
    check(w[0] == {"startMs": 100, "endMs": 200, "score": 0.812, "quality": "measured"}, w[0])
    check(w[1] == {"startMs": 300, "endMs": 400, "score": None, "quality": "interpolated"}, w[1])
    for k in (2, 3, 4):
        check(w[k] == {"startMs": None, "endMs": None, "score": None, "quality": "unaligned"},
              "%d: %s" % (k, w[k]))
    summary = json.loads(out.strip().splitlines()[-1])
    check(summary["measured"] == 1 and summary["interpolated"] == 1 and summary["unaligned"] == 3, summary)


@test("WhisperX returns no words for a segment -> failed, all unaligned")
def _():
    STATE["align_impl"] = lambda s: [] if s["text"].startswith("silent") else default_align_words(s)
    code, env, _, err = align_run([seg(0, 0, 900, ["fine"]), seg(1, 1000, 2000, ["silent", "bit"])])
    check(code == 0, err)
    s = env["segments"][1]
    check(s["status"] == "failed" and s["reason"] == "no-words-returned", s)
    check(len(s["words"]) == 2 and all(w["quality"] == "unaligned" for w in s["words"]), s["words"])
    check(env["segments"][0]["status"] == "aligned", "other segment unaffected")


@test("an input segment with no words -> failed empty-segment, not sent")
def _():
    code, env, _, err = align_run([seg(0, 0, 900, [])])
    check(code == 0, err)
    check(env["segments"][0] == {"index": 0, "status": "failed", "reason": "empty-segment",
                                 "words": []}, env["segments"][0])
    check(STATE["align_calls"] == [], "not sent")


@test("missing, extra and reordered output words are mapped by LCS")
def _():
    def impl(s):
        texts = {"a b c d": ["a", "EXTRA", "c", "d"],          # b missing, one extra
                 "p q r s": ["q", "p", "r", "s"],              # first two swapped
                 "the cat the": ["the", "the"]}[s["text"]]
        return [{"word": t, "start": 0.01 * (k + 1) + s["start"], "end": 0.01 * (k + 1) + s["start"] + 0.005,
                 "score": 0.5} for k, t in enumerate(texts)]
    STATE["align_impl"] = impl
    code, env, _, err = align_run([seg(0, 0, 500, "a b c d".split()),
                                   seg(1, 1000, 1500, "p q r s".split()),
                                   seg(2, 2000, 2500, "the cat the".split())], pad_ms=0)
    check(code == 0, err)
    w = words_of(env, 0)
    check([x["quality"] for x in w] == ["measured", "unaligned", "measured", "measured"], w)
    check([x["startMs"] for x in w] == [10, None, 30, 40], "times follow matched words %s" % w)
    w = words_of(env, 1)
    check([x["quality"] for x in w].count("unaligned") == 1, w)
    check(w[2]["startMs"] == 1030 and w[3]["startMs"] == 1040, "r and s keep their own times")
    matched = [x for x in w[:2] if x["quality"] == "measured"][0]
    check(matched["startMs"] in (1010, 1020), "a swapped word keeps its own time")
    w = words_of(env, 2)
    check([x["startMs"] for x in w] == [2010, None, 2020], "duplicates map in order %s" % w)


@test("lcs_pairs: identical lists map one to one; empty lists map nothing")
def _():
    a = load_align()
    words = ["the", "the", "a", "the"]
    check(a.lcs_pairs(words, list(words)) == [(0, 0), (1, 1), (2, 2), (3, 3)], "identity")
    check(a.lcs_pairs([], ["x"]) == [] and a.lcs_pairs(["x"], []) == [], "empty")


@test("output word counts always equal input word counts")
def _():
    import random
    rng = random.Random(7)
    vocab = ["a", "b", "c", "d", "e"]

    def impl(s):
        texts = s["text"].split(" ")
        rng.shuffle(texts)
        texts = texts[:rng.randint(0, len(texts))] + [rng.choice(vocab) for _ in range(rng.randint(0, 3))]
        return [{"word": t, "start": s["start"], "end": s["end"], "score": 0.5} for t in texts]
    STATE["align_impl"] = impl
    segments = [seg(i, 0, 2000, [rng.choice(vocab) for _ in range(rng.randint(1, 12))])
                for i in range(30)]
    code, env, _, err = align_run(segments)
    check(code == 0, err)
    for s_in, s_out in zip(segments, env["segments"]):
        check(s_in["index"] == s_out["index"], "order kept")
        check(len(s_out["words"]) == len(s_in["words"]), "segment %d length" % s_in["index"])


@test("empty input -> empty envelope; the model is not loaded")
def _():
    code, env, out, err = align_run([])
    check(code == 0, err)
    check(env["segments"] == [] and env["provider"]["model"] == EN_MODEL, env)
    check(STATE["load_calls"] == [] and STATE["align_calls"] == [], "nothing loaded")


@test("the output never contains the recognised text")
def _():
    words = ["Zebrafinch", "quixotically", "Wolverhampton,", "$98.7"]
    code, env, out, err = align_run([seg(0, 0, 2000, words)])
    check(code == 0, err)
    with open(os.path.join(TMP, "out.json"), encoding="utf-8") as f:
        raw = f.read()
    for w in words:
        check(w not in raw, "%s in output file" % w)
        check(w not in out and w not in err, "%s printed" % w)


@test("device: auto uses CUDA when available; --device cpu forces CPU; cuda falls back")
def _():
    STATE["cuda"] = True
    code, env, _, err = align_run([seg(0, 0, 900, ["a"])])
    check(code == 0 and env["device"] == "cuda", err)
    check(STATE["load_calls"][0]["device"] == "cuda" and STATE["align_calls"][0]["device"] == "cuda", "cuda used")
    reset_state()
    STATE["cuda"] = True
    code, env, _, err = align_run([seg(0, 0, 900, ["a"])], "--device", "cpu")
    check(code == 0 and env["device"] == "cpu", "forced cpu")
    reset_state()
    code, env, _, err = align_run([seg(0, 0, 900, ["a"])], "--device", "cuda")
    check(code == 0 and env["device"] == "cpu", "cuda unavailable -> cpu")


@test("GPU load failure retries on the CPU")
def _():
    STATE["cuda"] = True
    a_err = RuntimeError("CUDA error: no kernel image")
    calls = {"n": 0}
    real_impl = None

    def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise a_err
        return real_impl(*args, **kwargs)

    fill_en_checkpoint()
    a = load_align()
    importlib.import_module("whisperx.alignment")
    wx = sys.modules["whisperx.alignment"]
    real_impl = wx.load_align_model
    wx.load_align_model = flaky
    inp = write_input([seg(0, 0, 900, ["a"])])
    out = tmp_path("out.json")
    code, _, err = run_main(a, ["--audio", good_wav(), "--input", inp, "--output", out])
    check(code == 0, err)
    with open(out) as f:
        check(json.load(f)["device"] == "cpu", "fell back to cpu")


# --- Tests: failures ---------------------------------------------------------

section("Failure tests")


@test("per-segment errors fail that segment; all segments failing -> alignment-failed")
def _():
    def impl(s):
        if s["text"] == "bad":
            raise KeyError("trellis")
        return default_align_words(s)
    STATE["align_impl"] = impl
    code, env, _, err = align_run([seg(0, 0, 900, ["good"]), seg(1, 1000, 1900, ["bad"])])
    check(code == 0, err)
    check(env["segments"][1]["status"] == "failed" and env["segments"][1]["reason"] == "align-error",
          env["segments"][1])
    reset_state()
    STATE["align_impl"] = impl
    code, env, _, err = align_run([seg(0, 0, 900, ["bad"]), seg(1, 1000, 1900, ["bad"])])
    e = error_line(err)
    check(code == 1 and e and e["code"] == "alignment-failed", err)
    check(env is None, "no output written")


@test("out of memory -> alignment-failed for the whole step")
def _():
    def impl(s):
        raise RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB")
    STATE["align_impl"] = impl
    code, env, _, err = align_run([seg(0, 0, 900, ["good"]), seg(1, 1000, 1900, ["x"])])
    e = error_line(err)
    check(code == 1 and e["code"] == "alignment-failed" and "memory" in e["error"], err)


@test("unsupported or missing language -> language-unsupported, nothing loaded")
def _():
    for lang in ("xx", None, ""):
        reset_state()
        code, env, _, err = align_run([seg(0, 0, 900, ["a"])], language=lang)
        e = error_line(err)
        check(code == 1 and e and e["code"] == "language-unsupported", "%r: %s" % (lang, err))
        check(STATE["load_calls"] == [], "no load for %r" % lang)
    check("en" in e["error"] or "language" in e["error"], e["error"])


@test("missing torchaudio checkpoint -> model-not-prepared, no download")
def _():
    code, env, _, err = align_run([seg(0, 0, 900, ["a"])], ready=False)
    e = error_line(err)
    check(code == 1 and e and e["code"] == "model-not-prepared", err)
    check("setup-diarization.py --alignment" in e["error"], e["error"])
    check(EN_FILE in e["error"], "names the missing file")
    check(STATE["load_calls"] == [] and STATE["url_downloads"] == [], "no load, no download")
    check(STATE["nltk_downloads"] == [], "no NLTK download")


@test("Hugging Face model: missing or partial cache -> model-not-prepared; cached -> cache-only load")
def _():
    code, env, _, err = align_run([seg(0, 0, 900, ["hallo"])], language="nl")
    e = error_line(err)
    check(code == 1 and e["code"] == "model-not-prepared" and NL_MODEL in e["error"], err)
    reset_state()
    fill_hf(files=("config.json", "preprocessor_config.json", "vocab.json"))
    code, env, _, err = align_run([seg(0, 0, 900, ["hallo"])], language="nl")
    e = error_line(err)
    check(code == 1 and e["code"] == "model-not-prepared" and "weights" in e["error"], err)
    reset_state()
    fill_hf()
    code, env, _, err = align_run([seg(0, 0, 900, ["hallo"])], language="nl")
    check(code == 0, err)
    check(STATE["load_calls"][0]["cache_only"] is True, "model_cache_only")
    check(env["provider"]["model"] == NL_MODEL and env["provider"]["language"] == "nl", env["provider"])


@test("Hugging Face load error after the cache check -> model-not-prepared")
def _():
    fill_hf()
    STATE["load_error"] = ValueError('The chosen align_model "x" could not be found')
    code, env, _, err = align_run([seg(0, 0, 900, ["hallo"])], language="nl")
    e = error_line(err)
    check(code == 1 and e["code"] == "model-not-prepared", err)


@test("missing punkt_tab -> model-not-prepared before load, no NLTK download")
def _():
    STATE["punkt"] = set()
    code, env, _, err = align_run([seg(0, 0, 900, ["a"])])
    e = error_line(err)
    check(code == 1 and e["code"] == "model-not-prepared" and "punkt_tab" in e["error"], err)
    check(STATE["nltk_downloads"] == [] and STATE["load_calls"] == [], "nothing downloaded or loaded")


@test("nltk.download is replaced: a late punkt miss inside align() never downloads")
def _():
    def impl(s):
        STATE["punkt"].discard("english")   # vanishes after the up-front check
        return default_align_words(s)

    STATE["align_impl"] = impl
    # The stub align() checks punkt before calling impl, so make the first
    # segment remove it and the second trigger WhisperX's download call.
    code, env, _, err = align_run([seg(0, 0, 900, ["a"]), seg(1, 1000, 1900, ["b"])])
    e = error_line(err)
    check(code == 1 and e and e["code"] == "model-not-prepared", err)
    check(STATE["nltk_downloads"] == [], "stub nltk.download was called")
    nltk = sys.modules["nltk"]
    check(nltk.download.__name__ == "_refuse_nltk_download", "nltk.download replaced")
    check(sys.modules["nltk.downloader"].download.__name__ == "_refuse_nltk_download", "downloader replaced")


@test("torch hub download is replaced: a late checkpoint miss never downloads")
def _():
    STATE["load_downloads"] = True
    code, env, _, err = align_run([seg(0, 0, 900, ["a"])])
    e = error_line(err)
    check(code == 1 and e and e["code"] == "model-not-prepared", err)
    check(STATE["url_downloads"] == [], "stub download_url_to_file was called")


@test("whisperx missing / 3.7 / 4.0 / 3.8.6 and Python 3.9 gates")
def _():
    a = load_align()
    check(a.whisperx_problem(None)[0] == "alignment-missing", "missing")
    check(a.whisperx_problem("3.7.4")[0] == "alignment-unsupported", "3.7")
    check(a.whisperx_problem("4.0.0")[0] == "alignment-unsupported", "4.0")
    check(a.whisperx_problem("3.8.6") is None and a.whisperx_problem("3.8.10") is None, "3.8.x")
    check("requirements-alignment.txt" in a.whisperx_problem("3.7.4")[1], "fix names the file")
    check(a.python_problem((3, 9, 18))[0] == "python-unsupported", "3.9")
    check(a.python_problem((3, 10, 0)) is None, "3.10")
    for version, code_want in ((None, "alignment-missing"), ("3.7.4", "alignment-unsupported")):
        reset_state()
        versions = dict(VERSIONS, whisperx=version)
        code, env, _, err = align_run([seg(0, 0, 900, ["a"])], versions=versions)
        e = error_line(err)
        check(code == 1 and e["code"] == code_want, "%s: %s" % (version, err))
        check("whisperx.alignment" not in STATE["env_at_import"], "not imported for %s" % version)
    reset_state()
    a = load_align()
    a.current_version_info = lambda: (3, 9, 18, "final", 0)
    fill_en_checkpoint()
    code, _, err = run_main(a, ["--audio", good_wav(), "--input", write_input([]),
                                "--output", tmp_path("out.json")])
    check(code == 1 and error_line(err)["code"] == "python-unsupported", err)


@test("44.1 kHz, stereo, 8-bit, junk and missing WAVs -> audio-invalid before load")
def _():
    junk = os.path.join(TMP, "junk.wav")
    with open(junk, "wb") as f:
        f.write(b"not a wav file at all")
    cases = [(write_wav("rate.wav", rate=44100), "44100"),
             (write_wav("stereo.wav", channels=2), "2 channels"),
             (write_wav("8bit.wav", width=1), "8-bit"),
             (junk, ""), (os.path.join(TMP, "nope.wav"), "not found")]
    for path, fragment in cases:
        reset_state()
        code, env, _, err = align_run([seg(0, 0, 900, ["a"])], wav=path)
        e = error_line(err)
        check(code == 1 and e and e["code"] == "audio-invalid", "%s: %s" % (path, err))
        check(fragment in e["error"], "%s: %s" % (path, e["error"]))
        check(STATE["load_calls"] == [], "model not loaded")


@test("malformed input JSON -> alignment-failed")
def _():
    a = load_align()
    bad = ['not json', '[]', '{"language": "en", "segments": {}}',
           '{"language": "en", "segments": [{"index": 0, "startMs": 10, "endMs": 5, "words": []}]}',
           '{"language": "en", "segments": [{"index": 0, "startMs": 0, "endMs": 5, "words": [1]}]}',
           '{"language": "en", "segments": [{"index": 0, "startMs": 0, "endMs": 5, "words": []},'
           ' {"index": 0, "startMs": 0, "endMs": 5, "words": []}]}',
           '{"language": "en", "padMs": -1, "segments": []}']
    for raw in bad:
        inp = write_input(None, raw=raw)
        code, _, err = run_main(a, ["--audio", good_wav(), "--input", inp,
                                    "--output", tmp_path("out.json")])
        e = error_line(err)
        check(code == 1 and e and e["code"] == "alignment-failed", "%s: %s" % (raw, err))


# --- Tests: --check -----------------------------------------------------------

section("--check tests")


@test("--check output shape and statuses; no download, no load")
def _():
    a = load_align()
    code, out, _ = run_main(a, ["--check"])
    res = json.loads(out)
    keys = {"status", "message", "language", "versions", "pythonSupported", "alignmentSupported",
            "languageSupported", "cudaAvailable", "model", "modelReady", "modelPath", "punktReady",
            "punktPath", "requirements", "executable"}
    check(set(res) == keys, "keys %s" % sorted(res))
    check(code == 0 and res["status"] == "model-not-prepared" and res["modelReady"] is False, out)
    check(res["punktReady"] is True and res["model"] == {"name": EN_MODEL, "type": "torchaudio"}, res)
    fill_en_checkpoint()
    res = a.check_environment("en")
    check(res["status"] == "ready" and res["modelPath"].endswith(EN_FILE), res)
    check(res["versions"]["whisperx"] == "3.8.6" and res["versions"]["torch"] == "2.8.0+stub", res["versions"])
    check(res["requirements"].endswith("requirements-alignment.txt"), res["requirements"])
    check(a.check_environment("xx")["status"] == "language-unsupported", "xx")
    check(a.check_environment("nl")["status"] == "model-not-prepared", "nl")
    fill_hf()
    check(a.check_environment("NL")["status"] == "ready", "nl cached, case-insensitive")
    STATE["punkt"] = set()
    res = a.check_environment("en")
    check(res["status"] == "model-not-prepared" and res["punktReady"] is False, res)
    check(res["status"] in a.CHECK_STATUSES, "status listed")
    check(STATE["load_calls"] == [] and STATE["url_downloads"] == [] and STATE["nltk_downloads"] == [],
          "nothing loaded or downloaded")


@test("--check without whisperx -> alignment-missing; Python 3.9 -> python-unsupported")
def _():
    a = load_align(dict(VERSIONS, whisperx=None))
    a._whisperx_dir = lambda: None
    res = a.check_environment("en")
    check(res["status"] == "alignment-missing" and res["languageSupported"] is None, res)
    a = load_align()
    res = a.check_environment("en", version_info=(3, 9, 18))
    check(res["status"] == "python-unsupported" and res["pythonSupported"] is False, res)


# --- Tests: setup --alignment -------------------------------------------------

section("Setup --alignment tests")


def load_setup():
    return load_module(SETUP_PATH, "transcriber_setup_test")


def ready_verify_alignment(align, language, environ):
    STATE.setdefault("verify_calls", []).append({"language": language, "env": dict(environ)})
    return {"status": "ready", "message": "ok", "model": {"name": EN_MODEL, "type": "torchaudio"},
            "modelPath": "/hub/checkpoints/" + EN_FILE, "punktPath": "/nltk_data/punkt_tab/english",
            "versions": {"python": "3.12.3", "whisperx": "3.8.6"}}


def ready_verify_speaker(diarize, model, revision, environ):
    return {"status": "ready", "message": "ok", "modelPath": "/hf/snap",
            "versions": {"python": "3.12.3", "pyannote.audio": "4.0.7", "torch": "2.8.0"},
            "cudaAvailable": False}


def run_setup(environ, *argv, align_versions=None, verify=ready_verify_alignment):
    s = load_setup()
    s.verify_alignment = verify
    s.verify_offline = ready_verify_speaker
    d = load_diarize()
    a = load_align(align_versions)
    args = s.build_parser().parse_args(list(argv))
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        summary, code = s.run(args, environ=environ, diarize=d, align=a)
        print(json.dumps(summary))
    return summary, code, out.getvalue(), err.getvalue()


@test("setup: --alignment / --language parsing")
def _():
    s = load_setup()
    p = s.build_parser()
    check(s.alignment_languages(p.parse_args(["--alignment"])) == ["en"], "bare")
    check(s.alignment_languages(p.parse_args(["--alignment", "en, FR,en"])) == ["en", "fr"], "list")
    check(s.alignment_languages(p.parse_args(["--alignment", "--language", "nl"])) == ["nl"], "--language")
    check(p.parse_args([]).alignment is None, "off by default")
    try:
        s.alignment_languages(p.parse_args(["--alignment", "en", "--language", "fr"]))
        raise AssertionError("both accepted")
    except s.SetupError as e:
        check(e.code == "bad-arguments", e.code)
    summary, code, _, _ = run_setup({}, "--language", "fr")
    check(code == 1 and summary["status"] == "bad-arguments", summary)
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        try:
            p.parse_args(["--alignment", "--hf-token", SECRET])
            raise AssertionError("token accepted")
        except SystemExit as e:
            check(e.code == 2, "exit %s" % e.code)
    check(SECRET not in err.getvalue(), "token echoed")


@test("setup: speaker model already prepared, no token -> alignment only, ready")
def _():
    fill_speaker()
    # The real process environment, so the import hook sees what the stubs see.
    for name in TOKEN_VARS:
        os.environ.pop(name, None)
    os.environ.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
                       "HF_HUB_DISABLE_TELEMETRY": "0"})
    environ = os.environ
    STATE["punkt"] = set()
    summary, code, out, err = run_setup(environ, "--alignment")
    check(code == 0 and summary["status"] == "ready", "%s %s" % (summary, err))
    check(summary["speaker"]["status"] == "ready" and summary["speaker"]["action"] == "already-prepared",
          summary["speaker"])
    check(STATE["snapshot_calls"] == [], "speaker model not downloaded again")
    check(summary["alignment"]["status"] == "ready" and summary["alignment"]["languages"] == ["en"],
          summary["alignment"])
    check(summary["alignment"]["results"][0]["modelPath"].endswith(EN_FILE), "cache path reported")
    check(len(STATE["nltk_downloads"]) == 1 and STATE["nltk_downloads"][0]["package"] == "punkt_tab",
          "punkt downloaded")
    check(STATE["nltk_downloads"][0]["offline"] is None, "network allowed for punkt")
    load = STATE["load_calls"][0]
    check(load["language"] == "en" and load["device"] == "cpu" and load["cache_only"] is False, load)
    check(load["offline"] is None, "network allowed for the model")
    check(len(STATE["url_downloads"]) == 1, "checkpoint fetched once")
    for name in ("whisperx.alignment", "huggingface_hub"):
        env_at = STATE["env_at_import"].get(name)
        check(env_at and env_at["HF_HUB_OFFLINE"] is None and env_at["TRANSFORMERS_OFFLINE"] is None,
              "%s imported with %s" % (name, env_at))
        check(env_at["HF_HUB_DISABLE_TELEMETRY"] == "1", "telemetry off")
    check("HF_HUB_OFFLINE" not in environ and "TRANSFORMERS_OFFLINE" not in environ, "env cleared")
    check(STATE["verify_calls"][0]["language"] == "en", "verified")
    check("stdout noise" not in out.splitlines()[-1], "summary line clean")
    json.loads(out.strip().splitlines()[-1])


@test("setup: assets already present -> no punkt or checkpoint download")
def _():
    fill_speaker()
    fill_en_checkpoint()
    summary, code, _, err = run_setup({}, "--alignment")
    check(code == 0 and summary["status"] == "ready", err)
    check(STATE["nltk_downloads"] == [] and STATE["url_downloads"] == [], "nothing re-downloaded")
    check(len(STATE["load_calls"]) == 1, "model still loaded once to prove it reads")


@test("setup: speaker model not prepared and no token -> speaker token-missing, alignment still ready")
def _():
    summary, code, out, err = run_setup({}, "--alignment")
    check(code == 1, "exit 1 while a part is not ready")
    check(summary["status"] == "token-missing", summary["status"])
    check(summary["speaker"]["status"] == "token-missing" and summary["speaker"]["action"] == "failed",
          summary["speaker"])
    check(summary["alignment"]["status"] == "ready", summary["alignment"])
    check(STATE["snapshot_calls"] == [], "no speaker download without a token")
    check(error_line(err)["code"] == "token-missing", err)


@test("setup: speaker model not prepared, token set -> both prepared; token never printed")
def _():
    environ = {"HF_TOKEN": SECRET}
    summary, code, out, err = run_setup(environ, "--alignment", "en,nl")
    check(code == 0 and summary["status"] == "ready", "%s %s" % (summary, err))
    check(summary["speaker"]["action"] == "prepared", summary["speaker"])
    check(STATE["snapshot_calls"][0]["token"] == SECRET, "speaker download used the token")
    check([c["language"] for c in STATE["verify_calls"]] == ["en", "nl"], "both languages verified")
    check(any(c["language"] == "nl" for c in STATE["load_calls"]), "nl model fetched")
    check(SECRET not in out and SECRET not in err, "token printed")


@test("setup: whisperx missing -> alignment-missing; speaker part unaffected")
def _():
    fill_speaker()
    summary, code, _, err = run_setup({}, "--alignment", align_versions=dict(VERSIONS, whisperx=None))
    check(code == 1 and summary["alignment"]["status"] == "alignment-missing", summary)
    check(summary["speaker"]["status"] == "ready", summary["speaker"])
    check("requirements-alignment.txt" in summary["alignment"]["message"], summary["alignment"]["message"])
    check(STATE["nltk_downloads"] == [] and STATE["load_calls"] == [], "nothing downloaded")


@test("setup: unsupported language stops before any download")
def _():
    fill_speaker()
    STATE["punkt"] = set()
    summary, code, _, err = run_setup({}, "--alignment", "en,xx")
    check(code == 1 and summary["alignment"]["status"] == "language-unsupported", summary)
    check(STATE["nltk_downloads"] == [] and STATE["load_calls"] == [], "nothing downloaded")


@test("setup: network failure while fetching the model -> network-error")
def _():
    fill_speaker()

    class URLError(OSError):
        pass

    STATE["load_error"] = URLError("<urlopen error [Errno -3] Temporary failure in name resolution>")
    summary, code, _, err = run_setup({}, "--alignment")
    check(code == 1 and summary["alignment"]["status"] == "network-error", summary["alignment"])


@test("setup: failed offline alignment check is reported")
def _():
    fill_speaker()

    def bad_verify(align, language, environ):
        return {"status": "model-not-prepared", "message": "still missing"}
    summary, code, _, err = run_setup({}, "--alignment", verify=bad_verify)
    check(code == 1 and summary["alignment"]["status"] == "verify-failed", summary)
    check("still missing" in summary["alignment"]["message"], summary["alignment"]["message"])


@test("setup: offline alignment check runs align.py --check --language offline without the token")
def _():
    s = load_setup()
    a = load_align()
    seen = {}

    def fake_run(cmd, env=None, **kwargs):
        seen["cmd"], seen["env"] = cmd, env
        return subprocess.CompletedProcess(cmd, 0, stdout='noise\n{"status": "ready"}\n', stderr="")

    s.subprocess = types.SimpleNamespace(run=fake_run, PIPE=subprocess.PIPE)
    result = s.verify_alignment(a, "fr", {"HF_TOKEN": SECRET, "HUGGING_FACE_HUB_TOKEN": SECRET,
                                          "PATH": "/bin"})
    check(result == {"status": "ready"}, result)
    check(seen["cmd"][1] == ALIGN_PATH and seen["cmd"][2:] == ["--check", "--language", "fr"], seen["cmd"])
    check(seen["env"]["HF_HUB_OFFLINE"] == "1" and seen["env"]["TRANSFORMERS_OFFLINE"] == "1", "offline")
    check(not any(v in seen["env"] for v in TOKEN_VARS), "token removed from child env")


@test("setup --check --alignment reports both parts without downloading")
def _():
    summary, code, _, _ = run_setup({"HF_TOKEN": SECRET}, "--check", "--alignment", "en,nl")
    check(code == 0 and summary["speaker"]["status"] == "model-not-prepared", summary)
    statuses = [(r["language"], r["status"]) for r in summary["alignment"]["results"]]
    check(statuses == [("en", "model-not-prepared"), ("nl", "model-not-prepared")], statuses)
    fill_speaker()
    fill_en_checkpoint()
    fill_hf()
    summary, code, _, _ = run_setup({}, "--check", "--alignment", "en,nl")
    check(code == 0 and summary["status"] == "ready", summary)
    check(STATE["snapshot_calls"] == [] and STATE["load_calls"] == [] and
          STATE["nltk_downloads"] == [] and STATE["url_downloads"] == [], "nothing downloaded")


@test("setup without --alignment keeps the original summary shape")
def _():
    summary, code, _, _ = run_setup({}, "--check")
    check(set(summary) == {"status", "message", "model", "cachePath", "versions", "cudaAvailable"},
          sorted(summary))


# ---------------------------------------------------------------------------

run_all()
