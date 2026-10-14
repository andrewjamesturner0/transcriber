#!/usr/bin/env python3
"""Tests for lib/alignment_core.py using real torch tensors.

Needs torch and numpy (run it with the alignment Python, for example
"$ALIGN_PY" scripts/test-alignment-core.py). If they cannot be imported the
script fails; it never skips. No model, audio or network is used.

The path tests compare the kernel with an independent brute-force oracle
that enumerates every monotonic path of a tiny matrix (each token starts at
a distinct frame, in order; frames before the first token and between
tokens are scored as blank; the frames after the chosen end are not scored)
and applies the documented tie rules: the earliest end with the best score,
then the earliest start for the last token, then the one before it, and so
on. It shares no code with the trellis.

Fixtures in scripts/fixtures/alignment/ are invented.

Usage:
    "$ALIGN_PY" scripts/test-alignment-core.py
"""

import importlib.util
import itertools
import json
import math
import os
import random
import sys
import types

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CORE_PATH = os.path.join(ROOT, "lib", "alignment_core.py")
MODELS_PATH = os.path.join(ROOT, "lib", "alignment_models.py")
FIXTURES = os.path.join(ROOT, "scripts", "fixtures", "alignment", "paths.json")
NEG_INF = float("-inf")

try:
    import numpy  # noqa: F401
    import torch
except Exception as e:  # noqa: BLE001
    print("FAIL: torch and numpy are required for this test (%s)" % e)
    sys.exit(1)


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


core = load(CORE_PATH, "transcriber_alignment_core")
models = load(MODELS_PATH, "transcriber_alignment_models")

passed = 0
failed = 0
_queue = []


def test(name):
    def wrap(fn):
        _queue.append((name, fn))
        return fn
    return wrap


def check(cond, msg="assertion failed"):
    if not cond:
        raise AssertionError(msg)


def tensor(rows):
    return torch.tensor([[NEG_INF if v == "-inf" else v for v in row] for row in rows],
                        dtype=torch.float32)


# --- Independent oracle ----------------------------------------------------

def oracle(E, tokens, blank):
    """Best path by enumeration. Returns (objective, end, starts) or None.

    E is a list of rows of Python floats/ints. Sums use Python floats in the
    obvious order; tests use integer scores so the sums are exact.
    """
    T, N = len(E), len(tokens)
    best = None
    for starts in itertools.combinations(range(T), N):
        for end in range(starts[-1] + 1, T + 1):
            total = 0.0
            owner = {s: k for k, s in enumerate(starts)}
            for t in range(end):
                total += E[t][tokens[owner[t]]] if t in owner else E[t][blank]
            if total == NEG_INF:
                continue
            key = (-total, end) + tuple(reversed(starts))
            if best is None or key < best[0]:
                best = (key, total, end, starts)
    if best is None:
        return None
    return best[1], best[2], best[3]


def oracle_spans(end, starts):
    bounds = list(starts) + [end]
    return [[bounds[k], bounds[k + 1]] for k in range(len(starts))]


def kernel(E, tokens, blank):
    em = tensor(E)
    trellis = core.get_trellis(em, tokens, blank)
    path = core.backtrack(trellis, em, tokens, blank)
    if path is None:
        return None
    last = trellis[:, -1]
    end_row = int(torch.argmax(last).item())
    spans = core.merge_repeats(path)
    return float(last[end_row].item()), end_row, spans


# --- Tests: path search against fixtures and the oracle ---------------------

@test("fixtures: documented tiny cases give their hand-enumerated results")
def _():
    with open(FIXTURES) as fp:
        cases = json.load(fp)["cases"]
    check(len(cases) == 6, len(cases))
    for case in cases:
        E = [[NEG_INF if v == "-inf" else v for v in row] for row in case["emission"]]
        got = kernel(E, case["tokens"], case["blank"])
        if case["objective"] is None:
            check(got is None, "%s: expected no path, got %s" % (case["id"], got))
            check(oracle(E, case["tokens"], case["blank"]) is None, case["id"])
            continue
        objective, end_row, spans = got
        check(objective == case["objective"] and end_row == case["endRow"], (case["id"], got))
        check([[s[1], s[2]] for s in spans] == case["spans"], (case["id"], spans))
        for s, want in zip(spans, case["scores"]):
            check(abs(s[3] - want) < 1e-6, (case["id"], s, want))
        o = oracle(E, case["tokens"], case["blank"])
        check(o[0] == case["objective"] and oracle_spans(o[1], o[2]) == case["spans"], (case["id"], o))


