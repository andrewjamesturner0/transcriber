"""Word-alignment model registry and loaders, shared by lib/align.py and
scripts/setup-diarization.py.

The registry is the single owner of which wav2vec2 model aligns which
language. Its 41 entries are a factual copy of the WhisperX 3.8.6 defaults
(DEFAULT_ALIGN_MODELS_TORCH and DEFAULT_ALIGN_MODELS_HF, tag v3.8.6, commit
3ccc17b8de34f305300f8a3fd3c9f76ba820c0d0), so existing caches keep working
and no language is dropped. WhisperX itself is not used.

Two backends:
  torchaudio   - a torchaudio.pipelines bundle; weights are a torch hub
                 checkpoint fetched from download.pytorch.org.
  huggingface  - a public Hugging Face repo loaded with the ordinary
                 transformers Wav2Vec2Processor and Wav2Vec2ForCTC classes
                 (never trust_remote_code).

Inference loads from the local cache only: load(..., allow_download=False)
blocks torch hub downloads and passes local_files_only=True. Only setup
calls fetch(), which may download.

Nothing heavy is imported at module level: torch, torchaudio, transformers
and huggingface_hub are imported inside the functions that need them, so
--check and the setup script can report missing packages clearly, and
English never imports transformers. The syntax stays parseable by old
Python versions so align.py's version gate can report a clear error.
"""

import contextlib
import io
import os
import sys

# The alignment model for each language. Do not change an entry without a
# separate decision: a different model changes timings and cache contents.
TORCHAUDIO_MODELS = {
    "en": "WAV2VEC2_ASR_BASE_960H",
    "fr": "VOXPOPULI_ASR_BASE_10K_FR",
    "de": "VOXPOPULI_ASR_BASE_10K_DE",
    "es": "VOXPOPULI_ASR_BASE_10K_ES",
    "it": "VOXPOPULI_ASR_BASE_10K_IT",
}

