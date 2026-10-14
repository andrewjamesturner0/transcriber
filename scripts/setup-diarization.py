#!/usr/bin/env python3
"""Prepare the speaker diarization model. Explicit, user-run, uses the network.

Downloads the pinned pyannote Community-1 snapshot into the standard Hugging
Face cache, then checks in a fresh offline process that lib/diarize.py can
load it. After this, diarization runs fully offline and needs no token.

Usage:
    HF_TOKEN=hf_... python scripts/setup-diarization.py
    python scripts/setup-diarization.py --check
    python scripts/setup-diarization.py --model ID --revision SHA   (evaluation only)

Before the first run:
    1. Accept the model licence at
       https://hf.co/pyannote/speaker-diarization-community-1
    2. Create a read token at https://hf.co/settings/tokens
    3. Put it in the HF_TOKEN environment variable (HUGGING_FACE_HUB_TOKEN
       also works).

The token is read only from the environment. It is never accepted on the
command line and never printed.

Output: JSON progress lines {"message", "percent"} on stderr, plus one
{"error", "code"} line on failure; one JSON summary object on stdout.
Exit 0 when ready (--check always exits 0), 1 on failure.
"""

import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys

TOKEN_ENV_VARS = ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN")
TOKEN_PAGE = "https://hf.co/settings/tokens"
VERIFY_TIMEOUT_SEC = 600

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
    """Download the snapshot into the default Hugging Face cache."""
    from huggingface_hub import snapshot_download
    return snapshot_download(repo_id=model, revision=revision, token=token)


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

def run(args, environ=None, diarize=None):
    """Return (summary dict, exit code). Prints progress and errors itself."""
    environ = os.environ if environ is None else environ
    diarize = diarize or load_diarize_module()
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


class _ScrubbingParser(argparse.ArgumentParser):
    """argparse echoes unrecognised arguments; never echo a token."""

    def error(self, message):
        argparse.ArgumentParser.error(self, re.sub(r"hf_\S+", "hf_***", message))


class _NotAvailableYet(argparse.Action):
    def __call__(self, parser, namespace, values, option_string=None):
        parser.error("%s is not available yet" % option_string)


def build_parser():
    parser = _ScrubbingParser(
        description="Download and check the speaker diarization model. "
                    "Reads the Hugging Face token from HF_TOKEN.")
    parser.add_argument("--check", action="store_true",
                        help="Report readiness without downloading anything")
    parser.add_argument("--model", default=None,
                        help="Pipeline repository id (evaluation only)")
    parser.add_argument("--revision", default=None,
                        help="Pipeline revision (evaluation only)")
    # Phase 3 hook: --alignment will also prepare the word-alignment model.
    # Not implemented yet, so it is rejected rather than silently ignored.
    parser.add_argument("--alignment", nargs="?", action=_NotAvailableYet,
                        help="Prepare the word-alignment model (not available yet)")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    summary, code = run(args)
    print(json.dumps(summary), flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())
