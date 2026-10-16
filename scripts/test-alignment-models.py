#!/usr/bin/env python3
"""Tests for lib/alignment_models.py: registry, cache checks and loaders.

Runs with a plain Python: torch, torchaudio, transformers and
huggingface_hub are not needed. An import hook supplies stub versions and
records every import, and a module can be marked as "not installed" so its
import fails. Nothing is downloaded and no real model is loaded.

Covers: the frozen 41-entry registry, no heavy imports at module load,
English without transformers, cache-only inference loads with downloads
blocked, explicit setup fetches, missing/damaged cache versus missing
packages versus device failure, label dictionaries and nonzero blank ids,
and dependency version gates.

Usage:
    python3 scripts/test-alignment-models.py
"""

import importlib.abc
import importlib.machinery
import importlib.util
import os
import shutil
import sys
import tempfile
import types

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
MODELS_PATH = os.path.join(ROOT, "lib", "alignment_models.py")
EN_FILE = "wav2vec2_fairseq_base_ls960_asr_ls960.pth"
EN_LABELS = ("-", "|", "E", "T", "A", "O", "N", "I", "H", "S", "R", "D", "L", "U", "M",
             "W", "C", "F", "G", "Y", "P", "B", "V", "K", "'", "X", "J", "Q", "Z")
FIX = "pip install -r requirements.txt"

# Frozen copy of the WhisperX 3.8.6 defaults (v3.8.6, commit 3ccc17b8). The
# registry must match this exactly; change both only with a new decision.
EXPECTED_TORCHAUDIO = {
    "en": "WAV2VEC2_ASR_BASE_960H",
    "fr": "VOXPOPULI_ASR_BASE_10K_FR",
    "de": "VOXPOPULI_ASR_BASE_10K_DE",
    "es": "VOXPOPULI_ASR_BASE_10K_ES",
    "it": "VOXPOPULI_ASR_BASE_10K_IT",
}
EXPECTED_HF = {
    "ja": "jonatasgrosman/wav2vec2-large-xlsr-53-japanese",
    "zh": "jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn",
    "nl": "jonatasgrosman/wav2vec2-large-xlsr-53-dutch",
    "uk": "Yehor/wav2vec2-xls-r-300m-uk-with-small-lm",
    "pt": "jonatasgrosman/wav2vec2-large-xlsr-53-portuguese",
    "ar": "jonatasgrosman/wav2vec2-large-xlsr-53-arabic",
    "cs": "comodoro/wav2vec2-xls-r-300m-cs-250",
    "ru": "jonatasgrosman/wav2vec2-large-xlsr-53-russian",
    "pl": "jonatasgrosman/wav2vec2-large-xlsr-53-polish",
    "hu": "jonatasgrosman/wav2vec2-large-xlsr-53-hungarian",
    "fi": "jonatasgrosman/wav2vec2-large-xlsr-53-finnish",
    "fa": "jonatasgrosman/wav2vec2-large-xlsr-53-persian",
    "el": "jonatasgrosman/wav2vec2-large-xlsr-53-greek",
    "tr": "mpoyraz/wav2vec2-xls-r-300m-cv7-turkish",
    "da": "saattrupdan/wav2vec2-xls-r-300m-ftspeech",
    "he": "imvladikon/wav2vec2-xls-r-300m-hebrew",
    "vi": "nguyenvulebinh/wav2vec2-base-vi-vlsp2020",
    "ko": "kresnik/wav2vec2-large-xlsr-korean",
    "ur": "kingabzpro/wav2vec2-large-xls-r-300m-Urdu",
    "te": "anuragshas/wav2vec2-large-xlsr-53-telugu",
    "hi": "theainerd/Wav2Vec2-large-xlsr-hindi",
    "ca": "softcatala/wav2vec2-large-xlsr-catala",
    "ml": "gvs/wav2vec2-large-xlsr-malayalam",
    "no": "NbAiLab/nb-wav2vec2-1b-bokmaal-v2",
    "nn": "NbAiLab/nb-wav2vec2-1b-nynorsk",
    "sk": "comodoro/wav2vec2-xls-r-300m-sk-cv8",
    "sl": "anton-l/wav2vec2-large-xlsr-53-slovenian",
    "hr": "classla/wav2vec2-xls-r-parlaspeech-hr",
    "ro": "gigant/romanian-wav2vec2",
    "eu": "stefan-it/wav2vec2-large-xlsr-53-basque",
    "gl": "ifrz/wav2vec2-large-xlsr-galician",
    "ka": "xsway/wav2vec2-large-xlsr-georgian",
    "lv": "jimregan/wav2vec2-large-xlsr-latvian-cv",
    "tl": "Khalsuu/filipino-wav2vec2-l-xls-r-300m-official",
    "sv": "KBLab/wav2vec2-large-voxrex-swedish",
    "id": "cahya/wav2vec2-large-xlsr-indonesian",
}
NL = "nl"

