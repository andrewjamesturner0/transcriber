#!/usr/bin/env python3
"""Real dependency-isolation check for word alignment (needs a prepared model).

Runs lib/align.py and scripts/setup-diarization.py in fresh child processes
of the interpreter running this script, from an unrelated working directory,
with:
  - imports of WhisperX, NLTK, pandas, the speech-recogniser packages and
    (for English) transformers blocked; any attempt is recorded and fails
    the check;
  - those packages' installed metadata hidden, so version probes see them
    as not installed;
  - NLTK data made invisible (a fresh HOME and an empty NLTK_DATA; the
    torch and Hugging Face caches are passed through explicitly);
  - external networking expected to be absent (run it under
    `unshare -Urn` on Linux); the check fails if a public host resolves,
    unless --allow-network is given.

It checks that cached English readiness and a real short alignment work,
that a Hugging Face language reports the missing transformers package
clearly (readiness and inference), and that no model cache file was added
or changed. Missing assets fail the check; nothing is skipped or fetched.

Usage:
    unshare -Urn "$CLEAN_ALIGN_PY" scripts/test-alignment-isolation.py \\
      --audio .build-whisper/samples/jfk.wav \\
      --input .agents/verification/local-alignment/jfk-input.json
"""

import argparse
import json
import math
import os
import shutil
import socket
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ALIGN = os.path.join(ROOT, "lib", "align.py")
SETUP = os.path.join(ROOT, "scripts", "setup-diarization.py")

REMOVED = ("whisperx", "nltk", "faster_whisper", "ctranslate2", "onnxruntime", "torchvision", "av")
# Import roots blocked for every alignment run; pandas is still installed
# (pyannote needs it) but alignment must not import it.
BLOCKED = REMOVED + ("pandas",)
HIDDEN = ("whisperx", "nltk", "faster-whisper", "ctranslate2", "onnxruntime", "torchvision", "av")

BOOTSTRAP = r'''
import atexit, importlib.abc, importlib.metadata as md, json, runpy, sys
cfg = json.loads(sys.argv[1])
script = sys.argv[2]
blocked = set(cfg["blocked"])
hidden = set(cfg["hidden"])
attempts = []

class Block(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in blocked:
            attempts.append(name)
            raise ImportError("blocked by the isolation check: %s" % name)
        return None

sys.meta_path.insert(0, Block())

def _norm(name):
    return str(name).lower().replace("_", "-")

_version, _distribution = md.version, md.distribution

def version(name):
    if _norm(name) in hidden:
        raise md.PackageNotFoundError(name)
    return _version(name)

def distribution(name):
    if _norm(name) in hidden:
        raise md.PackageNotFoundError(name)
    return _distribution(name)

md.version, md.distribution = version, distribution

def report():
    loaded = sorted(m for m in sys.modules if m.split(".")[0] in blocked)
    with open(cfg["report"], "w") as fp:
        json.dump({"attempts": attempts, "loaded": loaded}, fp)

atexit.register(report)
sys.argv = [script] + sys.argv[3:]
runpy.run_path(script, run_name="__main__")
'''

passed = 0
failed = 0


def result(ok, name, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print("  PASS: %s" % name)
    else:
        failed += 1
        print("  FAIL: %s -- %s" % (name, detail))
    return ok


def cache_dirs():
    """The torch hub and Hugging Face caches, found without importing them."""
    home = os.path.expanduser("~")
    xdg = os.environ.get("XDG_CACHE_HOME") or os.path.join(home, ".cache")
    torch_home = os.environ.get("TORCH_HOME") or os.path.join(xdg, "torch")
    hf_home = os.environ.get("HF_HOME") or os.path.join(xdg, "huggingface")
    return torch_home, hf_home


def snapshot(folders):
    """{path: (size, mtime)} for every file under the folders."""
    found = {}
    for folder in folders:
        for base, _dirs, files in os.walk(folder):
            for name in files:
                path = os.path.join(base, name)
                try:
                    st = os.stat(path)
                except OSError:
                    continue
                found[path] = (st.st_size, int(st.st_mtime))
    return found


class Child(object):
    def __init__(self, work, torch_home, hf_home):
        self.work = work
        self.env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": os.path.join(work, "home"),
            "TORCH_HOME": torch_home,
            "HF_HOME": hf_home,
            "NLTK_DATA": os.path.join(work, "nltk_data"),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        for key in ("SYSTEMROOT", "TEMP", "TMP", "CUDA_VISIBLE_DEVICES"):
            if key in os.environ:
                self.env[key] = os.environ[key]
        for folder in (self.env["HOME"], self.env["NLTK_DATA"]):
            os.makedirs(folder, exist_ok=True)
        self.count = 0

    def run(self, script, args, blocked=BLOCKED, hidden=HIDDEN, timeout=600):
        self.count += 1
        report = os.path.join(self.work, "imports-%d.json" % self.count)
        cfg = json.dumps({"blocked": list(blocked), "hidden": list(hidden), "report": report})
        proc = subprocess.run([sys.executable, "-I", "-c", BOOTSTRAP, cfg, script] + list(args),
                              cwd=self.work, env=self.env, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, universal_newlines=True, timeout=timeout)
        imports = {"attempts": ["(no import report)"], "loaded": []}
        if os.path.exists(report):
            with open(report) as fp:
                imports = json.load(fp)
        return proc, imports


def last_json(text):
    for line in reversed(text.strip().splitlines()):
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict):
            return obj
    return None


def error_code(stderr):
    for line in stderr.splitlines():
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict) and "code" in obj:
            return obj
    return None