@test("oracle agreement: 3000 random integer matrices with ties, repeats and -inf")
def _():
    rng = random.Random(20261014)
    for trial in range(3000):
        T = rng.randint(1, 6)
        N = rng.randint(1, min(4, T))
        C = rng.randint(2, 4)
        blank = rng.randrange(C)
        E = [[float(rng.choice([0, -1, -1, -2, -2, -3, -5])) for _ in range(C)] for _ in range(T)]
        if rng.random() < 0.2:
            E[rng.randrange(T)][rng.randrange(C)] = NEG_INF
        tokens = [rng.randrange(C) for _ in range(N)]
        if rng.random() < 0.3 and N >= 2:
            tokens[1] = tokens[0]   # adjacent repeat
        o = oracle(E, tokens, blank)
        k = kernel(E, tokens, blank)
        if o is None:
            check(k is None, "trial %d: kernel found %s, oracle none" % (trial, k))
            continue
        check(k is not None, "trial %d: oracle %s, kernel none" % (trial, o))
        objective, end_row, spans = k
        check(objective == o[0], "trial %d objective %s vs %s" % (trial, objective, o[0]))
        check(end_row == o[1], "trial %d end %s vs %s" % (trial, end_row, o[1]))
        got = [[s[1], s[2]] for s in spans]
        check(got == oracle_spans(o[1], o[2]), "trial %d spans %s vs %s" % (trial, got, o))
        check([s[0] for s in spans] == list(range(N)), "one span per token")


@test("token scores are the mean frame probability, blank stays included")
def _():
    E = [[math.log(0.5), math.log(0.25)], [math.log(0.8), math.log(0.1)], [math.log(0.1), math.log(0.9)]]
    k = kernel(E, [1, 1], 0)
    spans = k[2]
    # Oracle path: token 0 at frame 0 then a blank stay, token 1 at frame 2.
    check([[s[1], s[2]] for s in spans] == [[0, 2], [2, 3]], spans)
    check(abs(spans[0][3] - (0.25 + 0.8) / 2) < 1e-6 and abs(spans[1][3] - 0.9) < 1e-6, spans)


@test("full CTC would differ: repeats need no blank and staying never repeats the label")
def _():
    # Two frames, tokens "aa": a full CTC alignment is impossible.
    check(kernel([[-1, -1], [-1, -1]], [1, 1], 0) is not None, "simplified path exists")
    # One token over two strong frames: the token keeps only the first frame.
    spans = kernel([[-5, 0], [-5, 0]], [1], 0)[2]
    check([[s[1], s[2]] for s in spans] == [[0, 1]], spans)


@test("wildcard column is the per-frame best non-blank score, not renormalised")
def _():
    em = tensor([[-1, -3, -2], [0, -9, -4]])
    out, wid = core.add_wildcard(em, 0)
    check(wid == 3 and out.shape == (2, 4), out.shape)
    check(out[:, 3].tolist() == [-2.0, -4.0], out[:, 3].tolist())
    out, wid = core.add_wildcard(em, 2)
    check(out[:, 3].tolist() == [-1.0, 0.0], out[:, 3].tolist())


@test("word scores round like upstream's pandas/numpy path, not Python round()")
def _():
    scores = [0.955, 0.999, 0.688, 0.516]
    check(round(sum(scores) / 4, 3) == 0.789, "Python round differs here")
    check(core.word_score(scores) == 0.79, core.word_score(scores))
    check(core.word_score([0.5]) == 0.5 and core.word_score([0.25, 0.75]) == 0.5, "plain means")