# --- Harness ----------------------------------------------------------------

passed = 0
failed = 0
_queue = []
TMP = tempfile.mkdtemp(prefix="alignment-models-")


def test(name):
    def wrap(fn):
        _queue.append((name, fn))
        return fn
    return wrap


def check(cond, msg="assertion failed"):
    if not cond:
        raise AssertionError(msg)


def raises(fn, klass):
    try:
        fn()
    except klass as e:
        return e
    raise AssertionError("expected %s" % klass.__name__)


# --- Stubs ------------------------------------------------------------------

STATE = {}


def reset_state():
    STATE.clear()
    STATE.update({
        "hub_dir": tempfile.mkdtemp(dir=TMP),
        "imported": [],
        "missing": set(),          # module names whose import fails
        "hf_cache": set(),         # (repo, filename)
        "downloads": [],           # torch hub downloads that happened
        "hf_calls": [],            # (class, repo, kwargs)
        "load_error": None,        # raised by torch.load stand-in
        "hf_error": None,          # raised by from_pretrained
        "to_error": None,          # raised by model.to("cuda")
        "vocab": {"<pad>": 0, "<s>": 1, "|": 4, "A": 5, "b": 6},
        "pad_token_id": None,
    })
    for name in list(sys.modules):
        if name in STUBS or name.startswith("transcriber_"):
            del sys.modules[name]


class FakeModel(object):
    def __init__(self, name):
        self.name = name
        self.device = "cpu"
        self.evaluated = False
        self.config = types.SimpleNamespace(pad_token_id=STATE["pad_token_id"])

    def eval(self):
        self.evaluated = True
        return self

    def to(self, device):
        if device != "cpu" and STATE["to_error"] is not None:
            self.device = "split"   # what a half-finished Module.to leaves
            raise STATE["to_error"]
        self.device = device
        return self


def build_torch(m):
    m.__version__ = "2.8.0+stub"


def build_torch_hub(m):
    m.get_dir = lambda: STATE["hub_dir"]

    def download_url_to_file(url, dst, *args, **kwargs):
        STATE["downloads"].append(url)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as f:
            f.write(b"weights")

    def load_state_dict_from_url(url, model_dir=None, **kwargs):
        # What torch.hub does: download on a miss, then torch.load.
        dst = os.path.join(m.get_dir(), "checkpoints", os.path.basename(url))
        if not os.path.exists(dst):
            sys.modules["torch.hub"].download_url_to_file(url, dst)
        if STATE["load_error"] is not None:
            raise STATE["load_error"]
        return {"weights": url}

    m.download_url_to_file = download_url_to_file
    m.load_state_dict_from_url = load_state_dict_from_url


class FakeBundle(object):
    def __init__(self, path, labels):
        self._path = path
        self._labels = labels

    def get_model(self, dl_kwargs=None):
        import torch.hub as hub
        hub.load_state_dict_from_url("https://download.pytorch.org/torchaudio/models/" + self._path)
        return FakeModel(self._path)

    def get_labels(self):
        return self._labels