def clean_imports(name, imports):
    return result(not imports["attempts"] and not imports["loaded"],
                  "%s: no forbidden import attempted or loaded" % name, json.dumps(imports))


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--audio", required=True, help="16 kHz mono 16-bit WAV")
    parser.add_argument("--input", required=True, help="Alignment request JSON (English)")
    parser.add_argument("--hf-language", default="nl", help="A Hugging Face language to probe")
    parser.add_argument("--allow-network", action="store_true",
                        help="Do not require external networking to be absent")
    args = parser.parse_args()

    for path in (args.audio, args.input):
        if not os.path.isfile(path):
            result(False, "inputs exist", "%s is missing" % path)
            return 1

    try:
        socket.getaddrinfo("huggingface.co", 443)
        online = True
    except OSError:
        online = False
    if not result(not online or args.allow_network, "external networking is unavailable",
                  "huggingface.co resolves; run under `unshare -Urn` or pass --allow-network"):
        return 1

    with open(args.input, encoding="utf-8") as fp:
        request = json.load(fp)
    words = sum(len(s["words"]) for s in request["segments"])

    torch_home, hf_home = cache_dirs()
    before = snapshot([torch_home, hf_home])
    work = tempfile.mkdtemp(prefix="alignment-isolation-")
    child = Child(work, torch_home, hf_home)
    english_blocked = BLOCKED + ("transformers",)
    english_hidden = HIDDEN + ("transformers",)
    try:
        print("\nEnglish without transformers, WhisperX or NLTK\n")
        proc, imports = child.run(ALIGN, ["--check", "--language", "en"], english_blocked, english_hidden)
        check = last_json(proc.stdout) or {}
        result(proc.returncode == 0 and check.get("status") == "ready",
               "align.py --check --language en is ready", proc.stdout[-500:] + proc.stderr[-500:])
        result(check.get("provider", {}).get("name") == "transcriber-align",
               "--check reports the local provider", json.dumps(check.get("provider")))
        result((check.get("versions") or {}).get("transformers") is None and
               check.get("punktReady") is None, "transformers hidden; Punkt not consulted",
               json.dumps(check.get("versions")))
        clean_imports("English --check", imports)

        output = os.path.join(work, "out.json")
        proc, imports = child.run(ALIGN, ["--audio", os.path.abspath(args.audio),
                                          "--input", os.path.abspath(args.input),
                                          "--output", output, "--device", "cpu"],
                                  english_blocked, english_hidden)
        ok = result(proc.returncode == 0 and os.path.isfile(output),
                    "a real English alignment runs", proc.stderr[-800:])
        if ok:
            with open(output, encoding="utf-8") as fp:
                env = json.load(fp)
            records = [w for s in env["segments"] for w in s["words"]]
            result(env.get("format") == "transcriber-alignment" and env.get("version") == 1 and
                   env["provider"]["name"] == "transcriber-align",
                   "envelope format 1 with the local provider", json.dumps(env.get("provider")))
            result(len(records) == words, "one record per input word",
                   "%d records for %d words" % (len(records), words))
            timed = [w for w in records if w["quality"] != "unaligned"]
            bounded = all(isinstance(w["startMs"], int) and isinstance(w["endMs"], int) and
                          0 <= w["startMs"] <= w["endMs"] and
                          (w["score"] is None or math.isfinite(w["score"])) for w in timed)
            result(timed and bounded, "timed words are finite and ordered",
                   "%d timed of %d" % (len(timed), len(records)))
            result(not any(w in json.dumps(env) for s in request["segments"] for w in s["words"]
                           if len(w) > 3), "no recognised text in the output")
        clean_imports("English alignment", imports)

        proc, imports = child.run(SETUP, ["--check", "--alignment", "en"],
                                  REMOVED + ("transformers",), english_hidden)
        summary = last_json(proc.stdout) or {}
        part = summary.get("alignment") or {}
        result(proc.returncode == 0 and part.get("status") == "ready",
               "setup --check --alignment en is ready", proc.stdout[-500:] + proc.stderr[-300:])
        clean_imports("setup --check", imports)

        print("\nHugging Face language without transformers\n")
        lang = args.hf_language
        proc, imports = child.run(ALIGN, ["--check", "--language", lang], english_blocked, english_hidden)
        check = last_json(proc.stdout) or {}
        result(check.get("status") == "alignment-missing" and "transformers" in (check.get("message") or ""),
               "--check --language %s reports missing transformers" % lang, json.dumps(check)[:500])
        clean_imports("%s --check" % lang, imports)

        hf_request = os.path.join(work, "hf-input.json")
        with open(hf_request, "w", encoding="utf-8") as fp:
            json.dump({"language": lang, "padMs": 200, "segments": [
                {"index": 0, "startMs": 0, "endMs": 1000, "words": ["test"]}]}, fp)
        proc, imports = child.run(ALIGN, ["--audio", os.path.abspath(args.audio), "--input", hf_request,
                                          "--output", os.path.join(work, "hf-out.json")],
                                  english_blocked, english_hidden)
        err = error_code(proc.stderr) or {}
        result(proc.returncode == 1 and err.get("code") == "alignment-missing" and
               "transformers" in err.get("error", ""),
               "a %s job fails clearly with alignment-missing" % lang, proc.stderr[-500:])
        clean_imports("%s job" % lang, imports)

        print("\nNo downloads\n")
        after = snapshot([torch_home, hf_home])
        changed = sorted(p for p in after if before.get(p) != after[p])
        result(not changed, "no model cache file was added or changed", ", ".join(changed[:5]))
        result(not os.listdir(child.env["NLTK_DATA"]) and
               not os.path.exists(os.path.join(child.env["HOME"], "nltk_data")),
               "no NLTK data was fetched")
    finally:
        shutil.rmtree(work, ignore_errors=True)

    print("\n%d passed, %d failed" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