# --- Tests: word ownership and quality --------------------------------------

LABELS = ["-", "|", "a", "b", "c", "e", "i", "'"]
DICT = {label: i for i, label in enumerate(LABELS)}
STRONG = 0.0
WEAKSCORE = -12.0


def frames_for(labels, classes=len(LABELS)):
    """One frame per label: that label scores 0, the rest -12."""
    rows = []
    for label in labels:
        row = [WEAKSCORE] * classes
        row[label] = STRONG
        rows.append(row)
    return torch.tensor(rows, dtype=torch.float32)


def run(words, frame_labels, crop=(16000, None), no_spaces=False, dictionary=DICT, blank=0):
    em = frames_for([dictionary[label] if isinstance(label, str) else label for label in frame_labels],
                    classes=max(dictionary.values()) + 1)
    start = crop[0]
    end = crop[1] if crop[1] is not None else start + 320 * len(frame_labels)
    return core.align_segment(em, words, dictionary, blank, no_spaces, start, end)


def ms_of(frame, start=16000, frames=None, samples=None):
    ratio = (samples / 16000.0) / frames
    return int(round(round(frame * ratio + start / 16000.0, 3) * 1000))


@test("words map to their own frames; separators belong to no word")
def _():
    # frames: a b | c -> words "ab", "c"
    res = run(["ab", "c"], ["a", "b", "|", "c"])
    check(res["status"] == "aligned" and res["reason"] is None, res)
    w = res["words"]
    check(len(w) == 2 and all(x["quality"] == "measured" for x in w), w)
    check(w[0]["startMs"] == 1000 and w[0]["endMs"] == 1040, w[0])   # frames [0, 2)
    check(w[1]["startMs"] == 1060 and w[1]["endMs"] == 1080, w[1])   # frame [3, 4)
    check(w[0]["score"] == 1.0 and w[1]["score"] == 1.0, w)


@test("repeated words keep one record each, in order")
def _():
    res = run(["a", "a", "a"], ["a", "|", "a", "|", "a"])
    w = res["words"]
    check([x["startMs"] for x in w] == [1000, 1040, 1080], w)
    check([x["endMs"] for x in w] == [1020, 1060, 1100], w)


@test("wildcard-only and blank-label-only words are interpolated with no score")
def _():
    # "1" and "-" are not evidence; "a1" mixes a known letter with a wildcard.
    res = run(["a", "1", "-", "a1"], ["a", "|", "c", "|", "-", "|", "a", "c"])
    w = res["words"]
    check([x["quality"] for x in w] == ["measured", "interpolated", "interpolated", "measured"], w)
    check(w[1]["score"] is None and w[2]["score"] is None, w)
    check(w[1]["startMs"] is not None and w[1]["endMs"] >= w[1]["startMs"], w[1])
    check(w[3]["score"] is not None, w[3])


@test("an empty word owns nothing and is unaligned; neighbours still align")
def _():
    res = run(["a", "", "b"], ["a", "|", "|", "b"])
    w = res["words"]
    check([x["quality"] for x in w] == ["measured", "unaligned", "measured"], w)
    check(w[1] == core.UNALIGNED, w[1])


@test("no characters at all -> failed no-characters, every word unaligned")
def _():
    for words in ([], [""], ["", " "]):
        res = run(words, ["a"])
        check(res["status"] == "failed" and res["reason"] == "no-characters", res)
        check(len(res["words"]) == len(words), res)


@test("case expansion: every code point of a lowered character stays with its word")
def _():
    # U+0130 lowers to "i" + U+0307 (combining dot, unknown -> wildcard).
    res = run(["\u0130a", "b"], ["i", "c", "a", "|", "b"])
    w = res["words"]
    check(w[0]["startMs"] == 1000 and w[0]["endMs"] == 1060, w[0])   # frames [0, 3)
    check(w[1]["startMs"] == 1080 and w[1]["endMs"] == 1100, w[1])   # frame [4, 5)
    targets = core.build_targets(["\u0130a", "b"], DICT, 0, False, len(LABELS))
    check([t[0] for t in targets] == ["i", "\u0307", "a", "|", "b"], targets)
    check([t[2] for t in targets] == [0, 0, 0, None, 1], targets)