def build_torchaudio_pipelines(m):
    m.WAV2VEC2_ASR_BASE_960H = FakeBundle(EN_FILE, EN_LABELS)
    m.VOXPOPULI_ASR_BASE_10K_FR = FakeBundle("wav2vec2_voxpopuli_base_10k_asr_fr.pt",
                                             ("<s>", "<pad>", "</s>", "<unk>", "|", "e"))


def build_transformers(m):
    class Tokenizer(object):
        def get_vocab(self):
            return dict(STATE["vocab"])

    class Wav2Vec2Processor(object):
        tokenizer = Tokenizer()

        @classmethod
        def from_pretrained(cls, repo, **kwargs):
            STATE["hf_calls"].append(("processor", repo, kwargs))
            if STATE["hf_error"] is not None:
                raise STATE["hf_error"]
            return cls()

    class Wav2Vec2ForCTC(object):
        @classmethod
        def from_pretrained(cls, repo, **kwargs):
            STATE["hf_calls"].append(("model", repo, kwargs))
            if STATE["hf_error"] is not None:
                raise STATE["hf_error"]
            return FakeModel(repo)

    m.Wav2Vec2Processor = Wav2Vec2Processor
    m.Wav2Vec2ForCTC = Wav2Vec2ForCTC


def build_hub(m):
    class LocalEntryNotFoundError(FileNotFoundError):
        pass

    m.LocalEntryNotFoundError = LocalEntryNotFoundError

    def try_to_load_from_cache(repo_id, filename, **kwargs):
        if (repo_id, filename) in STATE["hf_cache"]:
            return "/hf/models--%s/snapshots/main/%s" % (repo_id.replace("/", "--"), filename)
        return None

    m.try_to_load_from_cache = try_to_load_from_cache


STUBS = {
    "torch": build_torch,
    "torch.hub": build_torch_hub,
    "torchaudio": lambda m: setattr(m, "__version__", "2.8.0"),
    "torchaudio.pipelines": build_torchaudio_pipelines,
    "transformers": build_transformers,
    "huggingface_hub": build_hub,
}
PACKAGES = ("torch", "torchaudio")


class StubFinder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, fullname, path, target=None):
        root = fullname.split(".")[0]
        if fullname in STATE.get("missing", ()) or root in STATE.get("missing", ()):
            raise ImportError("No module named %r (test: not installed)" % fullname)
        if fullname in STUBS:
            return importlib.machinery.ModuleSpec(fullname, self, is_package=fullname in PACKAGES)
        if root in ("whisperx", "nltk", "faster_whisper", "ctranslate2", "pandas"):
            raise ImportError("forbidden import in alignment_models: %s" % fullname)
        return None

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        STATE["imported"].append(module.__name__)
        STUBS[module.__name__](module)


sys.meta_path.insert(0, StubFinder())


def load_models():
    spec = importlib.util.spec_from_file_location("transcriber_alignment_models", MODELS_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fill_en():
    folder = os.path.join(STATE["hub_dir"], "checkpoints")
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, EN_FILE), "wb") as f:
        f.write(b"weights")


def fill_hf(repo=EXPECTED_HF[NL], files=("config.json", "preprocessor_config.json",
                                         "vocab.json", "model.safetensors")):
    for f in files:
        STATE["hf_cache"].add((repo, f))


def not_prepared(detail):
    return "not prepared (%s)" % detail


# --- Tests: registry --------------------------------------------------------

@test("registry has exactly the 41 frozen WhisperX 3.8.6 language/model pairs")
def _():
    m = load_models()
    check(m.TORCHAUDIO_MODELS == EXPECTED_TORCHAUDIO, "torchaudio table drifted")
    check(m.HUGGINGFACE_MODELS == EXPECTED_HF, "huggingface table drifted")
    check(len(m.languages()) == 41 and not set(EXPECTED_TORCHAUDIO) & set(EXPECTED_HF), m.languages())
    for lang, name in EXPECTED_TORCHAUDIO.items():
        s = m.resolve(lang)
        check(s["name"] == name and s["backend"] == "torchaudio", s)
    for lang, name in EXPECTED_HF.items():
        s = m.resolve(lang)
        check(s["name"] == name and s["backend"] == "huggingface", s)


