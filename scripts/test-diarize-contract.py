#!/usr/bin/env python3
"""Contract tests for lib/diarize.py and scripts/setup-diarization.py.

Runs with a plain Python: torch, pyannote.audio and huggingface_hub are not
needed. An import hook supplies stub versions of them (and of numpy, if it
is not installed) and records the environment at the moment each one is
imported. Nothing is downloaded and no real model is loaded.

Covers: telemetry/offline variables set before import, the result envelope,
missing exclusive timeline, Python and pyannote version gates, offline
cache misses, WAV validation, --check, token handling in diarize.py and in
the setup helper.

Usage:
    python3 scripts/test-diarize-contract.py
"""

import contextlib
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
DIARIZE_PATH = os.path.join(ROOT, "lib", "diarize.py")
SETUP_PATH = os.path.join(ROOT, "scripts", "setup-diarization.py")

MODEL = "pyannote/speaker-diarization-community-1"
REVISION = "3533c8cf8e369892e6b79ff1bf80f7b0286a54ee"
WATCHED_ENV = ("PYANNOTE_METRICS_ENABLED", "HF_HUB_OFFLINE", "HF_HUB_DISABLE_TELEMETRY")
TOKEN_VARS = ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN")
SECRET = "hf_TESTSECRET0123456789"

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


TMP = tempfile.mkdtemp(prefix="diarize-contract-")


def write_wav(name, rate=16000, channels=1, width=2, seconds=0.5):
    path = os.path.join(TMP, name)
    frames = int(rate * seconds)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(width)
        wf.setframerate(rate)
        if width == 1:
            sample = b"\x80"
        else:
            sample = struct.pack("<h", 1000)
        wf.writeframes(sample * channels * frames)
    return path


# --- Stub modules -----------------------------------------------------------

STATE = {}


def reset_state():
    STATE.clear()
    STATE.update({
        "pyannote_version": "4.0.7",
        "pyannote_importable": True,
        "pipeline_mode": "ok",          # ok | cache-miss | wrapped-miss | none | error
        "exclusive_mode": "present",    # present | absent | none
        "cuda": False,
        "env_at_import": {},
        "from_pretrained_calls": [],
        "pipeline_calls": [],
        "to_calls": [],
        "snapshot_calls": [],
        "download_calls": [],
        "cache": set(),
        "snapshot_error": None,         # (class name, message, status) or None
    })
    for name in list(sys.modules):
        if name in STUBS or name.startswith("transcriber_"):
            del sys.modules[name]


class Segment(object):
    def __init__(self, start, end):
        self.start = start
        self.end = end


class FakeAnnotation(object):
    def __init__(self, tracks):
        self.tracks = tracks

    def itertracks(self, yield_label=False):
        for start, end, label in self.tracks:
            yield Segment(start, end), "_", label


REGULAR = [(0.0, 1.23456, "SPEAKER_00"), (1.0, 2.5, "SPEAKER_01")]
EXCLUSIVE = [(0.0, 1.0, "SPEAKER_00"), (1.0, 2.5, "SPEAKER_01")]


class FakeOutput(object):
    def __init__(self):
        self.speaker_diarization = FakeAnnotation(REGULAR)
        mode = STATE["exclusive_mode"]
        if mode == "present":
            self.exclusive_speaker_diarization = FakeAnnotation(EXCLUSIVE)
        elif mode == "none":
            self.exclusive_speaker_diarization = None


class FakePipeline(object):
    def to(self, device):
        STATE["to_calls"].append(device)
        return self

    def __call__(self, file, **params):
        STATE["pipeline_calls"].append({"file": file, "params": params})
        return FakeOutput()