HUGGINGFACE_MODELS = {
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

# Languages written without spaces between words: no word separator tokens.
NO_SPACE_LANGUAGES = ("ja", "zh")

# Known licence terms that setup must show before downloading. Other models
# carry their own licences on their Hugging Face pages; none is cleared here.
LICENCE_NOTES = {
    "WAV2VEC2_ASR_BASE_960H": None,  # MIT (torchaudio / fairseq)
    "VOXPOPULI_ASR_BASE_10K_FR": "CC BY-NC 4.0 (non-commercial use only)",
    "VOXPOPULI_ASR_BASE_10K_DE": "CC BY-NC 4.0 (non-commercial use only)",
    "VOXPOPULI_ASR_BASE_10K_ES": "CC BY-NC 4.0 (non-commercial use only)",
    "VOXPOPULI_ASR_BASE_10K_IT": "CC BY-NC 4.0 (non-commercial use only)",
}

# Packages each backend needs, as distribution names, with the oldest
# major.minor accepted. Newer versions are allowed; the real load decides.
BACKEND_PACKAGES = {
    "torchaudio": (("torch", (2, 0)), ("torchaudio", (2, 0))),
    "huggingface": (("torch", (2, 0)), ("transformers", (4, 0))),
}

# Files a Hugging Face wav2vec2 alignment model needs in the cache: the
# processor (feature extractor and tokenizer vocabulary), the model config
# and one form of weights. The real load still has the final say.
HF_REQUIRED_FILES = ("config.json", "preprocessor_config.json", "vocab.json")
HF_WEIGHT_FILES = ("model.safetensors", "pytorch_model.bin",
                   "model.safetensors.index.json", "pytorch_model.bin.index.json")

# wav2vec2 needs at least this many samples to produce one frame.
MIN_MODEL_SAMPLES = 400


class ModelError(Exception):
    """An expected loading failure with a stable align.py error code."""

    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code
        self.message = message


class DeviceError(Exception):
    """The model loaded from the cache but could not be moved to a device."""


class DownloadBlocked(Exception):
    """Raised instead of a torch hub download during inference."""


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

def languages():
    """All supported language codes, sorted."""
    return sorted(set(TORCHAUDIO_MODELS) | set(HUGGINGFACE_MODELS))


def resolve(language):
    """Model spec for a language code, or None if unsupported.

    Returns {"language", "name", "backend", "noSpaces", "licence"}.
    """
    if not isinstance(language, str):
        return None
    language = language.strip().lower()
    if language in TORCHAUDIO_MODELS:
        name, backend = TORCHAUDIO_MODELS[language], "torchaudio"
    elif language in HUGGINGFACE_MODELS:
        name, backend = HUGGINGFACE_MODELS[language], "huggingface"
    else:
        return None
    return {
        "language": language,
        "name": name,
        "backend": backend,
        "noSpaces": language in NO_SPACE_LANGUAGES,
        "licence": LICENCE_NOTES.get(name),
    }


# ---------------------------------------------------------------------------
# Dependencies (package metadata only, no imports)
# ---------------------------------------------------------------------------

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


def dependency_problem(spec, fix, version_lookup=None):
    """Return (code, message) if a package this backend needs is missing or
    too old, else None. `fix` is the install command to suggest."""
    lookup = version_lookup or package_version
    for dist, minimum in BACKEND_PACKAGES[spec["backend"]]:
        version = lookup(dist)
        if not version:
            return (
                "alignment-missing",
                "Word alignment for '%s' needs the %s package, which is not "
                "installed. Run: %s" % (spec["language"], dist, fix),
            )
        if _leading_ints(version, 2) < minimum:
            return (
                "alignment-unsupported",
                "%s %s is too old for word alignment: %d.%d or newer is needed. "
                "Run: %s" % (dist, version, minimum[0], minimum[1], fix),
            )
    return None


# ---------------------------------------------------------------------------
# Cache checks (no network, no model load)
# ---------------------------------------------------------------------------

def _bundle(name):
    import torchaudio.pipelines
    return getattr(torchaudio.pipelines, name)


def checkpoint_path(name):
    """Where torch hub keeps a torchaudio bundle's weights.

    torchaudio fetches https://download.pytorch.org/torchaudio/models/<_path>
    with torch.hub.load_state_dict_from_url, which saves it as
    <torch hub dir>/checkpoints/<basename>.
    """
    import torch.hub
    basename = os.path.basename(str(_bundle(name)._path))
    return os.path.join(torch.hub.get_dir(), "checkpoints", basename)


def huggingface_status(repo_id):
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


def cache_status(spec):
    """Return (ready, path, detail) for a model's cached weights."""
    if spec["backend"] == "torchaudio":
        try:
            path = checkpoint_path(spec["name"])
        except Exception as e:
            return False, None, "could not locate the torchaudio checkpoint (%s)" % e
        if os.path.isfile(path):
            return True, path, None
        return False, None, "%s is missing" % path
    return huggingface_status(spec["name"])


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def _refuse_url_download(*args, **kwargs):
    raise DownloadBlocked("model download blocked during inference")


def block_downloads():
    """Replace torch hub's downloader so a cache miss can never fetch."""
    import torch.hub
    torch.hub.download_url_to_file = _refuse_url_download


def is_cache_miss(exc):
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


def blank_id(dictionary, pad_token_id=None):
    """The CTC blank column.

    As WhisperX 3.8.6: the id of a "[pad]" or "<pad>" label (the last one
    in dictionary order), else 0. When neither exists, a Hugging Face model's
    config.pad_token_id is used instead of assuming 0.
    """
    found = None
    for label, code in dictionary.items():
        if label == "[pad]" or label == "<pad>":
            found = code
    if found is not None:
        return found
    if isinstance(pad_token_id, int) and not isinstance(pad_token_id, bool) and pad_token_id >= 0:
        return pad_token_id
    return 0


class LoadedModel(object):
    """A wav2vec2 CTC model with its label dictionary and blank id."""

    def __init__(self, spec, model, dictionary, blank):
        self.spec = spec
        self.backend = spec["backend"]
        self.model = model
        self.dictionary = dictionary
        self.blank_id = blank
        self.device = "cpu"

    def to(self, device):
        """Move to a device. Raises DeviceError (the CPU copy stays usable)."""
        if device == self.device:
            return self
        try:
            self.model = self.model.to(device)
        except Exception as e:
            # Module.to moves parameters one by one, so a failure can leave
            # the model split across devices; bring it all back first.
            self.model = self.model.to("cpu")
            raise DeviceError(str(e))
        self.device = device
        return self

    def emissions(self, crop):
        """Log-probabilities [frames, classes] on the CPU for a (1, n) crop.

        As WhisperX 3.8.6: a crop shorter than 400 samples is zero-padded to
        400 and, for torchaudio models only, its real length is passed. HF
        models get the raw waveform, with no feature extractor or mask.
        """
        import torch

        lengths = None
        if crop.shape[-1] < MIN_MODEL_SAMPLES:
            lengths = torch.as_tensor([crop.shape[-1]]).to(self.device)
            crop = torch.nn.functional.pad(crop, (0, MIN_MODEL_SAMPLES - crop.shape[-1]))
        with torch.inference_mode():
            if self.backend == "torchaudio":
                out, _ = self.model(crop.to(self.device), lengths=lengths)
            else:
                out = self.model(crop.to(self.device)).logits
            out = torch.log_softmax(out, dim=-1)
        return out[0].cpu().detach()


def _load_torchaudio(spec, allow_download):
    bundle = _bundle(spec["name"])
    if not allow_download:
        block_downloads()
    # torch hub prints a "Downloading" line to stdout; keep stdout clean.
    with contextlib.redirect_stdout(sys.stderr if allow_download else io.StringIO()):
        model = bundle.get_model()
    model.eval()
    labels = bundle.get_labels()
    dictionary = {}
    for code, label in enumerate(labels):
        dictionary[label.lower()] = code
    return LoadedModel(spec, model, dictionary, blank_id(dictionary))


def _load_huggingface(spec, allow_download):
    from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

    local_only = not allow_download
    processor = Wav2Vec2Processor.from_pretrained(spec["name"], local_files_only=local_only)
    model = Wav2Vec2ForCTC.from_pretrained(spec["name"], local_files_only=local_only)
    model.eval()
    dictionary = {}
    for label, code in processor.tokenizer.get_vocab().items():
        dictionary[label.lower()] = code
    pad = getattr(getattr(model, "config", None), "pad_token_id", None)
    return LoadedModel(spec, model, dictionary, blank_id(dictionary, pad))


def _import_backend(spec, fix):
    """Import the backend's libraries, mapping failure to alignment-missing."""
    try:
        import torch  # noqa: F401
        if spec["backend"] == "torchaudio":
            import torchaudio.pipelines  # noqa: F401
        else:
            import transformers  # noqa: F401
    except Exception as e:
        raise ModelError("alignment-missing",
                         "Word alignment for '%s' cannot import its packages (%s). Run: %s"
                         % (spec["language"], e, fix))


def load(spec, fix, not_prepared):
    """Load a model on the CPU from the local cache only. Never downloads.

    `fix` is the install command and `not_prepared(detail)` builds the
    model-not-prepared message. A cache miss and unreadable cached files
    both raise ModelError("model-not-prepared"); missing packages raise
    ModelError("alignment-missing"). Moving to a GPU is a separate step
    (LoadedModel.to), so a device failure is never mistaken for a cache one.
    """
    _import_backend(spec, fix)
    ready, path, detail = cache_status(spec)
    if not ready:
        raise ModelError("model-not-prepared", not_prepared(detail))
    try:
        if spec["backend"] == "torchaudio":
            return _load_torchaudio(spec, allow_download=False)
        return _load_huggingface(spec, allow_download=False)
    except Exception as e:
        if is_cache_miss(e):
            raise ModelError("model-not-prepared", not_prepared("a file was missing from the cache"))
        where = ("; delete %s first" % path) if spec["backend"] == "torchaudio" else ""
        raise ModelError("model-not-prepared", not_prepared(
            "the cached files could not be read: %s%s" % (e, where)))


def fetch(spec):
    """Setup only: load once on the CPU with downloads allowed, so the
    caches fill. Raises the original exception so setup can classify it."""
    if spec["backend"] == "torchaudio":
        loaded = _load_torchaudio(spec, allow_download=True)
    else:
        with contextlib.redirect_stdout(sys.stderr):
            loaded = _load_huggingface(spec, allow_download=True)
    del loaded