@test("combining marks and apostrophes are owned by their word")
def _():
    targets = core.build_targets(["cae\u0301", "e'"], DICT, 0, False, len(LABELS))
    check([t[2] for t in targets] == [0, 0, 0, 0, None, 1, 1], targets)
    check([t[3] for t in targets] == ["known", "known", "known", "wildcard", "separator",
                                      "known", "known"], targets)


@test("no-space languages: no separator tokens; multi-character words aggregate")
def _():
    # Like ja/zh: words "ab" and "c" with no separator between them.
    res = run(["ab", "c"], ["a", "b", "c"], no_spaces=True)
    w = res["words"]
    check(w[0]["startMs"] == 1000 and w[0]["endMs"] == 1040, w[0])
    check(w[1]["startMs"] == 1040 and w[1]["endMs"] == 1060, w[1])
    targets = core.build_targets(["ab", "c"], DICT, 0, True, len(LABELS))
    check(all(t[3] != "separator" for t in targets), targets)


@test("non-Latin scripts: Arabic and CJK labels work through the same ownership")
def _():
    arabic = {"<pad>": 0, "|": 1, "\u0645": 2, "\u0631": 3}
    res = run(["\u0645\u0631", "\u0645"], ["\u0645", "\u0631", "|", "\u0645"], dictionary=arabic)
    check([x["quality"] for x in res["words"]] == ["measured", "measured"], res)
    cjk = {"<pad>": 0, "\u4eca": 1, "\u65e5": 2, "\u96e8": 3}
    res = run(["\u4eca\u65e5", "\u96e8"], ["\u4eca", "\u65e5", "\u96e8"], dictionary=cjk, no_spaces=True)
    w = res["words"]
    check(w[0]["endMs"] == 1040 and w[1]["startMs"] == 1040, w)


@test("whitespace inside a word is a separator, not a wildcard character")
def _():
    targets = core.build_targets(["a\tb"], DICT, 0, False, len(LABELS))
    check([(t[0], t[2], t[3]) for t in targets] == [("a", 0, "known"), ("|", None, "separator"),
                                                     ("b", 0, "known")], targets)


@test("a dictionary without '|' gives no separator tokens")
def _():
    d = {"<pad>": 0, "a": 1, "b": 2}
    targets = core.build_targets(["a", "b"], d, 0, False, 3)
    check([t[0] for t in targets] == ["a", "b"], targets)


@test("dictionary ids outside the emission columns are treated as unknown")
def _():
    d = {"<pad>": 0, "a": 1, "b": 7}
    targets = core.build_targets(["ab"], d, 0, False, 3)
    check([t[3] for t in targets] == ["known", "wildcard"], targets)


@test("nonzero blank id at word level")
def _():
    hf = {"a": 0, "b": 1, "|": 2, "<pad>": 3}
    em = torch.tensor([[-12, -12, -12, 0], [0, -12, -12, -12], [-12, -12, 0, -12], [-12, 0, -12, -12]],
                      dtype=torch.float32)
    res = core.align_segment(em, ["a", "b"], hf, 3, False, 0, 1280)
    w = res["words"]
    check(res["status"] == "aligned" and w[0]["startMs"] == 20 and w[1]["startMs"] == 60, res)


# --- Tests: clock, bounds and failures ---------------------------------------

@test("frame clock: origin and scale come from the real crop samples")
def _():
    # 7 frames over 2245 samples starting at sample 48000 (3.0 s).
    em = frames_for([DICT[x] for x in ["-", "a", "-", "|", "b", "-", "-"]])
    res = core.align_segment(em, ["a", "b"], DICT, 0, False, 48000, 50245)
    w = res["words"]
    ratio = (2245 / 16000.0) / 7
    check(w[0]["startMs"] == int(round(round(1 * ratio + 3.0, 3) * 1000)), w[0])
    check(w[1]["endMs"] == int(round(round(5 * ratio + 3.0, 3) * 1000)), w[1])
    check(w[0]["startMs"] == 3020 and w[1]["endMs"] == 3100, w)


