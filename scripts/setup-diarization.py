#!/usr/bin/env python3
"""Prepare the speaker diarization model. Explicit, user-run, uses the network.

Downloads the pinned pyannote Community-1 snapshot into the standard Hugging
Face cache, then checks in a fresh offline process that lib/diarize.py can
load it. After this, diarization runs fully offline and needs no token.

With --alignment it also prepares forced word alignment (lib/align.py): it
downloads the wav2vec2 alignment model for each language, then checks each
language with lib/align.py --check in a fresh offline process. The speaker model is downloaded in the same run only if it
is not already prepared, so alignment can be added later without a token
(the English, French, German, Spanish and Italian alignment models come from
download.pytorch.org; other languages from public Hugging Face repos). The
two parts are reported separately and one failing does not stop the other.

Usage:
    HF_TOKEN=hf_... python scripts/setup-diarization.py
    python scripts/setup-diarization.py --check
    python scripts/setup-diarization.py --alignment [en,fr,...]
    python scripts/setup-diarization.py --alignment --language en,fr   (same thing)
    python scripts/setup-diarization.py --check --alignment [LANGS]
    python scripts/setup-diarization.py --model ID --revision SHA   (evaluation only)

Before the first run:
    1. Accept the model licence at
       https://hf.co/pyannote/speaker-diarization-community-1
    2. Create a read token at https://hf.co/settings/tokens
    3. Put it in the HF_TOKEN environment variable (HUGGING_FACE_HUB_TOKEN
       also works).

The token is read only from the environment. It is never accepted on the
command line and never printed.

Alignment needs the optional packages first:
    pip install -r lib/requirements-alignment.txt

Output: JSON progress lines {"message", "percent"} on stderr, plus one
{"error", "code"} line for each part that fails; one JSON summary object on
stdout. With --alignment the summary is {"status", "message", "speaker",
"alignment"}, where "speaker" has the same shape as the summary without
--alignment and "status" is "ready" only when both parts are ready.
Exit 0 when ready (--check always exits 0), 1 on failure.
"""

import argparse
import contextlib
import importlib.util
import json
import os
import re
import subprocess
import sys

TOKEN_ENV_VARS = ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN")
TOKEN_PAGE = "https://hf.co/settings/tokens"
VERIFY_TIMEOUT_SEC = 600
DEFAULT_ALIGNMENT_LANGUAGES = "en"

_HERE = os.path.dirname(os.path.abspath(__file__))


class SetupError(Exception):
    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# lib/diarize.py is the single source of the version rules, model pin and
# environment set-up. Import it by path rather than copying anything.
# ---------------------------------------------------------------------------

def find_diarize_script():
    candidates = [
        os.path.join(_HERE, "..", "lib", "diarize.py"),
        os.path.join(_HERE, "diarize.py"),
    ]
    for candidate in candidates:
        if os.path.isfile(candidate):
            return os.path.abspath(candidate)
    return os.path.abspath(candidates[0])


