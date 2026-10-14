#!/usr/bin/env python3
"""Real alignment runtime check against a frozen reference (needs a prepared model).

Runs lib/align.py with the interpreter running this script, in fresh child
processes from an unrelated working directory, on saved inputs: one untimed
warm-up run, then --runs timed runs. Each child has WhisperX, NLTK, pandas
and the speech-recogniser packages blocked (and transformers too when the
language's model is a torchaudio one); an attempted import fails the check.

It then compares the first timed result with --baseline position by
position and reports counts only (never text):
  - hard failures: a different segment set or word count, a non-finite,
    reversed or out-of-audio time, a word or segment that newly lost its
    alignment, a requested CUDA run that fell back to the CPU, a failed
    run, or a slower median wall time than --max-slowdown x the baseline
    timing when --baseline-timing is given;
  - reported: identical records, quality changes, changed starts, ends and
    scores with their sizes, and the changed (segment, position) pairs.

Speaker effects are measured separately with scripts/evaluate-diarization.js
on the written envelope. Wall time runs from spawn to exit (imports, model
load, alignment and writing); processingSec, import and model-load phases
and peak RSS (Linux) are reported separately.

Missing inputs or an unprepared model exit 2 ("unavailable"), never 0.
Nothing is fetched. External networking is expected to be absent (run under
`unshare -Urn` on Linux); pass --allow-network to skip that requirement.

Usage:
    unshare -Urn "$CLEAN_ALIGN_PY" scripts/test-alignment-runtime.py \\
      --audio Examples/baseline-a08e386/input-16k-mono.wav \\
      --input Examples/baseline-a08e386/align-input-ordinarytext.json \\
      --baseline Examples/alignment-replacement-baseline/cpu-alignment.json \\
      --output-dir Examples/alignment-replacement/cpu --device cpu
"""

import argparse
import importlib.util
import json
import math
import os
import shutil
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import wave

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ALIGN = os.path.join(ROOT, "lib", "align.py")
ISOLATION = os.path.join(ROOT, "scripts", "test-alignment-isolation.py")

EXIT_FAILED = 1
EXIT_UNAVAILABLE = 2


def load_by_path(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def audio_duration_ms(path):
    with wave.open(path, "rb") as wf:
        return wf.getnframes() * 1000.0 / wf.getframerate()


def run_once(cmd, cwd, env, out_path):
    """Spawn, timestamp stderr progress, wait. Returns a run record."""
    started = time.monotonic()
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, universal_newlines=True)
    events = []
    stdout = []

    def read_err():
        for line in proc.stderr:
            now = time.monotonic() - started
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if isinstance(obj, dict):
                events.append((round(now, 3), obj))

    def read_out():
        stdout.append(proc.stdout.read())

    threads = [threading.Thread(target=read_err), threading.Thread(target=read_out)]
    for t in threads:
        t.start()
    rss_mb = None
    if hasattr(os, "wait4"):
        _pid, status, usage = os.wait4(proc.pid, 0)
        proc.returncode = os.waitstatus_to_exitcode(status)
        rss_mb = round(usage.ru_maxrss / 1024.0, 1)  # KB on Linux
    else:
        proc.wait()
    wall = time.monotonic() - started
    for t in threads:
        t.join()

    first = {}
    for t, obj in events:
        pct = obj.get("percent")
        if pct is not None and pct not in first:
            first[pct] = t

    def span(a, b):
        return round(first[b] - first[a], 3) if a in first and b in first else None

    envelope = None
    if proc.returncode == 0 and os.path.isfile(out_path):
        with open(out_path, encoding="utf-8") as fp:
            envelope = json.load(fp)
    errors = [obj for _, obj in events if "code" in obj]
    return {
        "exitCode": proc.returncode,
        "wallSec": round(wall, 3),
        "peakRssMb": rss_mb,
        "importSec": span(5, 15),
        "modelLoadSec": span(20, 25),
        "alignPhaseSec": span(25, 100),
        "processingSec": envelope.get("processingSec") if envelope else None,
        "device": envelope.get("device") if envelope else None,
        "error": errors[0] if errors else None,
        "envelope": envelope,
    }