def build_hub(m):
    class HfHubHTTPError(Exception):
        def __init__(self, message="", response=None):
            Exception.__init__(self, message)
            self.response = response

    class EntryNotFoundError(HfHubHTTPError):
        pass

    class LocalEntryNotFoundError(EntryNotFoundError, FileNotFoundError):
        pass

    class RepositoryNotFoundError(HfHubHTTPError):
        pass

    class GatedRepoError(RepositoryNotFoundError):
        pass

    class OfflineModeIsEnabled(ConnectionError):
        pass

    for klass in (HfHubHTTPError, EntryNotFoundError, LocalEntryNotFoundError,
                  RepositoryNotFoundError, GatedRepoError, OfflineModeIsEnabled):
        setattr(m, klass.__name__, klass)

    def try_to_load_from_cache(repo_id, filename, cache_dir=None, revision=None, repo_type=None):
        if (repo_id, revision, filename) in STATE["cache"]:
            return "/cache/models--%s/snapshots/%s/%s" % (repo_id.replace("/", "--"), revision, filename)
        return None

    def snapshot_download(repo_id, revision=None, token=None, **kwargs):
        STATE["snapshot_calls"].append({
            "repo_id": repo_id, "revision": revision, "token": token,
            "offline": os.environ.get("HF_HUB_OFFLINE"),
        })
        if STATE["snapshot_error"]:
            name, message, status = STATE["snapshot_error"]
            klass = getattr(m, name, None) or getattr(__builtins__, name, None) or ConnectionError
            response = types.SimpleNamespace(status_code=status) if status else None
            if issubclass(klass, HfHubHTTPError):
                raise klass(message, response=response)
            raise klass(message)
        return "/cache/models--%s/snapshots/%s" % (repo_id.replace("/", "--"), revision)

    def hf_hub_download(*args, **kwargs):
        STATE["download_calls"].append((args, kwargs))
        raise AssertionError("hf_hub_download must not be called")

    m.try_to_load_from_cache = try_to_load_from_cache
    m.snapshot_download = snapshot_download
    m.hf_hub_download = hf_hub_download


def build_pyannote(m):
    pass


def build_pyannote_audio(m):
    if not STATE["pyannote_importable"]:
        raise ImportError("No module named 'pyannote.audio' (stub)")
    m.__version__ = STATE["pyannote_version"]

    class Pipeline(object):
        @classmethod
        def from_pretrained(cls, checkpoint, revision=None, hparams_file=None,
                            subfolder=None, token=None, cache_dir=None):
            STATE["from_pretrained_calls"].append({
                "checkpoint": checkpoint, "revision": revision, "token": token,
                "offline": os.environ.get("HF_HUB_OFFLINE"),
            })
            mode = STATE["pipeline_mode"]
            hub = importlib.import_module("huggingface_hub")
            if mode == "cache-miss":
                print("Could not download Pipeline ... token='hf_....'")  # pyannote's stdout hint
                raise hub.LocalEntryNotFoundError("Cannot find the requested files in the disk cache")
            if mode == "wrapped-miss":
                try:
                    raise hub.LocalEntryNotFoundError("not cached")
                except Exception as inner:
                    raise RuntimeError("load failed") from inner
            if mode == "none":
                return None
            if mode == "error":
                raise RuntimeError("weights are damaged")
            return FakePipeline()

    m.Pipeline = Pipeline


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
    m.device = lambda name: ("device", name)
    m.from_numpy = FakeTensor


STUBS = {
    "pyannote": build_pyannote,
    "pyannote.audio": build_pyannote_audio,
    "torch": build_torch,
    "huggingface_hub": build_hub,
}

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
                fullname, self, is_package=fullname in ("pyannote",))
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


def load_diarize(versions=None):
    d = load_module(DIARIZE_PATH, "transcriber_diarize_test")
    d.SCRIPT_PATH = DIARIZE_PATH
    if versions is not None:
        d.package_version = lambda name: versions.get(name)
    return d


def load_setup():
    return load_module(SETUP_PATH, "transcriber_setup_test")