def load_diarize_module(path=None):
    path = path or find_diarize_script()
    spec = importlib.util.spec_from_file_location("transcriber_diarize", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.SCRIPT_PATH = path
    return module


# lib/align.py plays the same role for word alignment.

def find_align_script():
    candidates = [
        os.path.join(_HERE, "..", "lib", "align.py"),
        os.path.join(_HERE, "align.py"),
    ]
    for candidate in candidates:
        if os.path.isfile(candidate):
            return os.path.abspath(candidate)
    return os.path.abspath(candidates[0])


def load_align_module(path=None):
    path = path or find_align_script()
    spec = importlib.util.spec_from_file_location("transcriber_align", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.SCRIPT_PATH = path
    return module


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def progress(message, percent=None):
    obj = {"message": message}
    if percent is not None:
        obj["percent"] = percent
    print(json.dumps(obj), file=sys.stderr, flush=True)


def emit_error(code, message):
    print(json.dumps({"error": message, "code": code}), file=sys.stderr, flush=True)


def read_token(environ):
    """Token from the environment only, or None."""
    for name in TOKEN_ENV_VARS:
        value = (environ.get(name) or "").strip()
        if value:
            return value
    return None


def scrub(text, token):
    """Remove the token from any text we might print."""
    text = str(text)
    if token:
        text = text.replace(token, "hf_***")
    return text


def licence_url(model):
    return "https://hf.co/%s" % model


def _exception_chain(exc):
    seen = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        yield exc
        exc = exc.__cause__ or exc.__context__


def classify_download_error(exc, model, token):
    """Map a snapshot_download failure to (code, actionable message).

    Matched by class name so it works across huggingface_hub versions
    (requests-based before 1.0, httpx-based after) and with test stubs.
    """
    names = set()
    status = None
    for e in _exception_chain(exc):
        names.update(k.__name__ for k in type(e).__mro__)
        response = getattr(e, "response", None)
        code = getattr(response, "status_code", None)
        if status is None and isinstance(code, int):
            status = code

    access_help = (
        "Hugging Face refused access to %s. Accept the licence at %s while "
        "logged in to the account that owns the token, check the token is a "
        "valid read token (%s), then run this again."
        % (model, licence_url(model), TOKEN_PAGE)
    )
    if "GatedRepoError" in names or status in (401, 403):
        return "model-access-denied", access_help
    if "RepositoryNotFoundError" in names:
        # Hugging Face reports gated repos as "not found" to unauthorised users.
        return "model-access-denied", access_help
    if "RevisionNotFoundError" in names:
        return "download-failed", "Revision not found in %s: %s" % (model, scrub(exc, token))
    network_names = {
        "OfflineModeIsEnabled", "LocalEntryNotFoundError", "ConnectionError",
        "Timeout", "TimeoutError", "TimeoutException", "TransportError",
        "NetworkError", "ConnectError", "ProxyError", "SSLError",
    }
    if names & network_names:
        return (
            "network-error",
            "Could not download from huggingface.co (%s). Check the internet "
            "connection and any proxy settings, then run this again."
            % scrub(exc, token),
        )
    return "download-failed", "Model download failed: %s" % scrub(exc, token)


def basic_versions(diarize):
    """Versions from package metadata only (no heavy imports)."""
    vi = diarize.current_version_info()
    return {
        "python": ".".join(str(p) for p in tuple(vi)[:3]),
        "pyannote.audio": diarize.package_version("pyannote.audio"),
        "torch": diarize.package_version("torch"),
    }


def make_summary(status, message, model, revision, versions, cache_path=None,
                 cuda_available=None):
    return {
        "status": status,
        "message": message,
        "model": {"id": model, "revision": revision},
        "cachePath": cache_path,
        "versions": versions,
        "cudaAvailable": cuda_available,
    }


def download(model, revision, token):
    """Download the snapshot into the default Hugging Face cache.

    One worker on purpose. huggingface_hub (seen in 1.7.2) records a cache
    folder as symlink-capable before its symlink probe finishes, so on
    Windows without Developer Mode a second download thread can try a real
    symlink and fail with WinError 1314. The repo is about ten small files,
    so downloading them in turn costs little.
    """
    from huggingface_hub import snapshot_download
    return snapshot_download(repo_id=model, revision=revision, token=token, max_workers=1)


def verify_offline(diarize, model, revision, environ):
    """Run lib/diarize.py --check --load in a fresh process, offline.

    A fresh process means huggingface_hub is imported with HF_HUB_OFFLINE=1
    from the start, exactly as during inference. No token is passed.
    """
    env = dict(environ)
    for name in TOKEN_ENV_VARS:
        env.pop(name, None)
    env["HF_HUB_OFFLINE"] = "1"
    cmd = [sys.executable, diarize.SCRIPT_PATH, "--check", "--load",
           "--model", model, "--revision", revision]
    proc = subprocess.run(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          universal_newlines=True, timeout=VERIFY_TIMEOUT_SEC)
    for line in reversed(proc.stdout.strip().splitlines()):
        try:
            result = json.loads(line)
        except ValueError:
            continue
        if isinstance(result, dict) and "status" in result:
            return result
    raise SetupError(
        "verify-failed",
        "The offline check did not report a result (exit %s): %s"
        % (proc.returncode, proc.stderr.strip()[-500:]),
    )


# ---------------------------------------------------------------------------
# Main flow
# ---------------------------------------------------------------------------

def run_speaker(args, environ, diarize):
    """Prepare the speaker model. Returns (summary dict, exit code). Prints
    progress and errors itself."""
    environ = os.environ if environ is None else environ
    model, revision = args.model or diarize.DEFAULT_MODEL, args.revision or diarize.DEFAULT_REVISION

    if args.check:
        # Readiness only: offline, no download.
        diarize.configure_environment(offline=True, environ=environ)
        result = diarize.check_environment(model, revision)
        summary = make_summary(result["status"], result["message"], model, revision,
                               result["versions"], result.get("modelPath"),
                               result.get("cudaAvailable"))
        return summary, 0

    # Telemetry off; network allowed because the user asked for a download.
    diarize.configure_environment(offline=False, environ=environ)
    environ.pop("HF_HUB_OFFLINE", None)
    environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"

    versions = basic_versions(diarize)
    token = None
    try:
        progress("Checking the Python environment...", 5)
        problem = diarize.python_problem() or diarize.pyannote_problem(versions["pyannote.audio"])
        if problem:
            raise SetupError(*problem)

        token = read_token(environ)
        if not token:
            raise SetupError(
                "token-missing",
                "No Hugging Face token found. Accept the model licence at %s, "
                "create a read token at %s, set it in the HF_TOKEN environment "
                "variable, then run this again."
                % (licence_url(model), TOKEN_PAGE),
            )

        progress("Downloading %s (revision %s)..." % (model, revision[:12]), 10)
        try:
            cache_path = download(model, revision, token)
        except Exception as e:
            raise SetupError(*classify_download_error(e, model, token))

        progress("Checking the model loads offline...", 80)
        try:
            result = verify_offline(diarize, model, revision, environ)
        except SetupError:
            raise
        except Exception as e:
            raise SetupError("verify-failed", "The offline check failed: %s" % scrub(e, token))
        if result.get("status") != "ready":
            raise SetupError("verify-failed",
                             "Downloaded, but the offline check failed: %s"
                             % scrub(result.get("message", result.get("status")), token))

        progress("Done", 100)
        summary = make_summary("ready", "Speaker diarization is ready.", model, revision,
                               result.get("versions", versions),
                               result.get("modelPath") or cache_path,
                               result.get("cudaAvailable"))
        return summary, 0
    except SetupError as e:
        message = scrub(e.message, token)
        emit_error(e.code, message)
        return make_summary(e.code, message, model, revision, versions), 1
    except Exception as e:
        message = "Setup failed: %s" % scrub(e, token)
        emit_error("setup-failed", message)
        return make_summary("setup-failed", message, model, revision, versions), 1


# ---------------------------------------------------------------------------
# Word alignment (--alignment)
# ---------------------------------------------------------------------------

ALIGNMENT_NETWORK_NAMES = {
    "OfflineModeIsEnabled", "LocalEntryNotFoundError", "ConnectionError",
    "Timeout", "TimeoutError", "TimeoutException", "TransportError",
    "NetworkError", "ConnectError", "ProxyError", "SSLError", "URLError",
    "HTTPError", "gaierror",
}


def parse_languages(value):
    """"en, FR,en" -> ["en", "fr"]. Empty -> the default."""
    langs = []
    for part in (value or DEFAULT_ALIGNMENT_LANGUAGES).split(","):
        lang = part.strip().lower()
        if lang and lang not in langs:
            langs.append(lang)
    return langs or [DEFAULT_ALIGNMENT_LANGUAGES]


def alignment_languages(args):
    """Languages asked for with --alignment [LANGS] or --language LANGS."""
    if args.alignment and args.language:
        raise SetupError("bad-arguments",
                         "Give the alignment languages once: --alignment LANGS or --language LANGS.")
    return parse_languages(args.alignment or args.language)


def classify_alignment_error(exc, token):
    """Map a failed alignment download to (code, message)."""
    names = set()
    for e in _exception_chain(exc):
        names.update(k.__name__ for k in type(e).__mro__)
    if names & ALIGNMENT_NETWORK_NAMES:
        return (
            "network-error",
            "Could not download the alignment data (%s). Check the internet "
            "connection and any proxy settings, then run this again." % scrub(exc, token),
        )
    return "download-failed", "Alignment download failed: %s" % scrub(exc, token)


def fetch_alignment_model(align, language):
    """Load the alignment model once on the CPU so the caches fill.

    lib/alignment_models.py (through align.fetch_model) downloads the
    torchaudio checkpoint (torch hub) or the Hugging Face snapshot when it
    is missing; when it is already cached nothing is downloaded and the
    load just proves the files are readable. stdout must stay clean for the
    JSON summary.
    """
    with contextlib.redirect_stdout(sys.stderr):
        align.fetch_model(language)


def verify_alignment(align, language, environ):
    """Run lib/align.py --check --language xx in a fresh offline process.

    No token is passed: inference never needs one.
    """
    env = dict(environ)
    for name in TOKEN_ENV_VARS:
        env.pop(name, None)
    env["HF_HUB_OFFLINE"] = "1"
    env["TRANSFORMERS_OFFLINE"] = "1"
    cmd = [sys.executable, align.SCRIPT_PATH, "--check", "--language", language]
    proc = subprocess.run(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          universal_newlines=True, timeout=VERIFY_TIMEOUT_SEC)
    for line in reversed(proc.stdout.strip().splitlines()):
        try:
            result = json.loads(line)
        except ValueError:
            continue
        if isinstance(result, dict) and "status" in result:
            return result
    raise SetupError(
        "verify-failed",
        "The offline alignment check did not report a result (exit %s): %s"
        % (proc.returncode, proc.stderr.strip()[-500:]),
    )


def _language_entry(language, result):
    return {
        "language": language,
        "status": result.get("status"),
        "message": result.get("message"),
        "model": result.get("model"),
        "modelPath": result.get("modelPath"),
        "punktPath": None,  # deprecated: Punkt is no longer used
    }


def alignment_summary(status, message, languages, entries, versions):
    return {
        "status": status,
        "message": message,
        "languages": languages,
        "results": entries,
        "versions": versions,
    }


def alignment_versions(align):
    return align.backend_versions()


def check_alignment(align, languages):
    """--check --alignment: readiness per language, in process, offline."""
    entries = [_language_entry(lang, align.check_environment(lang)) for lang in languages]
    bad = [e for e in entries if e["status"] != "ready"]
    if bad:
        status, message = bad[0]["status"], bad[0]["message"]
    else:
        status, message = "ready", "Word alignment is ready for: %s." % ", ".join(languages)
    return alignment_summary(status, message, languages, entries, alignment_versions(align))


def setup_alignment(align, languages, environ):
    """Download and verify alignment assets. Returns (summary, exit code).

    The caller has already allowed network access in this process. No token
    is needed: the default models are public.
    """
    token = read_token(environ)
    versions = alignment_versions(align)
    entries = []
    try:
        progress("Word alignment: checking the Python environment...", 5)
        problem = align.python_problem()
        if problem:
            raise SetupError(*problem)

        models = {}
        for lang in languages:
            model = align.resolve_model(lang)
            if model is None:
                raise SetupError("language-unsupported", align.unsupported_language_message(lang))
            problem = align.dependency_problem(model)
            if problem:
                raise SetupError(*problem)
            models[lang] = model
            if model["licence"]:
                # From the registry; for example the VoxPopuli ASR weights.
                progress("Word alignment: note that the %s model for '%s' is licensed "
                         "%s." % (model["name"], lang, model["licence"]), 8)

        count = len(languages)
        for n, lang in enumerate(languages):
            model = models[lang]
            ready, _, _ = align.model_status(model)
            progress("Word alignment: %s the %s model for '%s'..."
                     % ("checking" if ready else "downloading", model["name"], lang),
                     15 + int(60 * n / count))
            try:
                fetch_alignment_model(align, lang)
            except align.AlignError as e:
                raise SetupError(e.code, e.message)
            except Exception as e:
                raise SetupError(*classify_alignment_error(e, token))

        progress("Word alignment: checking it works offline...", 80)
        for lang in languages:
            try:
                result = verify_alignment(align, lang, environ)
            except SetupError:
                raise
            except Exception as e:
                raise SetupError("verify-failed",
                                 "The offline alignment check failed: %s" % scrub(e, token))
            entries.append(_language_entry(lang, result))
            if result.get("status") != "ready":
                raise SetupError("verify-failed",
                                 "Downloaded, but the offline alignment check for '%s' "
                                 "failed: %s" % (lang, scrub(result.get("message",
                                                                     result.get("status")), token)))
            versions = result.get("versions") or versions

        progress("Word alignment: done", 100)
        return alignment_summary("ready", "Word alignment is ready for: %s." % ", ".join(languages),
                                 languages, entries, versions), 0
    except SetupError as e:
        message = scrub(e.message, token)
        emit_error(e.code, message)
        return alignment_summary(e.code, message, languages, entries, versions), 1
    except Exception as e:
        message = "Alignment setup failed: %s" % scrub(e, token)
        emit_error("setup-failed", message)
        return alignment_summary("setup-failed", message, languages, entries, versions), 1


def combined_summary(speaker, alignment):
    """One summary for both parts. "ready" only when both are ready."""
    if speaker["status"] == "ready" and alignment["status"] == "ready":
        status = "ready"
    elif speaker["status"] != "ready":
        status = speaker["status"]
    else:
        status = alignment["status"]
    message = "%s %s" % (speaker["message"], alignment["message"])
    return {"status": status, "message": message, "speaker": speaker, "alignment": alignment}


def run_with_alignment(args, environ, diarize, align):
    """--alignment: the speaker part (only if not prepared) and the alignment
    part, each reported on its own. Returns (summary, exit code)."""
    model, revision = args.model or diarize.DEFAULT_MODEL, args.revision or diarize.DEFAULT_REVISION
    try:
        languages = alignment_languages(args)
    except SetupError as e:
        emit_error(e.code, e.message)
        return {"status": e.code, "message": e.message}, 1

    if args.check:
        diarize.configure_environment(offline=True, environ=environ)
        align.configure_environment(offline=True, environ=environ)
        speaker, _ = run_speaker(args, environ, diarize)
        alignment = check_alignment(align, languages)
        return combined_summary(speaker, alignment), 0

    # Network allowed in this process only (both parts download); telemetry
    # off. This must happen before huggingface_hub or transformers is
    # imported, because they read these variables at import time.
    diarize.configure_environment(offline=False, environ=environ)
    align.configure_environment(offline=False, environ=environ)
    for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"):
        environ.pop(name, None)
    environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"

    progress("Speaker diarization: checking whether the model is already prepared...", 1)
    current = diarize.check_environment(model, revision)
    if current["status"] == "ready":
        speaker = make_summary("ready", "Speaker diarization is ready (already prepared).",
                               model, revision, current["versions"], current.get("modelPath"),
                               current.get("cudaAvailable"))
        speaker["action"] = "already-prepared"
        speaker_code = 0
    else:
        speaker, speaker_code = run_speaker(args, environ, diarize)
        speaker["action"] = "prepared" if speaker_code == 0 else "failed"

    alignment, alignment_code = setup_alignment(align, languages, environ)
    return combined_summary(speaker, alignment), (0 if speaker_code == 0 and alignment_code == 0 else 1)


def run(args, environ=None, diarize=None, align=None):
    """Return (summary dict, exit code). Prints progress and errors itself."""
    environ = os.environ if environ is None else environ
    diarize = diarize or load_diarize_module()
    if getattr(args, "alignment", None) is None:
        if getattr(args, "language", None):
            message = "--language is only used with --alignment."
            emit_error("bad-arguments", message)
            return {"status": "bad-arguments", "message": message}, 1
        return run_speaker(args, environ, diarize)
    align = align or load_align_module()
    return run_with_alignment(args, environ, diarize, align)


class _ScrubbingParser(argparse.ArgumentParser):
    """argparse echoes unrecognised arguments; never echo a token."""

    def error(self, message):
        argparse.ArgumentParser.error(self, re.sub(r"hf_\S+", "hf_***", message))


def build_parser():
    parser = _ScrubbingParser(
        description="Download and check the speaker diarization model, and "
                    "optionally the word-alignment model. Reads the Hugging "
                    "Face token from HF_TOKEN.")
    parser.add_argument("--check", action="store_true",
                        help="Report readiness without downloading anything")
    parser.add_argument("--model", default=None,
                        help="Pipeline repository id (evaluation only)")
    parser.add_argument("--revision", default=None,
                        help="Pipeline revision (evaluation only)")
    # nargs="?" with const "" so that a bare --alignment means the default
    # language and can still be combined with --language.
    parser.add_argument("--alignment", nargs="?", const="", default=None, metavar="LANGS",
                        help="Also prepare word alignment for these comma-separated "
                             "languages (default: en). Needs lib/requirements-alignment.txt")
    parser.add_argument("--language", default=None, metavar="LANGS",
                        help="Same as --alignment LANGS")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    summary, code = run(args)
    print(json.dumps(summary), flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())