@test("resolve: case/space normalised; unknown and non-string -> None")
def _():
    m = load_models()
    check(m.resolve(" EN ")["language"] == "en", "normalised")
    for bad in ("xx", "", None, 3, "en-gb"):
        check(m.resolve(bad) is None, repr(bad))


@test("only ja and zh are no-space languages")
def _():
    m = load_models()
    flagged = [lang for lang in m.languages() if m.resolve(lang)["noSpaces"]]
    check(flagged == ["ja", "zh"], flagged)


@test("VoxPopuli models carry the non-commercial notice; English does not")
def _():
    m = load_models()
    for lang in ("fr", "de", "es", "it"):
        check("CC BY-NC 4.0" in (m.resolve(lang)["licence"] or ""), lang)
    check(m.resolve("en")["licence"] is None, "en")
    check(m.resolve("nl")["licence"] is None, "HF licences are per model, not cleared here")


# --- Tests: imports and dependencies ---------------------------------------

@test("importing the module imports nothing heavy")
def _():
    load_models()
    check(STATE["imported"] == [], STATE["imported"])


@test("English load imports torch/torchaudio only, never transformers")
def _():
    STATE["missing"].add("transformers")
    fill_en()
    m = load_models()
    loaded = m.load(m.resolve("en"), FIX, not_prepared)
    check("transformers" not in STATE["imported"], STATE["imported"])
    check(loaded.backend == "torchaudio" and loaded.device == "cpu", loaded.backend)
    check(loaded.model.evaluated, "eval() called")


@test("dependency gates: English needs torch+torchaudio; HF needs transformers")
def _():
    m = load_models()
    versions = {"torch": "2.8.0", "torchaudio": "2.8.0"}
    lookup = versions.get
    check(m.dependency_problem(m.resolve("en"), FIX, lookup) is None, "en ready")
    code, msg = m.dependency_problem(m.resolve(NL), FIX, lookup)
    check(code == "alignment-missing" and "transformers" in msg and FIX in msg, msg)
    versions["transformers"] = "4.57.6"
    check(m.dependency_problem(m.resolve(NL), FIX, lookup) is None, "nl ready")
    versions["torchaudio"] = "0.13.1"
    code, msg = m.dependency_problem(m.resolve("en"), FIX, lookup)
    check(code == "alignment-unsupported" and "0.13.1" in msg, msg)
    del versions["torch"]
    check(m.dependency_problem(m.resolve("en"), FIX, lookup)[0] == "alignment-missing", "no torch")


@test("missing transformers at load time -> alignment-missing for HF, not a cache error")
def _():
    STATE["missing"].add("transformers")
    fill_hf()
    m = load_models()
    e = raises(lambda: m.load(m.resolve(NL), FIX, not_prepared), m.ModelError)
    check(e.code == "alignment-missing" and FIX in e.message, e.message)
    check(STATE["hf_calls"] == [], "no load attempted")


@test("package_version reads metadata only and returns None when absent")
def _():
    m = load_models()
    check(m.package_version("surely-not-installed-xyz") is None, "absent")
    check(STATE["imported"] == [], STATE["imported"])


# --- Tests: cache-only inference loads --------------------------------------

@test("torchaudio: missing checkpoint -> model-not-prepared, no download, no load")
def _():
    m = load_models()
    e = raises(lambda: m.load(m.resolve("en"), FIX, not_prepared), m.ModelError)
    check(e.code == "model-not-prepared" and EN_FILE in e.message, e.message)
    check(STATE["downloads"] == [], STATE["downloads"])


