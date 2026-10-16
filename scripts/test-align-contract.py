#!/usr/bin/env python3
"""Contract tests for lib/align.py and scripts/setup-diarization.py --alignment.

Runs with a plain Python: torch, torchaudio, transformers and
huggingface_hub are not needed. An import hook supplies stub versions of
them (and of numpy, if it is not installed), records the environment at the
moment each one is imported, and actively blocks WhisperX, NLTK, pandas and
the speech-recogniser packages: importing any of them fails and is
recorded. The real lib/alignment_models.py runs on top of the stubs; the
model's emissions and the path search in lib/alignment_core.py are replaced
by recording stand-ins (scripts/test-alignment-core.py tests the real
maths). Nothing is downloaded and no real model is loaded.

Covers: offline variables set before import, forbidden imports, sibling
loading from an unrelated directory and an installed-style layout, the
result envelope and provider, padding and sample-exact crops, original words
passed unchanged, failed segments, size limits, cache-only loads with
downloads blocked, damaged caches, GPU fallback, dependency, version and
language gates, WAV and input validation, --check, and the setup helper's
--alignment flow.

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
FR_MODEL = "VOXPOPULI_ASR_BASE_10K_FR"
FR_FILE = "wav2vec2_voxpopuli_base_10k_asr_fr.pt"
NL_MODEL = "jonatasgrosman/wav2vec2-large-xlsr-53-dutch"
JA_MODEL = "jonatasgrosman/wav2vec2-large-xlsr-53-japanese"
WATCHED_ENV = ("HF_HUB_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "TRANSFORMERS_OFFLINE")
TOKEN_VARS = ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN")
SECRET = "hf_TESTSECRET0123456789"
VERSIONS = {"torch": "2.8.0", "torchaudio": "2.8.0", "transformers": "4.57.6"}
FORBIDDEN = ("whisperx", "nltk", "pandas", "faster_whisper", "ctranslate2", "onnxruntime",
             "torchvision", "av")
PROVIDER = {"name": "transcriber-align", "version": "1.0"}

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
        saved_cwd = os.getcwd()
        try:
            fn()
            check(STATE["forbidden"] == [], "forbidden imports attempted: %s" % STATE["forbidden"])
            print("  PASS: %s" % name)
            passed += 1
        except Exception as e:  # noqa: BLE001 - report every failure
            print("  FAIL: %s -- %s: %s" % (name, type(e).__name__, e))
            failed += 1
        finally:
            os.environ.clear()
            os.environ.update(saved_env)
            os.chdir(saved_cwd)
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


def default_align_segment(call):
    """Stand-in for alignment_core.align_segment: word k at crop start +
    100 ms * (k + 1), 50 ms long, measured."""
    origin = call["start"] * 1000 // 16000
    return {"status": "aligned", "reason": None,
            "words": [{"startMs": origin + 100 * (k + 1), "endMs": origin + 100 * (k + 1) + 50,
                       "score": 0.9, "quality": "measured"} for k in range(len(call["words"]))]}


def reset_state():
    hub_dir = tempfile.mkdtemp(dir=TMP)
    STATE.clear()
    STATE.update({
        "cuda": False,
        "env_at_import": {},
        "forbidden": [],                    # forbidden imports that were attempted
        "missing": set(),                   # stubbed packages made "not installed"
        "hub_dir": hub_dir,
        "hf_cache": set(),                  # (repo, filename)
        "align_impl": default_align_segment,
        "align_calls": [],
        "emission_calls": [],
        "load_calls": [],
        "load_error": None,                 # raised while reading weights
        "to_error": None,                   # raised by model.to(non-cpu)
        "url_downloads": [],
        "snapshot_calls": [],
        "speaker_cache": set(),
    })
    for name in list(sys.modules):
        if name in STUBS or name.startswith("transcriber_"):
            del sys.modules[name]


def fill_en_checkpoint(filename=EN_FILE):
    folder = os.path.join(STATE["hub_dir"], "checkpoints")
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, filename), "wb") as f:
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
    def __init__(self, arr, shape=None):
        self.arr = arr
        self.shape = shape or (len(arr),)

    def unsqueeze(self, dim):
        return FakeTensor(self.arr, (1, len(self.arr)))

    def __getitem__(self, key):
        rows, cols = key
        part = self.arr[cols]
        return FakeTensor(part, (1, len(part)))


class FakeModel(object):
    def __init__(self, name):
        self.name = name
        self.device = "cpu"
        self.config = types.SimpleNamespace(pad_token_id=None)

    def eval(self):
        return self

    def to(self, device):
        if device != "cpu" and STATE["to_error"] is not None:
            raise STATE["to_error"]
        self.device = device
        return self


def _record_load(backend, name, local_only):
    STATE["load_calls"].append({"backend": backend, "name": name, "local_only": local_only,
                                "offline": os.environ.get("HF_HUB_OFFLINE")})
    print("stdout noise from a model load")


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

    def load_state_dict_from_url(url, **kwargs):
        dst = os.path.join(m.get_dir(), "checkpoints", os.path.basename(url))
        if not os.path.exists(dst):
            print('Downloading: "%s" to %s' % (url, dst))
            sys.modules["torch.hub"].download_url_to_file(url, dst)
        if STATE["load_error"] is not None:
            raise STATE["load_error"]
        return {}

    m.download_url_to_file = download_url_to_file
    m.load_state_dict_from_url = load_state_dict_from_url


class FakeBundle(object):
    def __init__(self, name, path, labels):
        self.name = name
        self._path = path
        self._labels = labels

    def get_model(self, dl_kwargs=None):
        import torch.hub
        _record_load("torchaudio", self.name, None)
        torch.hub.load_state_dict_from_url("https://download.pytorch.org/torchaudio/models/" + self._path)
        return FakeModel(self.name)

    def get_labels(self):
        return self._labels


def build_torchaudio_pipelines(m):
    m.WAV2VEC2_ASR_BASE_960H = FakeBundle(EN_MODEL, EN_FILE, ("-", "|", "E", "T", "A"))
    m.VOXPOPULI_ASR_BASE_10K_FR = FakeBundle(FR_MODEL, FR_FILE, ("<s>", "<pad>", "</s>", "|", "e"))


def build_transformers(m):
    class Tokenizer(object):
        def get_vocab(self):
            return {"<pad>": 0, "|": 1, "a": 2}

    def loader(kind, factory):
        def from_pretrained(cls, repo, **kwargs):
            local_only = kwargs.get("local_files_only")
            _record_load("huggingface", repo, local_only)
            if STATE["load_error"] is not None:
                raise STATE["load_error"]
            if local_only and (repo, "config.json") not in STATE["hf_cache"]:
                hub = sys.modules["huggingface_hub"]
                try:
                    raise hub.LocalEntryNotFoundError("not in the cache")
                except Exception as e:
                    raise OSError("We couldn't connect to load this file") from e
            fill_hf(repo)
            return factory(repo)
        return classmethod(from_pretrained)

    m.Wav2Vec2Processor = type("Wav2Vec2Processor", (), {
        "tokenizer": Tokenizer(), "from_pretrained": loader("processor", lambda repo: m.Wav2Vec2Processor())})
    m.Wav2Vec2ForCTC = type("Wav2Vec2ForCTC", (), {
        "from_pretrained": loader("model", FakeModel)})


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


STUBS = {
    "torch": build_torch,
    "torch.hub": build_torch_hub,
    "torchaudio": lambda m: setattr(m, "__version__", "2.8.0"),
    "torchaudio.pipelines": build_torchaudio_pipelines,
    "transformers": build_transformers,
    "huggingface_hub": build_hub,
    "pyannote": lambda m: None,
    "pyannote.audio": lambda m: setattr(m, "__version__", "4.0.7"),
}
PACKAGES = ("torch", "torchaudio", "pyannote")

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
        root = fullname.split(".")[0]
        if root in FORBIDDEN:
            STATE["forbidden"].append(fullname)
            raise ImportError("blocked by the contract test: %s" % fullname)
        if fullname in STATE.get("missing", ()) or root in STATE.get("missing", ()):
            raise ImportError("No module named %r (test: not installed)" % fullname)
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


def patch_kernel(a):
    """Replace the model forward pass and the path search with recorders."""
    m, c = a.models(), a.core()

    def emissions(self, crop):
        STATE["emission_calls"].append({"shape": crop.shape, "device": self.device})
        return ("emission", crop.shape[-1])

    def align_segment(emission, words, dictionary, blank_id, no_spaces, crop_start, crop_end,
                      sample_rate=16000):
        call = {"words": list(words), "start": crop_start, "end": crop_end, "noSpaces": no_spaces,
                "blank": blank_id, "emission": emission}
        STATE["align_calls"].append(call)
        return STATE["align_impl"](call)

    m.LoadedModel.emissions = emissions
    c.align_segment = align_segment


def load_align(versions=None):
    a = load_module(ALIGN_PATH, "transcriber_align_test")
    a.SCRIPT_PATH = ALIGN_PATH
    table = dict(VERSIONS) if versions is None else versions
    a.package_version = lambda name: table.get(name)
    patch_kernel(a)
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


OFFLINE = {"HF_HUB_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "TRANSFORMERS_OFFLINE": "1"}


# --- Tests: environment and imports -----------------------------------------

section("Environment tests")


@test("importing lib/align.py and its sibling modules imports nothing heavy")
def _():
    a = load_align()
    check(STATE["env_at_import"] == {}, "imported: %s" % list(STATE["env_at_import"]))
    check(a.models().__file__ == os.path.join(ROOT, "lib", "alignment_models.py"), a.models().__file__)
    check(a.core().__file__ == os.path.join(ROOT, "lib", "alignment_core.py"), a.core().__file__)


@test("inference sets offline and telemetry variables before torch/torchaudio import")
def _():
    os.environ["HF_HUB_OFFLINE"] = "0"           # must be overridden
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "0"
    os.environ.pop("TRANSFORMERS_OFFLINE", None)
    code, env, _, err = align_run([seg(0, 500, 1500, ["Hello", "there"])])
    check(code == 0, "exit %s: %s" % (code, err))
    for name in ("torch", "torch.hub", "torchaudio.pipelines"):
        check(STATE["env_at_import"].get(name) == OFFLINE,
              "%s imported with %s" % (name, STATE["env_at_import"].get(name)))
    check(STATE["load_calls"][0]["offline"] == "1", "load %s" % STATE["load_calls"][0])


@test("English never imports transformers or huggingface_hub, even when they are missing")
def _():
    STATE["missing"].update({"transformers", "huggingface_hub"})
    code, env, _, err = align_run([seg(0, 500, 1500, ["Hello"])],
                                  versions={"torch": "2.8.0", "torchaudio": "2.8.0"})
    check(code == 0, err)
    check("transformers" not in STATE["env_at_import"], "transformers imported")
    check("huggingface_hub" not in STATE["env_at_import"], "huggingface_hub imported")


@test("a Hugging Face language imports transformers and huggingface_hub offline")
def _():
    fill_hf()
    code, env, _, err = align_run([seg(0, 500, 1500, ["hallo"])], language="nl")
    check(code == 0, err)
    for name in ("transformers", "huggingface_hub"):
        check(STATE["env_at_import"].get(name) == OFFLINE, "%s: %s" % (name, STATE["env_at_import"].get(name)))
    check(all(c["local_only"] is True for c in STATE["load_calls"]), STATE["load_calls"])


@test("WhisperX, NLTK, pandas and recogniser packages are actively blocked and never needed")
def _():
    fill_hf()
    code, _, _, err = align_run([seg(0, 500, 1500, ["Hello"])])
    check(code == 0, err)
    code, _, _, err = align_run([seg(0, 500, 1500, ["hallo"])], language="nl")
    check(code == 0, err)
    a = load_align()
    a.check_environment("en")
    a.check_environment("nl")
    for name in FORBIDDEN:
        check(name not in sys.modules, "%s imported" % name)
    # The hook really blocks: an attempted import fails and is recorded.
    try:
        importlib.import_module("whisperx")
        raise AssertionError("whisperx import was not blocked")
    except ImportError:
        pass
    check(STATE["forbidden"] == ["whisperx"], STATE["forbidden"])
    STATE["forbidden"] = []


@test("siblings load by path from an unrelated working directory (source and installed layout)")
def _():
    other = tempfile.mkdtemp(dir=TMP)
    # An installed-style tree: resources/lib/*.py and resources/scripts/setup.
    res = os.path.join(TMP, "resources")
    os.makedirs(os.path.join(res, "lib"))
    os.makedirs(os.path.join(res, "scripts"))
    for name in ("align.py", "alignment_models.py", "alignment_core.py", "diarize.py",
                 "requirements.txt"):
        shutil.copy(os.path.join(ROOT, "lib", name), os.path.join(res, "lib", name))
    shutil.copy(SETUP_PATH, os.path.join(res, "scripts", "setup-diarization.py"))
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    env.pop("PYTHONPATH", None)
    for script, args in ((ALIGN_PATH, ["--check"]),
                         (os.path.join(res, "lib", "align.py"), ["--check", "--language", "nl"]),
                         (os.path.join(res, "scripts", "setup-diarization.py"),
                          ["--check", "--alignment", "en"])):
        proc = subprocess.run([sys.executable, "-I", script] + args, cwd=other, env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True, timeout=120)
        check(proc.returncode == 0, "%s: %s" % (script, proc.stderr[-400:]))
        result = json.loads(proc.stdout.strip().splitlines()[-1])
        part = result.get("alignment", result)
        check(part["status"] in ("ready", "alignment-missing", "model-not-prepared",
                                 "alignment-unsupported"), result)
        if "provider" in part:
            check(part["provider"] == PROVIDER, part["provider"])
        if script.startswith(res):
            check(res in proc.stdout or "results" in part, "installed copy used: %s" % proc.stdout[-300:])


@test("--check in an installation missing a sibling module still prints a status and exits 0")
def _():
    res = os.path.join(TMP, "broken", "lib")
    os.makedirs(res)
    for name in ("align.py", "alignment_core.py", "requirements.txt"):
        shutil.copy(os.path.join(ROOT, "lib", name), os.path.join(res, name))
    proc = subprocess.run([sys.executable, "-I", os.path.join(res, "align.py"), "--check"],
                          cwd=TMP, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          universal_newlines=True, timeout=60)
    check(proc.returncode == 0, proc.stderr[-400:])
    result = json.loads(proc.stdout.strip().splitlines()[-1])
    check(result["status"] == "alignment-missing" and "alignment_models.py" in result["message"], result)


# --- Tests: envelope and timing ----------------------------------------------

section("Envelope and timing tests")


@test("envelope has exactly the documented fields and the local provider")
def _():
    code, env, out, err = align_run([seg(0, 500, 1500, ["Hello", "there"])])
    check(code == 0, err)
    check(set(env) == {"format", "version", "provider", "device", "processingSec", "segments"},
          "keys %s" % sorted(env))
    check(env["format"] == "transcriber-alignment" and env["version"] == 1, "format/version")
    check(env["provider"] == dict(PROVIDER, model=EN_MODEL, language="en"), "provider %s" % env["provider"])
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
    check([p.get("percent") for p in progress if p.get("percent") in (5, 15, 20, 25, 100)][:4] ==
          [5, 15, 20, 25], "progress milestones %s" % progress)
    check(any(p.get("percent") == 100 for p in progress), "Done line")
    check("stdout noise" not in out, "model load output kept off stdout")


@test("padding: crop is [start - pad, end + pad] clamped, in exact samples; times are absolute")
def _():
    segments = [seg(0, 1000, 2000, ["a", "b"]),     # padded both sides
                seg(1, 100, 900, ["c"]),            # start clamps to 0
                seg(2, 2500, 2950, ["d"]),          # end clamps to 3000
                seg(3, 1011, 1013, ["e"])]          # 1011 / 1000 * 16000 is not exact in floats
    code, env, _, err = align_run(segments, pad_ms=200)
    check(code == 0, err)
    calls = STATE["align_calls"]
    check(len(calls) == 4, "one kernel call per input segment")
    check((calls[0]["start"], calls[0]["end"]) == (12800, 35200), calls[0])
    check((calls[1]["start"], calls[1]["end"]) == (0, 17600), calls[1])
    check((calls[2]["start"], calls[2]["end"]) == (36800, 48000), calls[2])
    check((calls[3]["start"], calls[3]["end"]) == (12976, 19408), calls[3])
    check([c["shape"] for c in STATE["emission_calls"]] == [(1, 22400), (1, 17600), (1, 11200), (1, 6432)],
          "the model sees the crop only: %s" % STATE["emission_calls"])
    check(calls[0]["emission"] == ("emission", 22400), "the crop's emission goes to the kernel")
    w = words_of(env, 0)
    check(w[0]["startMs"] == 900 and w[0]["endMs"] == 950, "absolute ms %s" % w[0])
    check(w[1]["startMs"] == 1000, "second word %s" % w[1])
    check(words_of(env, 1)[0]["startMs"] == 100, "clamped window origin")


@test("padMs 0 and missing padMs (default 200)")
def _():
    code, env, _, err = align_run([seg(0, 1000, 2000, ["a"])], pad_ms=0)
    check(code == 0, err)
    check((STATE["align_calls"][0]["start"], STATE["align_calls"][0]["end"]) == (16000, 32000), "pad 0")
    reset_state()
    code, env, _, err = align_run([seg(0, 1000, 2000, ["a"])], pad_ms=None)
    check(code == 0, err)
    check(STATE["align_calls"][0]["start"] == 12800, "default pad")


@test("a window that starts after the audio ends -> failed outside-audio, model not run")
def _():
    code, env, _, err = align_run([seg(0, 500, 900, ["x"]), seg(1, 3300, 4000, ["late", "words"])])
    check(code == 0, err)
    s = env["segments"][1]
    check(s["status"] == "failed" and s["reason"] == "outside-audio", s)
    check([w["quality"] for w in s["words"]] == ["unaligned", "unaligned"], s["words"])
    check(len(STATE["align_calls"]) == 1 and len(STATE["emission_calls"]) == 1, "only the first ran")


@test("the original words go to the kernel unchanged and in order")
def _():
    words = ["$12.6", "U.S.", "O'Brien", "said,", "3%", "the", "the", ""]
    code, env, _, err = align_run([seg(0, 0, 2000, words)])
    check(code == 0, err)
    check(STATE["align_calls"][0]["words"] == words, STATE["align_calls"][0]["words"])
    check(len(words_of(env, 0)) == len(words), "one record per input word")


@test("kernel records and failure reasons are copied through unchanged")
def _():
    records = [{"startMs": 100, "endMs": 200, "score": 0.812, "quality": "measured"},
               {"startMs": 300, "endMs": 400, "score": None, "quality": "interpolated"},
               {"startMs": None, "endMs": None, "score": None, "quality": "unaligned"}]

    def impl(call):
        if call["words"][0] == "fail":
            return {"status": "failed", "reason": "no-path",
                    "words": [dict(records[2]) for _ in call["words"]]}
        return {"status": "aligned", "reason": None, "words": [dict(r) for r in records]}
    STATE["align_impl"] = impl
    code, env, out, err = align_run([seg(0, 0, 1000, ["one", "1990", ""]),
                                     seg(1, 1000, 2000, ["fail", "here"])])
    check(code == 0, err)
    check(words_of(env, 0) == records, words_of(env, 0))
    s = env["segments"][1]
    check(s["status"] == "failed" and s["reason"] == "no-path" and len(s["words"]) == 2, s)
    summary = json.loads(out.strip().splitlines()[-1])
    check(summary == {"segments": 2, "failedSegments": 1, "words": 5, "measured": 1,
                      "interpolated": 1, "unaligned": 3}, summary)


@test("an input segment with no words -> failed empty-segment, not sent")
def _():
    code, env, _, err = align_run([seg(0, 0, 900, [])])
    check(code == 0, err)
    check(env["segments"][0] == {"index": 0, "status": "failed", "reason": "empty-segment",
                                 "words": []}, env["segments"][0])
    check(STATE["align_calls"] == [] and STATE["emission_calls"] == [], "not sent")


@test("a crop over the size limit -> failed too-long before the model runs")
def _():
    wav = write_wav("long.wav", seconds=61.0)
    code, env, _, err = align_run([seg(0, 0, 61000, ["a", "b"]), seg(1, 0, 900, ["c"])], wav=wav)
    check(code == 0, err)
    s = env["segments"][0]
    check(s["status"] == "failed" and s["reason"] == "too-long" and len(s["words"]) == 2, s)
    check(len(STATE["emission_calls"]) == 1, "only the short segment ran the model")


@test("ja and zh are aligned without word separators; other languages with them")
def _():
    fill_hf(JA_MODEL)
    code, env, _, err = align_run([seg(0, 0, 900, ["\u4eca\u65e5\u306f", "\u96e8"])], language="ja")
    check(code == 0 and STATE["align_calls"][0]["noSpaces"] is True, err)
    reset_state()
    code, env, _, err = align_run([seg(0, 0, 900, ["a"])])
    check(code == 0 and STATE["align_calls"][0]["noSpaces"] is False, err)


@test("output word counts always equal input word counts")
def _():
    import random
    rng = random.Random(7)
    vocab = ["a", "b", "c", "d", "e"]
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
    check(STATE["emission_calls"][0]["device"] == "cuda", "cuda used")
    reset_state()
    STATE["cuda"] = True
    code, env, _, err = align_run([seg(0, 0, 900, ["a"])], "--device", "cpu")
    check(code == 0 and env["device"] == "cpu", "forced cpu")
    reset_state()
    code, env, _, err = align_run([seg(0, 0, 900, ["a"])], "--device", "cuda")
    check(code == 0 and env["device"] == "cpu", "cuda unavailable -> cpu")


@test("GPU move failure keeps the CPU copy; not reported as a cache problem")
def _():
    STATE["cuda"] = True
    STATE["to_error"] = RuntimeError("CUDA error: no kernel image")
    code, env, _, err = align_run([seg(0, 0, 900, ["a"])])
    check(code == 0 and env["device"] == "cpu", err)
    check(STATE["emission_calls"][0]["device"] == "cpu", STATE["emission_calls"])
    check("using CPU" in err and len(STATE["load_calls"]) == 1, "weights read once: %s" % err)


# --- Tests: failures ---------------------------------------------------------

section("Failure tests")


@test("per-segment errors fail that segment; all segments failing -> alignment-failed")
def _():
    def impl(call):
        if call["words"] == ["bad"]:
            raise KeyError("trellis")
        return default_align_segment(call)
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
    def impl(call):
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


@test("missing torchaudio checkpoint -> model-not-prepared, no download, no load")
def _():
    code, env, _, err = align_run([seg(0, 0, 900, ["a"])], ready=False)
    e = error_line(err)
    check(code == 1 and e and e["code"] == "model-not-prepared", err)
    check("setup-diarization.py --alignment" in e["error"], e["error"])
    check(EN_FILE in e["error"], "names the missing file")
    check(STATE["load_calls"] == [] and STATE["url_downloads"] == [], "no load, no download")


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
    check(all(c["local_only"] is True for c in STATE["load_calls"]), "local_files_only")
    check(env["provider"]["model"] == NL_MODEL and env["provider"]["language"] == "nl", env["provider"])


@test("damaged cached weights -> model-not-prepared (CPU read, not a device error)")
def _():
    fill_hf()
    STATE["load_error"] = OSError("Unable to load weights from safetensors file")
    code, env, _, err = align_run([seg(0, 0, 900, ["hallo"])], language="nl")
    e = error_line(err)
    check(code == 1 and e["code"] == "model-not-prepared" and "could not be read" in e["error"], err)
    reset_state()
    STATE["cuda"] = True
    STATE["load_error"] = RuntimeError("PytorchStreamReader failed reading zip archive")
    code, env, _, err = align_run([seg(0, 0, 900, ["a"])])
    e = error_line(err)
    check(code == 1 and e["code"] == "model-not-prepared" and EN_FILE in e["error"], err)
    check("using CPU" not in err, "no GPU retry for a cache problem")


@test("torch hub download is blocked: a late checkpoint miss never downloads")
def _():
    fill_en_checkpoint()
    a = load_align()
    real_status = a.model_status
    a.model_status = lambda model: (True, "/hub/x", None)
    os.remove(os.path.join(STATE["hub_dir"], "checkpoints", EN_FILE))
    inp = write_input([seg(0, 0, 900, ["a"])])
    code, out, err = run_main(a, ["--audio", good_wav(), "--input", inp, "--output", tmp_path("out.json")])
    a.model_status = real_status
    e = error_line(err)
    check(code == 1 and e and e["code"] == "model-not-prepared", err)
    check(STATE["url_downloads"] == [], "stub download_url_to_file was called")


@test("missing packages: torch/torchaudio -> alignment-missing; HF language needs transformers")
def _():
    code, env, _, err = align_run([seg(0, 0, 900, ["a"])], versions={"torchaudio": "2.8.0"})
    e = error_line(err)
    check(code == 1 and e["code"] == "alignment-missing" and "torch" in e["error"], err)
    check("requirements.txt" in e["error"], e["error"])
    reset_state()
    fill_hf()
    code, env, _, err = align_run([seg(0, 0, 900, ["hallo"])], language="nl",
                                  versions={"torch": "2.8.0", "torchaudio": "2.8.0"})
    e = error_line(err)
    check(code == 1 and e["code"] == "alignment-missing" and "transformers" in e["error"], err)
    check(STATE["load_calls"] == [], "nothing loaded")
    reset_state()
    STATE["missing"].add("transformers")       # metadata says installed, import fails
    fill_hf()
    code, env, _, err = align_run([seg(0, 0, 900, ["hallo"])], language="nl")
    e = error_line(err)
    check(code == 1 and e["code"] == "alignment-missing", err)


@test("version gates: old torchaudio -> alignment-unsupported; Python 3.9 -> python-unsupported")
def _():
    code, env, _, err = align_run([seg(0, 0, 900, ["a"])], versions=dict(VERSIONS, torchaudio="0.13.1"))
    e = error_line(err)
    check(code == 1 and e["code"] == "alignment-unsupported" and "0.13.1" in e["error"], err)
    check("torch" not in STATE["env_at_import"], "nothing heavy imported before the gate")
    a = load_align()
    check(a.python_problem((3, 9, 18))[0] == "python-unsupported", "3.9")
    check(a.python_problem((3, 10, 0)) is None, "3.10")
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


@test("--check output shape and statuses; deprecated keys null; no download, no load")
def _():
    a = load_align()
    code, out, _ = run_main(a, ["--check"])
    res = json.loads(out)
    keys = {"status", "message", "language", "provider", "versions", "pythonSupported",
            "alignmentSupported", "languageSupported", "cudaAvailable", "model", "modelReady",
            "modelPath", "punktReady", "punktPath", "requirements", "executable"}
    check(set(res) == keys, "keys %s" % sorted(res))
    check(code == 0 and res["status"] == "model-not-prepared" and res["modelReady"] is False, out)
    check(res["provider"] == PROVIDER, res["provider"])
    check(res["punktReady"] is None and res["punktPath"] is None, "deprecated punkt keys are null")
    check(set(res["versions"]) == {"python", "torch", "torchaudio", "transformers", "whisperx", "nltk"},
          res["versions"])
    check(res["versions"]["whisperx"] is None and res["versions"]["nltk"] is None, res["versions"])
    check(res["model"] == {"name": EN_MODEL, "type": "torchaudio"}, res)
    fill_en_checkpoint()
    res = a.check_environment("en")
    check(res["status"] == "ready" and res["modelPath"].endswith(EN_FILE), res)
    check(res["versions"]["torch"] == "2.8.0+stub", res["versions"])
    check(os.path.basename(res["requirements"]) == "requirements.txt", res["requirements"])
    res = a.check_environment("xx")
    check(res["status"] == "language-unsupported" and res["languageSupported"] is False, res)
    check(a.check_environment("nl")["status"] == "model-not-prepared", "nl")
    fill_hf()
    res = a.check_environment("NL")
    check(res["status"] == "ready" and res["model"]["type"] == "huggingface", "nl cached, case-insensitive")
    check(res["status"] in a.CHECK_STATUSES, "status listed")
    check(STATE["load_calls"] == [] and STATE["url_downloads"] == [], "nothing loaded or downloaded")


@test("--check without packages -> alignment-missing; Python 3.9 -> python-unsupported")
def _():
    a = load_align({})
    res = a.check_environment("en")
    check(res["status"] == "alignment-missing" and res["alignmentSupported"] is False, res)
    check("torch" not in STATE["env_at_import"], "torch not imported when not installed")
    a = load_align({"torch": "2.8.0", "torchaudio": "2.8.0"})
    check(a.check_environment("en")["status"] == "model-not-prepared", "English needs no transformers")
    res = a.check_environment("nl")
    check(res["status"] == "alignment-missing" and "transformers" in res["message"], res)
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
            "modelPath": "/hub/checkpoints/" + EN_FILE, "punktPath": None,
            "versions": {"python": "3.12.3", "torch": "2.8.0", "torchaudio": "2.8.0",
                         "transformers": "4.57.6", "whisperx": None, "nltk": None}}


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
    summary, code, out, err = run_setup(environ, "--alignment")
    check(code == 0 and summary["status"] == "ready", "%s %s" % (summary, err))
    check(summary["speaker"]["status"] == "ready" and summary["speaker"]["action"] == "already-prepared",
          summary["speaker"])
    check(STATE["snapshot_calls"] == [], "speaker model not downloaded again")
    check(summary["alignment"]["status"] == "ready" and summary["alignment"]["languages"] == ["en"],
          summary["alignment"])
    check(summary["alignment"]["results"][0]["modelPath"].endswith(EN_FILE), "cache path reported")
    check(summary["alignment"]["results"][0]["punktPath"] is None, "deprecated punktPath is null")
    load = STATE["load_calls"][0]
    check(load["backend"] == "torchaudio" and load["name"] == EN_MODEL, load)
    check(load["offline"] is None, "network allowed for the model")
    check(len(STATE["url_downloads"]) == 1, "checkpoint fetched once")
    check(STATE["url_downloads"][0]["offline"] is None, "fetched with network allowed")
    env_at = STATE["env_at_import"].get("huggingface_hub")
    check(env_at and env_at["HF_HUB_OFFLINE"] is None and env_at["TRANSFORMERS_OFFLINE"] is None,
          "huggingface_hub imported with %s" % env_at)
    check(env_at["HF_HUB_DISABLE_TELEMETRY"] == "1", "telemetry off")
    check("HF_HUB_OFFLINE" not in environ and "TRANSFORMERS_OFFLINE" not in environ, "env cleared")
    check(STATE["verify_calls"][0]["language"] == "en", "verified")
    check(summary["alignment"]["versions"]["whisperx"] is None, summary["alignment"]["versions"])
    check("noise" not in out.splitlines()[-1] and "Downloading" not in out, "summary line clean")
    json.loads(out.strip().splitlines()[-1])


@test("setup: assets already present -> no checkpoint download, model read once")
def _():
    fill_speaker()
    fill_en_checkpoint()
    summary, code, _, err = run_setup({}, "--alignment")
    check(code == 0 and summary["status"] == "ready", err)
    check(STATE["url_downloads"] == [], "nothing re-downloaded")
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
    nl = [c for c in STATE["load_calls"] if c["name"] == NL_MODEL]
    check(nl and all(c["local_only"] is False for c in nl), "nl fetched with downloads allowed: %s" % nl)
    check(SECRET not in out and SECRET not in err, "token printed")


@test("setup: VoxPopuli licence note comes from the registry, before the download")
def _():
    fill_speaker()
    summary, code, _, err = run_setup({}, "--alignment", "fr")
    check(code == 0, err)
    lines = [json.loads(l) for l in err.splitlines() if l.startswith("{")]
    note = [i for i, l in enumerate(lines) if "CC BY-NC 4.0" in l.get("message", "")]
    fetch = [i for i, l in enumerate(lines) if FR_MODEL in l.get("message", "") and "downloading" in l["message"]]
    check(note and fetch and note[0] < fetch[0], lines)


@test("setup: torch missing -> alignment-missing; speaker part unaffected")
def _():
    fill_speaker()
    summary, code, _, err = run_setup({}, "--alignment", align_versions={"torchaudio": "2.8.0"})
    check(code == 1 and summary["alignment"]["status"] == "alignment-missing", summary)
    check(summary["speaker"]["status"] == "ready", summary["speaker"])
    check("requirements.txt" in summary["alignment"]["message"], summary["alignment"]["message"])
    check(STATE["load_calls"] == [], "nothing downloaded")


@test("setup: a Hugging Face language without transformers stops before any download")
def _():
    fill_speaker()
    summary, code, _, err = run_setup({}, "--alignment", "en,nl",
                                      align_versions={"torch": "2.8.0", "torchaudio": "2.8.0"})
    check(code == 1 and summary["alignment"]["status"] == "alignment-missing", summary)
    check("transformers" in summary["alignment"]["message"], summary["alignment"]["message"])
    check(STATE["load_calls"] == [] and STATE["url_downloads"] == [], "nothing downloaded")


@test("setup: unsupported language stops before any download")
def _():
    fill_speaker()
    summary, code, _, err = run_setup({}, "--alignment", "en,xx")
    check(code == 1 and summary["alignment"]["status"] == "language-unsupported", summary)
    check(STATE["load_calls"] == [] and STATE["url_downloads"] == [], "nothing downloaded")


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
          STATE["url_downloads"] == [], "nothing downloaded")


@test("setup without --alignment keeps the original summary shape")
def _():
    summary, code, _, _ = run_setup({}, "--check")
    check(set(summary) == {"status", "message", "model", "cachePath", "versions", "cudaAvailable"},
          sorted(summary))


# ---------------------------------------------------------------------------

run_all()