@test("padded crop: 240 samples, one frame, times stay inside 1000-1015 ms")
def _():
    em = frames_for([DICT["a"]])
    res = core.align_segment(em, ["a"], DICT, 0, False, 16000, 16240)
    check(res["words"][0]["startMs"] == 1000 and res["words"][0]["endMs"] == 1015, res)
    res = core.align_segment(em, ["ab"], DICT, 0, False, 16000, 16240)
    check(res["status"] == "failed" and res["reason"] == "too-short", res)


@test("times are clamped to the crop at the end of the audio")
def _():
    # Crop 8715800-8716121 (the real end at 544757.5625 ms), one frame: the
    # rounded end 544.758 s would pass the audio; it is clamped to 544757.
    em = frames_for([DICT["a"]])
    res = core.align_segment(em, ["a"], DICT, 0, False, 8715800, 8716121)
    w = res["words"][0]
    check(w["endMs"] == 544757 and w["startMs"] == 544738, w)


@test("crop_samples: integer ms are exact; clamped to the audio")
def _():
    check(core.crop_samples(6011, 7011, 10 ** 7) == (96176, 112176), core.crop_samples(6011, 7011, 10 ** 7))
    bad = [ms for ms in range(0, 600000, 7) if int(ms / 1000.0 * 16000) != ms * 16]
    check(bad, "upstream truncation really loses samples")
    for ms in bad[:200]:
        check(core.crop_samples(ms, ms + 1, 10 ** 8)[0] == ms * 16, ms)
    check(core.crop_samples(544757.5625, 544957.5625, 8716121) == (8716121, 8716121), "end clamp")
    check(core.crop_samples(-5, 10, 100) == (0, 100), core.crop_samples(-5, 10, 100))


@test("NaN or +inf scores -> invalid-emissions; -inf alone is allowed")
def _():
    for value in (float("nan"), float("inf")):
        em = frames_for([DICT["a"], DICT["b"]])
        em[1, 3] = value
        res = core.align_segment(em, ["ab"], DICT, 0, False, 0, 640)
        check(res["status"] == "failed" and res["reason"] == "invalid-emissions", res)
    em = frames_for([DICT["a"], DICT["b"]])
    em[0, 5] = NEG_INF
    check(core.align_segment(em, ["ab"], DICT, 0, False, 0, 640)["status"] == "aligned", "neg inf ok")


@test("every path impossible -> no-path; malformed emission or blank -> invalid-emissions")
def _():
    em = frames_for([DICT["a"], DICT["a"]])
    em[:, DICT["b"]] = NEG_INF
    res = core.align_segment(em, ["b"], DICT, 0, False, 0, 640)
    check(res["status"] == "failed" and res["reason"] == "no-path", res)
    res = core.align_segment(torch.zeros(0, 8), ["a"], DICT, 0, False, 0, 640)
    check(res["reason"] == "invalid-emissions", res)
    res = core.align_segment(frames_for([2]), ["a"], DICT, 99, False, 0, 640)
    check(res["reason"] == "invalid-emissions", res)


@test("size limits: crop over 60 s or an oversized trellis -> too-long, words kept whole")
def _():
    em = frames_for([DICT["a"]] * 4)
    res = core.align_segment(em, ["a", "b"], DICT, 0, False, 0, 60 * 16000 + 1)
    check(res["status"] == "failed" and res["reason"] == "too-long" and len(res["words"]) == 2, res)
    check(core.crop_problem(0, 60 * 16000) is None and core.crop_problem(5, 5) == "too-short", "limits")
    saved = core.MAX_TRELLIS_CELLS
    core.MAX_TRELLIS_CELLS = 10
    try:
        res = core.align_segment(em, ["ab"], DICT, 0, False, 0, 1280)
    finally:
        core.MAX_TRELLIS_CELLS = saved
    check(res["reason"] == "too-long", res)