@test("torchaudio: a late cache miss inside get_model is blocked, never downloaded")
def _():
    fill_en()
    m = load_models()
    real_status = m.cache_status
    m.cache_status = lambda spec: (True, "/x", None)   # readiness said yes...
    os.remove(os.path.join(STATE["hub_dir"], "checkpoints", EN_FILE))  # ...then it vanished
    e = raises(lambda: m.load(m.resolve("en"), FIX, not_prepared), m.ModelError)
    m.cache_status = real_status
    check(e.code == "model-not-prepared", e.message)
    check(STATE["downloads"] == [], STATE["downloads"])


@test("torchaudio: damaged checkpoint -> model-not-prepared naming the file")
def _():
    fill_en()
    STATE["load_error"] = RuntimeError("PytorchStreamReader failed reading zip archive")
    m = load_models()
    e = raises(lambda: m.load(m.resolve("en"), FIX, not_prepared), m.ModelError)
    check(e.code == "model-not-prepared" and "could not be read" in e.message, e.message)
    check(EN_FILE in e.message and "delete" in e.message, e.message)


@test("torchaudio: label dictionary is lowercased in label order; blank is '-' at 0")
def _():
    fill_en()
    m = load_models()
    loaded = m.load(m.resolve("en"), FIX, not_prepared)
    check(loaded.dictionary["-"] == 0 and loaded.dictionary["|"] == 1, loaded.dictionary)
    check(loaded.dictionary["e"] == 2 and loaded.dictionary["'"] == 24, "lowercased labels")
    check("E" not in loaded.dictionary and len(loaded.dictionary) == 29, "29 labels")
    check(loaded.blank_id == 0, loaded.blank_id)


@test("torchaudio: a bundle with a <pad> label uses it as the blank (nonzero)")
def _():
    m = load_models()
    folder = os.path.join(STATE["hub_dir"], "checkpoints")
    os.makedirs(folder, exist_ok=True)
    open(os.path.join(folder, "wav2vec2_voxpopuli_base_10k_asr_fr.pt"), "wb").close()
    loaded = m.load(m.resolve("fr"), FIX, not_prepared)
    check(loaded.blank_id == 1, loaded.blank_id)


@test("HF: missing or partial cache -> model-not-prepared; never calls from_pretrained")
def _():
    m = load_models()
    e = raises(lambda: m.load(m.resolve(NL), FIX, not_prepared), m.ModelError)
    check(e.code == "model-not-prepared" and "config.json" in e.message, e.message)
    fill_hf(files=("config.json", "preprocessor_config.json", "vocab.json"))
    e = raises(lambda: m.load(m.resolve(NL), FIX, not_prepared), m.ModelError)
    check("model weights" in e.message, e.message)
    check(STATE["hf_calls"] == [], STATE["hf_calls"])


@test("HF: cached -> local_files_only load of processor and model, no remote code")
def _():
    fill_hf()
    m = load_models()
    loaded = m.load(m.resolve(NL), FIX, not_prepared)
    check([c[0] for c in STATE["hf_calls"]] == ["processor", "model"], STATE["hf_calls"])
    for _kind, repo, kwargs in STATE["hf_calls"]:
        check(repo == EXPECTED_HF[NL] and kwargs.get("local_files_only") is True, kwargs)
        check(not kwargs.get("trust_remote_code"), "no remote code")
    check(loaded.dictionary == {"<pad>": 0, "<s>": 1, "|": 4, "a": 5, "b": 6}, loaded.dictionary)
    check(loaded.model.evaluated, "eval() called")


@test("HF: blank id from [PAD]/<pad> vocabulary entries, else config.pad_token_id")
def _():
    fill_hf()
    STATE["vocab"] = {"a": 0, "[PAD]": 7, "b": 1}
    m = load_models()
    check(m.load(m.resolve(NL), FIX, not_prepared).blank_id == 7, "[PAD] -> 7")
    STATE["vocab"] = {"a": 0, "b": 1, "c": 2}
    STATE["pad_token_id"] = 2
    check(m.load(m.resolve(NL), FIX, not_prepared).blank_id == 2, "config pad -> 2")
    STATE["pad_token_id"] = None
    check(m.load(m.resolve(NL), FIX, not_prepared).blank_id == 0, "default 0")