def run_main(d, argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = d.main(argv)
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


def diarize_args(audio, output, *extra):
    return ["--audio", audio, "--output", output] + list(extra)


def fill_cache(files=None):
    d_files = files if files is not None else (
        "config.yaml", "segmentation/pytorch_model.bin", "embedding/pytorch_model.bin",
        "plda/xvec_transform.npz", "plda/plda.npz")
    for f in d_files:
        STATE["cache"].add((MODEL, REVISION, f))


GOOD_WAV = None


def good_wav():
    global GOOD_WAV
    if GOOD_WAV is None:
        GOOD_WAV = write_wav("good.wav")
    return GOOD_WAV


def out_path(name="out.json"):
    p = os.path.join(TMP, name)
    if os.path.exists(p):
        os.remove(p)
    return p


# --- Tests: environment and imports -----------------------------------------

section("Environment tests")


@test("importing lib/diarize.py imports no heavy modules")
def _():
    load_diarize()
    check(STATE["env_at_import"] == {}, "imported: %s" % list(STATE["env_at_import"]))


@test("inference sets telemetry off and offline mode before pyannote/torch import")
def _():
    os.environ["PYANNOTE_METRICS_ENABLED"] = "true"   # must be overridden
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "0"
    os.environ.pop("HF_HUB_OFFLINE", None)
    d = load_diarize()
    code, _, err = run_main(d, diarize_args(good_wav(), out_path()))
    check(code == 0, "exit %s: %s" % (code, err))
    expected = {"PYANNOTE_METRICS_ENABLED": "false", "HF_HUB_OFFLINE": "1",
                "HF_HUB_DISABLE_TELEMETRY": "1"}
    for name in ("pyannote.audio", "torch"):
        check(STATE["env_at_import"].get(name) == expected,
              "%s imported with %s" % (name, STATE["env_at_import"].get(name)))
    check(STATE["from_pretrained_calls"][0]["offline"] == "1", "offline during load")


@test("--check sets the same variables before huggingface_hub/torch import")
def _():
    os.environ.pop("PYANNOTE_METRICS_ENABLED", None)
    d = load_diarize({"pyannote.audio": "4.0.7"})
    code, out, _ = run_main(d, ["--check"])
    check(code == 0, "exit %s" % code)
    expected = {"PYANNOTE_METRICS_ENABLED": "false", "HF_HUB_OFFLINE": "1",
                "HF_HUB_DISABLE_TELEMETRY": "1"}
    for name in ("huggingface_hub", "torch"):
        check(STATE["env_at_import"].get(name) == expected,
              "%s imported with %s" % (name, STATE["env_at_import"].get(name)))
    check("pyannote.audio" not in STATE["env_at_import"], "--check should not import pyannote")


# --- Tests: envelope --------------------------------------------------------

section("Envelope tests")


@test("envelope has every field and both timelines")
def _():
    d = load_diarize()
    path = out_path()
    code, out, err = run_main(d, diarize_args(good_wav(), path, "--num-speakers", "2"))
    check(code == 0, "exit %s: %s" % (code, err))
    env = json.load(open(path, encoding="utf-8"))
    for key in ("format", "version", "regular", "exclusive", "exclusiveAvailable", "model",
                "versions", "device", "numSpeakersRequested", "audio", "processingSec"):
        check(key in env, "missing %s" % key)
    check(env["format"] == "transcriber-diarization" and env["version"] == 1, "format/version")
    check(env["regular"][0] == {"start": 0.0, "end": 1.235, "speaker": "SPEAKER_00"},
          "regular[0] %s" % env["regular"][0])
    check(len(env["regular"]) == 2 and len(env["exclusive"]) == 2, "both timelines")
    check(env["exclusive"][0]["end"] == 1.0, "exclusive kept separate")
    check(env["exclusiveAvailable"] is True, "exclusiveAvailable")
    check(env["model"] == {"id": MODEL, "revision": REVISION}, "model %s" % env["model"])
    check(set(env["versions"]) == {"python", "pyannote.audio", "torch"}, "versions keys")
    check(env["versions"]["pyannote.audio"] == "4.0.7", "pyannote version")
    check(env["device"] == "cpu", "device")
    check(env["numSpeakersRequested"] == 2, "numSpeakersRequested")
    check(env["audio"] == {"sampleRate": 16000, "channels": 1, "durationSec": 0.5},
          "audio %s" % env["audio"])
    check(isinstance(env["processingSec"], (int, float)), "processingSec")
    call = STATE["pipeline_calls"][0]
    check(call["params"] == {"num_speakers": 2}, "params %s" % call["params"])
    check(call["file"]["sample_rate"] == 16000, "sample_rate")
    check(call["file"]["waveform"].shape == (1, 8000), "waveform shape")
    summary = json.loads(out.strip().splitlines()[-1])
    check(summary == {"segments": 2, "exclusiveSegments": 2}, "stdout %s" % summary)
    progress = [json.loads(l) for l in err.splitlines() if l.startswith("{")]
    check(all("message" in p for p in progress), "progress lines keep message")
    check(any(p.get("percent") == 100 for p in progress), "Done line")


@test("numSpeakersRequested is null when not given; CUDA used when available")
def _():
    STATE["cuda"] = True
    d = load_diarize()
    path = out_path()
    code, _, err = run_main(d, diarize_args(good_wav(), path))
    check(code == 0, err)
    env = json.load(open(path, encoding="utf-8"))
    check(env["numSpeakersRequested"] is None, "null")
    check(STATE["pipeline_calls"][0]["params"] == {}, "no params")
    check(env["device"] == "cuda", "device cuda")
    check(STATE["to_calls"] == [("device", "cuda")], "moved to cuda")


@test("missing exclusive timeline -> exclusive null, exclusiveAvailable false")
def _():
    for mode in ("absent", "none"):
        reset_state()
        STATE["exclusive_mode"] = mode
        d = load_diarize()
        path = out_path()
        code, out, err = run_main(d, diarize_args(good_wav(), path))
        check(code == 0, err)
        env = json.load(open(path, encoding="utf-8"))
        check(env["exclusive"] is None, "%s: exclusive should be null" % mode)
        check(env["exclusiveAvailable"] is False, "%s: exclusiveAvailable false" % mode)
        check(len(env["regular"]) == 2, "regular still present")
        check(json.loads(out.strip().splitlines()[-1])["exclusiveSegments"] is None, "stdout null")


# --- Tests: version gates ---------------------------------------------------

section("Version gate tests")


@test("Python 3.9 rejected, 3.10 and 3.13 accepted")
def _():
    d = load_diarize()
    check(d.python_problem((3, 9, 18))[0] == "python-unsupported", "3.9")
    check(d.python_problem((3, 10, 0)) is None, "3.10")
    check(d.python_problem((3, 13, 1)) is None, "3.13")
    res = d.check_environment(version_info=(3, 9, 18))
    check(res["status"] == "python-unsupported", res["status"])
    check(res["pythonSupported"] is False and res["versions"]["python"] == "3.9.18", "fields")


@test("inference on Python 3.9 fails with python-unsupported before importing pyannote")
def _():
    d = load_diarize()
    d.current_version_info = lambda: (3, 9, 18, "final", 0)
    code, _, err = run_main(d, diarize_args(good_wav(), out_path()))
    e = error_line(err)
    check(code == 1 and e and e["code"] == "python-unsupported", err)
    check("pyannote.audio" not in STATE["env_at_import"], "pyannote not imported")


@test("pyannote 3.1.1 and 5.0.0 rejected, 4.0.7 accepted")
def _():
    d = load_diarize()
    check(d.pyannote_problem("3.1.1")[0] == "pyannote-unsupported", "3.1.1")
    check(d.pyannote_problem("5.0.0")[0] == "pyannote-unsupported", "5.0.0")
    check(d.pyannote_problem("4.0.7") is None, "4.0.7")
    check(d.pyannote_problem(None)[0] == "pyannote-missing", "None")
    for version, ok in (("3.1.1", False), ("5.0.0", False), ("4.0.7", True)):
        reset_state()
        STATE["pyannote_version"] = version
        d = load_diarize()
        code, _, err = run_main(d, diarize_args(good_wav(), out_path()))
        if ok:
            check(code == 0, "%s should pass: %s" % (version, err))
        else:
            e = error_line(err)
            check(code == 1 and e["code"] == "pyannote-unsupported", "%s: %s" % (version, err))
            check("pip install -r" in e["error"] and "requirements.txt" in e["error"],
                  "fix in message: %s" % e["error"])
            check(STATE["from_pretrained_calls"] == [], "no model load for %s" % version)


@test("--check distinguishes pyannote missing from unsupported")
def _():
    d = load_diarize({"pyannote.audio": None})
    check(d.check_environment()["status"] == "pyannote-missing", "missing")
    d = load_diarize({"pyannote.audio": "3.1.1"})
    res = d.check_environment()
    check(res["status"] == "pyannote-unsupported", res["status"])
    check(res["versions"]["pyannote.audio"] == "3.1.1" and res["pyannoteSupported"] is False, "fields")


@test("pyannote not importable -> pyannote-missing")
def _():
    STATE["pyannote_importable"] = False
    d = load_diarize()
    code, _, err = run_main(d, diarize_args(good_wav(), out_path()))
    e = error_line(err)
    check(code == 1 and e and e["code"] == "pyannote-missing", err)


# --- Tests: offline model ---------------------------------------------------

section("Offline model tests")


@test("offline cache miss -> model-not-prepared, no download, no token")
def _():
    for mode in ("cache-miss", "wrapped-miss", "none"):
        reset_state()
        STATE["pipeline_mode"] = mode
        d = load_diarize()
        path = out_path()
        code, out, err = run_main(d, diarize_args(good_wav(), path))
        e = error_line(err)
        check(code == 1 and e and e["code"] == "model-not-prepared", "%s: %s" % (mode, err))
        check("setup-diarization.py" in e["error"], "names the setup script")
        check(STATE["snapshot_calls"] == [] and STATE["download_calls"] == [], "no download")
        call = STATE["from_pretrained_calls"][0]
        check(call == {"checkpoint": MODEL, "revision": REVISION, "token": None, "offline": "1"},
              "from_pretrained %s" % call)
        check(not os.path.exists(path), "no output written")
        check("Could not download" not in out + err, "pyannote's token hint suppressed")


@test("other load failure -> diarization-failed")
def _():
    STATE["pipeline_mode"] = "error"
    d = load_diarize()
    code, _, err = run_main(d, diarize_args(good_wav(), out_path()))
    e = error_line(err)
    check(code == 1 and e["code"] == "diarization-failed", err)


@test("--model/--revision are passed through for evaluation")
def _():
    d = load_diarize()
    code, _, err = run_main(d, diarize_args(good_wav(), out_path(), "--model",
                                            "pyannote/speaker-diarization-3.1", "--revision", "abc"))
    check(code == 0, err)
    call = STATE["from_pretrained_calls"][0]
    check(call["checkpoint"] == "pyannote/speaker-diarization-3.1" and call["revision"] == "abc", call)


@test("--check: empty, partial and full cache; no download and no audio")
def _():
    d = load_diarize({"pyannote.audio": "4.0.7"})
    code, out, _ = run_main(d, ["--check"])
    res = json.loads(out)
    check(code == 0 and res["status"] == "model-not-prepared" and res["modelReady"] is False, out)
    fill_cache(["config.yaml", "segmentation/pytorch_model.bin", "embedding/pytorch_model.bin",
                "plda/xvec_transform.npz"])
    res = d.check_environment()
    check(res["status"] == "model-not-prepared" and "plda/plda.npz" in res["message"], res["message"])
    fill_cache()
    res = d.check_environment()
    check(res["status"] == "ready" and res["modelReady"] is True, res)
    check(res["modelPath"].endswith(REVISION), res["modelPath"])
    check(res["model"] == {"id": MODEL, "revision": REVISION}, "model")
    check(res["loadChecked"] is False, "no load without --load")
    check(STATE["from_pretrained_calls"] == [] and STATE["pipeline_calls"] == [], "nothing loaded")
    check(STATE["snapshot_calls"] == [] and STATE["download_calls"] == [], "no download")


@test("--check output has the documented shape")
def _():
    fill_cache()
    STATE["cuda"] = True
    d = load_diarize({"pyannote.audio": "4.0.7"})
    code, out, _ = run_main(d, ["--check"])
    res = json.loads(out)
    keys = {"status", "message", "versions", "pythonSupported", "pyannoteSupported",
            "cudaAvailable", "model", "modelReady", "modelPath", "loadChecked",
            "requirements", "executable"}
    check(set(res) == keys, "keys %s" % sorted(res))
    check(res["status"] in d.CHECK_STATUSES, res["status"])
    check(res["versions"]["torch"] == "2.8.0+stub" and res["cudaAvailable"] is True, "torch fields")


@test("--check --load loads offline; a cache miss there is model-not-prepared")
def _():
    fill_cache()
    d = load_diarize({"pyannote.audio": "4.0.7"})
    res = d.check_environment(load=True)
    check(res["status"] == "ready" and res["loadChecked"] is True, res)
    STATE["pipeline_mode"] = "cache-miss"
    res = d.check_environment(load=True)
    check(res["status"] == "model-not-prepared" and res["modelReady"] is False, res)


# --- Tests: WAV validation --------------------------------------------------

section("WAV validation tests")


@test("44.1 kHz, stereo and 8-bit WAVs -> audio-invalid before model load")
def _():
    cases = [
        ("rate.wav", dict(rate=44100), "44100"),
        ("stereo.wav", dict(channels=2), "2 channels"),
        ("8bit.wav", dict(width=1), "8-bit"),
    ]
    for name, kwargs, fragment in cases:
        reset_state()
        d = load_diarize()
        code, _, err = run_main(d, diarize_args(write_wav(name, **kwargs), out_path()))
        e = error_line(err)
        check(code == 1 and e and e["code"] == "audio-invalid", "%s: %s" % (name, err))
        check(fragment in e["error"], "%s: %s" % (name, e["error"]))
        check(STATE["from_pretrained_calls"] == [], "%s: model not loaded" % name)


@test("missing and non-WAV files -> audio-invalid")
def _():
    junk = os.path.join(TMP, "junk.wav")
    with open(junk, "wb") as f:
        f.write(b"not a wav file at all")
    for path in (os.path.join(TMP, "nope.wav"), junk):
        reset_state()
        d = load_diarize()
        code, _, err = run_main(d, diarize_args(path, out_path()))
        e = error_line(err)
        check(code == 1 and e and e["code"] == "audio-invalid", err)


# --- Tests: token handling --------------------------------------------------

section("Token handling tests")


@test("diarize.py accepts --hf-token but never uses or prints it")
def _():
    for mode in ("ok", "cache-miss"):
        reset_state()
        STATE["pipeline_mode"] = mode
        d = load_diarize()
        path = out_path()
        code, out, err = run_main(d, diarize_args(good_wav(), path, "--hf-token", SECRET))
        check(code == (0 if mode == "ok" else 1), "%s: exit %s %s" % (mode, code, err))
        check(SECRET not in out and SECRET not in err, "%s: token printed" % mode)
        if os.path.exists(path):
            check(SECRET not in open(path, encoding="utf-8").read(), "token in output file")
        check(STATE["from_pretrained_calls"][0]["token"] is None, "token passed to pyannote")


def setup_args(*argv):
    return load_setup().build_parser().parse_args(list(argv))


def run_setup(environ, *argv, verify=None, versions=None):
    s = load_setup()
    d = load_diarize(versions or {"pyannote.audio": "4.0.7", "torch": "2.8.0"})
    if verify is not None:
        s.verify_offline = verify
    args = s.build_parser().parse_args(list(argv))
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        summary, code = s.run(args, environ=environ, diarize=d)
        print(json.dumps(summary))
    return summary, code, out.getvalue(), err.getvalue()


def ready_verify(diarize, model, revision, environ):
    return {"status": "ready", "message": "ok", "modelPath": "/cache/snap",
            "versions": {"python": "3.12.3", "pyannote.audio": "4.0.7", "torch": "2.8.0"},
            "cudaAvailable": False}


@test("setup: missing token is a clear error and makes no network call")
def _():
    summary, code, out, err = run_setup({}, verify=ready_verify)
    check(code == 1 and summary["status"] == "token-missing", summary)
    e = error_line(err)
    check(e["code"] == "token-missing", err)
    check("https://hf.co/pyannote/speaker-diarization-community-1" in e["error"], "licence link")
    check("HF_TOKEN" in e["error"], "names HF_TOKEN")
    check(STATE["snapshot_calls"] == [], "no download attempted")


@test("setup: token read from HF_TOKEN or HUGGING_FACE_HUB_TOKEN, never printed")
def _():
    for var in TOKEN_VARS:
        reset_state()
        summary, code, out, err = run_setup({var: SECRET}, verify=ready_verify)
        check(code == 0 and summary["status"] == "ready", "%s: %s %s" % (var, summary, err))
        call = STATE["snapshot_calls"][0]
        check(call["token"] == SECRET and call["repo_id"] == MODEL and call["revision"] == REVISION,
              "snapshot call %s" % dict(call, token="<hidden>"))
        check(call["offline"] is None, "network allowed during download")
        check(SECRET not in out and SECRET not in err, "%s: token printed" % var)
        check(summary["cachePath"] == "/cache/snap", "cache path")
        check(summary["model"] == {"id": MODEL, "revision": REVISION}, "model")
        check(summary["versions"]["pyannote.audio"] == "4.0.7", "versions")


@test("setup: telemetry off during download")
def _():
    environ = {"HF_TOKEN": SECRET, "HF_HUB_OFFLINE": "1", "PYANNOTE_METRICS_ENABLED": "true"}
    run_setup(environ, verify=ready_verify)
    check(environ["PYANNOTE_METRICS_ENABLED"] == "false", "metrics forced off")
    check(environ["HF_HUB_DISABLE_TELEMETRY"] == "1", "hub telemetry off")
    check("HF_HUB_OFFLINE" not in environ, "offline removed for the explicit download")


@test("setup: token is not accepted on the command line; --alignment is not available yet")
def _():
    s = load_setup()
    for argv in (["--hf-token", SECRET], ["--alignment"], ["--alignment", "wav2vec2"]):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            try:
                s.build_parser().parse_args(argv)
                raise AssertionError("%s accepted" % argv)
            except SystemExit as e:
                check(e.code == 2, "exit code %s" % e.code)
        check(SECRET not in err.getvalue(), "token echoed: %s" % err.getvalue())
        if argv[0] == "--alignment":
            check("not available yet" in err.getvalue(), err.getvalue())


@test("setup: gated / 401 / 403 errors explain the licence and hide the token")
def _():
    cases = [
        ("GatedRepoError", "Access to model is restricted for " + SECRET, None),
        ("HfHubHTTPError", "401 Client Error", 401),
        ("HfHubHTTPError", "403 Client Error", 403),
        ("RepositoryNotFoundError", "404 Repository Not Found", 404),
    ]
    for name, message, status in cases:
        reset_state()
        STATE["snapshot_error"] = (name, message, status)
        summary, code, out, err = run_setup({"HF_TOKEN": SECRET}, verify=ready_verify)
        check(code == 1 and summary["status"] == "model-access-denied", "%s: %s" % (name, summary))
        e = error_line(err)
        check("https://hf.co/pyannote/speaker-diarization-community-1" in e["error"], "licence link")
        check(SECRET not in out and SECRET not in err, "%s: token printed" % name)


@test("setup: network failures are reported as network-error")
def _():
    for name in ("ConnectionError", "OfflineModeIsEnabled", "LocalEntryNotFoundError"):
        reset_state()
        STATE["snapshot_error"] = (name, "connection refused", None)
        summary, code, _, err = run_setup({"HF_TOKEN": SECRET}, verify=ready_verify)
        check(code == 1 and summary["status"] == "network-error", "%s: %s" % (name, summary))


@test("setup: unsupported pyannote stops before download")
def _():
    summary, code, _, err = run_setup({"HF_TOKEN": SECRET}, verify=ready_verify,
                                      versions={"pyannote.audio": "3.1.1"})
    check(code == 1 and summary["status"] == "pyannote-unsupported", summary)
    check(STATE["snapshot_calls"] == [], "no download")


@test("setup: failed offline verification is reported")
def _():
    def bad_verify(*a):
        return {"status": "model-not-prepared", "message": "still missing"}
    summary, code, _, err = run_setup({"HF_TOKEN": SECRET}, verify=bad_verify)
    check(code == 1 and summary["status"] == "verify-failed", summary)
    check("still missing" in error_line(err)["error"], err)


@test("setup: offline verification runs diarize.py --check --load offline without the token")
def _():
    s = load_setup()
    d = load_diarize()
    d.SCRIPT_PATH = DIARIZE_PATH
    seen = {}

    def fake_run(cmd, env=None, **kwargs):
        seen["cmd"] = cmd
        seen["env"] = env
        return subprocess.CompletedProcess(cmd, 0, stdout='noise\n{"status": "ready"}\n', stderr="")

    s.subprocess = types.SimpleNamespace(run=fake_run, PIPE=subprocess.PIPE)
    result = s.verify_offline(d, MODEL, REVISION, {"HF_TOKEN": SECRET, "HUGGING_FACE_HUB_TOKEN": SECRET, "PATH": "/bin"})
    check(result == {"status": "ready"}, result)
    check(seen["cmd"][1] == DIARIZE_PATH and "--check" in seen["cmd"] and "--load" in seen["cmd"], seen["cmd"])
    check(seen["cmd"][seen["cmd"].index("--revision") + 1] == REVISION, "revision passed")
    check(seen["env"]["HF_HUB_OFFLINE"] == "1", "offline")
    check(not any(v in seen["env"] for v in TOKEN_VARS), "token removed from child env")
    check(SECRET not in json.dumps(seen["cmd"]), "token not in argv")


@test("setup --check reports readiness without downloading")
def _():
    summary, code, _, _ = run_setup({"HF_TOKEN": SECRET}, "--check", verify=ready_verify)
    check(code == 0 and summary["status"] == "model-not-prepared", summary)
    check(STATE["snapshot_calls"] == [], "no download")
    fill_cache()
    summary, code, _, _ = run_setup({}, "--check")
    check(code == 0 and summary["status"] == "ready" and summary["cachePath"], summary)


# ---------------------------------------------------------------------------

run_all()