@test("empty crop or a crop under one millisecond -> too-short")
def _():
    em = frames_for([DICT["a"]])
    check(core.align_segment(em, ["a"], DICT, 0, False, 100, 100)["reason"] == "too-short", "empty")
    check(core.align_segment(em, ["a"], DICT, 0, False, 1, 2)["reason"] == "too-short", "sub-ms")


@test("every record is finite, ordered, inside the crop and uses known qualities")
def _():
    rng = random.Random(7)
    for _trial in range(200):
        T = rng.randint(3, 30)
        em = torch.log_softmax(torch.tensor([[rng.uniform(-4, 4) for _ in LABELS] for _ in range(T)]), -1)
        words = ["".join(rng.choice("abce1-'") for _ in range(rng.randint(0, 3)))
                 for _ in range(rng.randint(1, 5))]
        start = rng.randint(0, 50000)
        end = start + rng.randint(1, 320 * T)
        res = core.align_segment(em, words, DICT, 0, False, start, end)
        check(len(res["words"]) == len(words), res)
        for w in res["words"]:
            check(w["quality"] in ("measured", "interpolated", "unaligned"), w)
            if w["quality"] == "unaligned":
                check(w == core.UNALIGNED, w)
                continue
            check(isinstance(w["startMs"], int) and isinstance(w["endMs"], int), w)
            check(start * 1000 / 16000.0 - 1 < w["startMs"] <= w["endMs"] <= end * 1000 / 16000.0, (w, start, end))
            check((w["score"] is None) == (w["quality"] == "interpolated"), w)
            if w["score"] is not None:
                check(0 <= w["score"] <= 1 and math.isfinite(w["score"]), w)


# --- Tests: emissions adapter (real tensors, fake networks) -----------------

class FakeTorchaudioNet(torch.nn.Module):
    def __init__(self):
        torch.nn.Module.__init__(self)
        self.calls = []

    def forward(self, x, lengths=None):
        self.calls.append((tuple(x.shape), None if lengths is None else lengths.tolist()))
        frames = (x.shape[-1] - 400) // 320 + 1
        return torch.zeros(1, frames, 3), None


class FakeHfNet(torch.nn.Module):
    def __init__(self):
        torch.nn.Module.__init__(self)
        self.calls = []

    def forward(self, x):
        self.calls.append(tuple(x.shape))
        frames = (x.shape[-1] - 400) // 320 + 1
        return types.SimpleNamespace(logits=torch.zeros(1, frames, 4))


@test("emissions: short torchaudio crops are padded to 400 with the real length")
def _():
    net = FakeTorchaudioNet()
    loaded = models.LoadedModel({"backend": "torchaudio"}, net, {"-": 0}, 0)
    out = loaded.emissions(torch.zeros(1, 240))
    check(net.calls == [((1, 400), [240])], net.calls)
    check(tuple(out.shape) == (1, 3), out.shape)
    check(abs(float(out.exp().sum()) - 1.0) < 1e-5, "log-softmax over classes")
    loaded.emissions(torch.zeros(1, 1040))
    check(net.calls[-1] == ((1, 1040), None), net.calls)


@test("emissions: HF crops are padded but get no lengths or mask")
def _():
    net = FakeHfNet()
    loaded = models.LoadedModel({"backend": "huggingface"}, net, {"<pad>": 0}, 0)
    out = loaded.emissions(torch.zeros(1, 100))
    check(net.calls == [(1, 400)] and tuple(out.shape) == (1, 4), (net.calls, out.shape))


def main():
    global passed, failed
    for name, fn in _queue:
        try:
            fn()
            print("  PASS: %s" % name)
            passed += 1
        except Exception as e:  # noqa: BLE001 - report every failure
            print("  FAIL: %s -- %s: %s" % (name, type(e).__name__, e))
            failed += 1
    print("\n%d passed, %d failed" % (passed, failed))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