@test("blank_id: the last pad label wins; bools and negatives are not ids")
def _():
    m = load_models()
    check(m.blank_id({"<pad>": 3, "[pad]": 9}) == 9, "last pad label")
    check(m.blank_id({"a": 0}, pad_token_id=True) == 0, "bool ignored")
    check(m.blank_id({"a": 0}, pad_token_id=-1) == 0, "negative ignored")


@test("HF: a cache miss or damaged files during load -> model-not-prepared")
def _():
    fill_hf()
    m = load_models()
    import huggingface_hub as hub
    STATE["hf_error"] = OSError("couldn't find file")
    STATE["hf_error"].__cause__ = hub.LocalEntryNotFoundError("offline")
    e = raises(lambda: m.load(m.resolve(NL), FIX, not_prepared), m.ModelError)
    check(e.code == "model-not-prepared" and "missing from the cache" in e.message, e.message)
    STATE["hf_error"] = OSError("Unable to load weights from safetensors file")
    e = raises(lambda: m.load(m.resolve(NL), FIX, not_prepared), m.ModelError)
    check(e.code == "model-not-prepared" and "could not be read" in e.message, e.message)


@test("moving to a GPU is separate: failure raises DeviceError and the CPU copy works")
def _():
    fill_en()
    STATE["to_error"] = RuntimeError("CUDA error: out of memory")
    m = load_models()
    loaded = m.load(m.resolve("en"), FIX, not_prepared)
    raises(lambda: loaded.to("cuda"), m.DeviceError)
    check(loaded.device == "cpu" and loaded.model.device == "cpu", "moved back: %s" % loaded.model.device)
    check(loaded.to("cpu") is loaded, loaded.device)
    STATE["to_error"] = None
    check(loaded.to("cuda").device == "cuda", "moved")


# --- Tests: setup fetch ------------------------------------------------------

@test("fetch (setup only) downloads a missing torchaudio checkpoint")
def _():
    m = load_models()
    m.fetch(m.resolve("en"))
    check(len(STATE["downloads"]) == 1 and STATE["downloads"][0].endswith(EN_FILE), STATE["downloads"])
    ready, path, _ = m.cache_status(m.resolve("en"))
    check(ready and path.endswith(EN_FILE), path)


@test("fetch on a cached checkpoint does not download again")
def _():
    fill_en()
    m = load_models()
    m.fetch(m.resolve("en"))
    check(STATE["downloads"] == [], STATE["downloads"])


@test("fetch for HF allows downloads (local_files_only False) and raises raw errors")
def _():
    m = load_models()
    m.fetch(m.resolve(NL))
    check(all(c[2].get("local_files_only") is False for c in STATE["hf_calls"]), STATE["hf_calls"])

    class ConnectError(Exception):
        pass

    STATE["hf_error"] = ConnectError("no route to host")
    raises(lambda: m.fetch(m.resolve(NL)), ConnectError)


@test("inference load after fetch blocks downloads in this process")
def _():
    fill_en()
    m = load_models()
    m.load(m.resolve("en"), FIX, not_prepared)
    import torch.hub as hub
    raises(lambda: hub.download_url_to_file("https://example.invalid/x", "/tmp/x"), m.DownloadBlocked)


def main():
    global passed, failed
    for name, fn in _queue:
        reset_state()
        try:
            fn()
            print("  PASS: %s" % name)
            passed += 1
        except Exception as e:  # noqa: BLE001 - report every failure
            print("  FAIL: %s -- %s: %s" % (name, type(e).__name__, e))
            failed += 1
    print("\n%d passed, %d failed" % (passed, failed))
    shutil.rmtree(TMP, ignore_errors=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