def compare(baseline, candidate, duration_ms):
    """Position-by-position comparison. Returns (problems, report)."""
    problems = []
    report = {"words": 0, "identical": 0, "qualityChanges": {}, "startChanged": 0, "endChanged": 0,
              "scoreChanged": 0, "maxStartDeltaMs": 0, "maxEndDeltaMs": 0, "maxScoreDelta": 0.0,
              "changedPositions": [], "candidateQuality": {}, "baselineQuality": {},
              "segmentStatusChanges": []}
    base = dict((s["index"], s) for s in baseline["segments"])
    cand = dict((s["index"], s) for s in candidate["segments"])
    if sorted(base) != sorted(cand):
        problems.append("segment indices differ from the baseline")
        return problems, report
    for index in sorted(base):
        b, c = base[index], cand[index]
        if b["status"] != c["status"]:
            report["segmentStatusChanges"].append([index, b["status"], c["status"], c.get("reason")])
            if b["status"] == "aligned":
                problems.append("segment %d lost its alignment (%s)" % (index, c.get("reason")))
        if len(b["words"]) != len(c["words"]):
            problems.append("segment %d has %d words, baseline %d" % (index, len(c["words"]), len(b["words"])))
            continue
        for k, (x, y) in enumerate(zip(b["words"], c["words"])):
            report["words"] += 1
            for side, rec in (("baselineQuality", x), ("candidateQuality", y)):
                report[side][rec["quality"]] = report[side].get(rec["quality"], 0) + 1
            if y["quality"] != "unaligned":
                ok = (isinstance(y["startMs"], int) and isinstance(y["endMs"], int) and
                      0 <= y["startMs"] <= y["endMs"] <= math.ceil(duration_ms) and
                      (y["score"] is None or (isinstance(y["score"], float) and math.isfinite(y["score"]))))
                if not ok:
                    problems.append("segment %d word %d has an invalid record" % (index, k))
            if x == y:
                report["identical"] += 1
                continue
            report["changedPositions"].append([index, k])
            if x["quality"] != y["quality"]:
                key = "%s->%s" % (x["quality"], y["quality"])
                report["qualityChanges"][key] = report["qualityChanges"].get(key, 0) + 1
                if y["quality"] == "unaligned":
                    problems.append("segment %d word %d newly unaligned" % (index, k))
            if x["startMs"] is not None and y["startMs"] is not None:
                for field, count, biggest in (("startMs", "startChanged", "maxStartDeltaMs"),
                                              ("endMs", "endChanged", "maxEndDeltaMs")):
                    if x[field] != y[field]:
                        report[count] += 1
                        report[biggest] = max(report[biggest], abs(x[field] - y[field]))
            if x["score"] is not None and y["score"] is not None and x["score"] != y["score"]:
                report["scoreChanged"] += 1
                report["maxScoreDelta"] = round(max(report["maxScoreDelta"], abs(x["score"] - y["score"])), 3)
    return problems, report


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--audio", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--baseline", required=True, help="Reference envelope from the same device")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--device", required=True, choices=("cpu", "cuda"))
    parser.add_argument("--language", default=None, help="Override the request's language")
    parser.add_argument("--runs", type=int, default=3, help="Timed runs after one warm-up (default 3)")
    parser.add_argument("--baseline-timing", default=None,
                        help="JSON with medianWallSec for the paired baseline (enables the speed gate)")
    parser.add_argument("--max-slowdown", type=float, default=1.25)
    parser.add_argument("--allow-network", action="store_true")
    args = parser.parse_args()

    for label, path in (("audio", args.audio), ("input", args.input), ("baseline", args.baseline)):
        if not os.path.isfile(path):
            print("UNAVAILABLE: %s %s is missing" % (label, path))
            return EXIT_UNAVAILABLE
    if args.baseline_timing and not os.path.isfile(args.baseline_timing):
        print("UNAVAILABLE: baseline timing %s is missing" % args.baseline_timing)
        return EXIT_UNAVAILABLE
    try:
        socket.getaddrinfo("huggingface.co", 443)
        if not args.allow_network:
            print("FAIL: external networking is available; run under `unshare -Urn` or pass --allow-network")
            return EXIT_FAILED
    except OSError:
        pass

    with open(args.input, encoding="utf-8") as fp:
        request = json.load(fp)
    if args.language:
        request["language"] = args.language
    models = load_by_path("transcriber_alignment_models_runtime", os.path.join(ROOT, "lib", "alignment_models.py"))
    spec = models.resolve(request.get("language"))
    if spec is None:
        print("FAIL: no alignment model for language %r" % request.get("language"))
        return EXIT_FAILED
    isolation = load_by_path("transcriber_isolation_runtime", ISOLATION)
    blocked = list(isolation.BLOCKED) + (["transformers"] if spec["backend"] == "torchaudio" else [])

    out_dir = os.path.abspath(args.output_dir)
    os.makedirs(out_dir, exist_ok=True)
    work = tempfile.mkdtemp(prefix="alignment-runtime-")
    request_path = os.path.join(work, "request.json")
    with open(request_path, "w", encoding="utf-8") as fp:
        json.dump(request, fp)
    torch_home, hf_home = isolation.cache_dirs()
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.path.join(work, "home"),
           "TORCH_HOME": torch_home, "HF_HOME": hf_home, "NLTK_DATA": os.path.join(work, "nltk"),
           "PYTHONDONTWRITEBYTECODE": "1"}
    for key in ("SYSTEMROOT", "TEMP", "TMP", "CUDA_VISIBLE_DEVICES"):
        if key in os.environ:
            env[key] = os.environ[key]
    os.makedirs(env["HOME"])

    runs = []
    try:
        for n in range(args.runs + 1):
            label = "warmup" if n == 0 else "run%d" % n
            out_path = os.path.join(out_dir, "%s-%s.json" % (args.device, label))
            if os.path.exists(out_path):
                os.remove(out_path)
            report_path = os.path.join(work, "imports-%s.json" % label)
            cfg = json.dumps({"blocked": blocked, "hidden": list(isolation.HIDDEN), "report": report_path})
            cmd = [sys.executable, "-I", "-c", isolation.BOOTSTRAP, cfg, ALIGN,
                   "--audio", os.path.abspath(args.audio), "--input", request_path,
                   "--output", out_path, "--device", args.device]
            record = run_once(cmd, work, env, out_path)
            imports = {"attempts": ["(no import report)"], "loaded": []}
            if os.path.exists(report_path):
                with open(report_path) as fp:
                    imports = json.load(fp)
            record["label"] = label
            record["forbiddenImports"] = imports
            runs.append(record)
            print(json.dumps({k: record[k] for k in ("label", "exitCode", "wallSec", "peakRssMb", "importSec",
                                                    "modelLoadSec", "processingSec", "device")}))
            if record["exitCode"] != 0:
                code = (record["error"] or {}).get("code")
                message = (record["error"] or {}).get("error", "")
                if code in ("model-not-prepared", "alignment-missing", "python-unsupported"):
                    print("UNAVAILABLE: %s: %s" % (code, message[:300]))
                    return EXIT_UNAVAILABLE
                print("FAIL: run %s exited %s: %s" % (label, record["exitCode"], message[:300]))
                return EXIT_FAILED
    finally:
        shutil.rmtree(work, ignore_errors=True)

    problems = []
    for r in runs:
        if r["forbiddenImports"]["attempts"] or r["forbiddenImports"]["loaded"]:
            problems.append("%s attempted forbidden imports: %s" % (r["label"], r["forbiddenImports"]))
        if args.device == "cuda" and r["device"] != "cuda":
            problems.append("%s requested CUDA but ran on %s" % (r["label"], r["device"]))
    timed = [r for r in runs if r["label"] != "warmup"]
    envelopes = [r.pop("envelope") for r in runs]
    candidate = envelopes[1]
    for r, e in zip(timed[1:], envelopes[2:]):
        if e["segments"] != candidate["segments"]:
            problems.append("%s differs from run1: results are not deterministic" % r["label"])
    if candidate["provider"]["name"] != "transcriber-align":
        problems.append("unexpected provider %s" % candidate["provider"])

    with open(args.baseline, encoding="utf-8") as fp:
        baseline = json.load(fp)
    duration = audio_duration_ms(args.audio)
    cmp_problems, comparison = compare(baseline, candidate, duration)
    problems.extend(cmp_problems)

    timing = {
        "medianWallSec": statistics.median(r["wallSec"] for r in timed),
        "medianProcessingSec": statistics.median(r["processingSec"] for r in timed),
        "medianImportSec": statistics.median(r["importSec"] for r in timed if r["importSec"] is not None),
        "medianModelLoadSec": statistics.median(r["modelLoadSec"] for r in timed if r["modelLoadSec"] is not None),
        "maxPeakRssMb": max((r["peakRssMb"] or 0) for r in timed) or None,
    }
    if args.baseline_timing:
        with open(args.baseline_timing) as fp:
            base_timing = json.load(fp)
        limit = round(base_timing["medianWallSec"] * args.max_slowdown, 3)
        timing.update({"baselineMedianWallSec": base_timing["medianWallSec"], "limitWallSec": limit,
                       "ratio": round(timing["medianWallSec"] / base_timing["medianWallSec"], 3)})
        if timing["medianWallSec"] > limit:
            problems.append("median wall %.3f s is over the limit %.3f s" % (timing["medianWallSec"], limit))

    shutil.copyfile(os.path.join(out_dir, "%s-run1.json" % args.device),
                    os.path.join(out_dir, "%s-alignment.json" % args.device))
    report = {
        "device": args.device,
        "language": request.get("language"),
        "provider": candidate["provider"],
        "baselineProvider": baseline.get("provider"),
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "runs": runs,
        "timing": timing,
        "comparison": comparison,
        "problems": problems,
    }
    with open(os.path.join(out_dir, "%s-runtime-report.json" % args.device), "w") as fp:
        json.dump(report, fp, indent=2)

    summary = dict(comparison)
    summary.pop("changedPositions")
    print(json.dumps({"timing": timing, "comparison": summary}, indent=1))
    for p in problems:
        print("FAIL: %s" % p)
    print("%s: %d problem(s)" % ("PASS" if not problems else "FAIL", len(problems)))
    return EXIT_FAILED if problems else 0


if __name__ == "__main__":
    sys.exit(main())
