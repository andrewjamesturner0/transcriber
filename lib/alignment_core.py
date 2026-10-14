"""Word alignment kernel: places known words on wav2vec2 CTC emissions.

Used by lib/align.py. It receives one segment's emissions, the model's label
dictionary and blank id, the original words and the real crop sample range,
and returns one timing record per input word. It never sees audio, models
or output text, and never changes or reorders the words.

The path search is adapted from WhisperX 3.8.6, whisperx/alignment.py
(get_trellis, backtrack, merge_repeats and the wildcard column):
    https://github.com/m-bain/whisperX, tag v3.8.6,
    commit 3ccc17b8de34f305300f8a3fd3c9f76ba820c0d0
    Copyright (c) 2024, Max Bain. BSD 2-Clause License; full text in
    lib/third_party/whisperx-LICENSE.txt.
WhisperX took the trellis code from the TorchAudio forced-alignment
tutorial:
    https://github.com/pytorch/audio, tag v0.12.1,
    commit 58da31733e08438f9d1816f55f54756e53872a92,
    examples/tutorials/forced_alignment_tutorial.py
    Copyright (c) 2017 Facebook Inc. (Soumith Chintala). BSD 2-Clause
    License; full text in lib/third_party/torchaudio-LICENSE.txt.

The objective is the same simplified monotonic trellis, not full CTC:

    S[0, 0] = 0;  S[t, 0] = sum of blank scores before frame t
    S[0, j] = -inf for j >= 1
    S[t+1, j] = max(S[t, j] + E[t, blank],      stay (frame scored as blank)
                    S[t, j-1] + E[t, y_j])      token j starts at frame t

The path ends at the earliest row with the best score in the last column
(later frames are not scored) and is traced back taking "change" only when
it is strictly better than "stay". Adjacent identical labels need no blank
between them, so N tokens need at least N frames.

Changes from upstream:
  - No sentence splitting (NLTK Punkt), pandas tables, interpolation or LCS
    re-matching. Each token is owned by the input word it came from, so
    repeated words, case expansion (one character lowering to several code
    points) and multi-character Japanese/Chinese words keep their places.
  - Upstream's `S[-N:, 0] = +inf` is dropped. For N <= T it only touches
    cells that cannot reach the last column, so paths are unchanged, and
    `inf - inf = NaN` can no longer occur. N > T is reported as too short.
  - Bad input fails the segment with a reason instead of raising: NaN or
    +inf scores, no characters, too few frames, size limits, no finite path.
    -inf scores are allowed (an impossible emission).
  - The backtrack compares float32 sums with numpy float32 scalars (the same
    IEEE additions as upstream's 0-d tensors, much faster).
  - Times use the real crop samples and are clamped to the crop.
  - Words whose characters are all unknown to the model (wildcards, such as
    digits) or are the blank label keep their path times but are reported
    "interpolated" with no score, rather than "measured".

Scores are the mean, per token, of the probabilities of the frames assigned
to it (including blank stays), then the mean over the word's tokens. They are
not a probability that the word was recognised correctly.

torch and numpy are imported inside functions; importing this module is
cheap and has no third-party dependency.
"""

import math

SAMPLE_RATE = 16000
SEPARATOR = "|"

# Size limits. A segment over either is left unaligned (the caller keeps
# Whisper timing); text is never truncated. Whisper segments are at most
# about 30 s; the largest trellis allowed is 40 MB of float32.
MAX_CROP_SECONDS = 60
MAX_TRELLIS_CELLS = 10000000

KNOWN = "known"          # in the dictionary: acoustic evidence for a character
WEAK = "weak"            # in the dictionary, but the blank label or a literal "|"
WILDCARD = "wildcard"    # not in the dictionary: matched by the wildcard column
SEPARATOR_KIND = "separator"

UNALIGNED = {"startMs": None, "endMs": None, "score": None, "quality": "unaligned"}


def _unaligned(count):
    return [dict(UNALIGNED) for _ in range(count)]


def failed(reason, count):
    return {"status": "failed", "reason": reason, "words": _unaligned(count)}


# ---------------------------------------------------------------------------
# Crop and targets
# ---------------------------------------------------------------------------

def crop_samples(start_ms, end_ms, total_samples, sample_rate=SAMPLE_RATE):
    """Sample range [start, end) for a millisecond window, clamped to the audio.

    Multiplies before dividing so integer milliseconds give exact sample
    indices (upstream's int(ms / 1000 * rate) can lose a sample).
    """
    def to_sample(ms):
        return int(math.floor(ms * sample_rate / 1000.0 + 1e-6))
    start = min(max(to_sample(start_ms), 0), total_samples)
    end = min(max(to_sample(end_ms), 0), total_samples)
    return start, max(start, end)


def crop_problem(start, end, sample_rate=SAMPLE_RATE):
    """Reason a crop cannot be aligned before running the model, or None."""
    if end - start <= 0:
        return "too-short"
    if end - start > MAX_CROP_SECONDS * sample_rate:
        return "too-long"
    return None


def _label_id(dictionary, label, num_classes):
    code = dictionary.get(label)
    if isinstance(code, int) and not isinstance(code, bool) and 0 <= code < num_classes:
        return code
    return None


def build_targets(words, dictionary, blank_id, no_spaces, num_classes):
    """Target tokens for the words as if joined by single spaces.

    Returns a list of (label, id_or_None, owner_or_None, kind). id is None
    for a wildcard. Whitespace becomes one separator token per character,
    owned by no word, when the dictionary has "|" (never for no-space
    languages). Leading and trailing whitespace of the joined text gives no
    tokens. Every code point of a lowercased character is its own token,
    owned by that character's word.
    """
    owners = []
    for index, word in enumerate(words):
        if index:
            owners.append(None)
        owners.extend([index] * len(word))
    text = " ".join(words)
    first = len(text) - len(text.lstrip())
    last = len(text.rstrip())
    separator_id = None if no_spaces else _label_id(dictionary, SEPARATOR, num_classes)

    tokens = []
    for cdx in range(first, last):
        ch = text[cdx]
        if ch.isspace():
            if separator_id is not None:
                tokens.append((SEPARATOR, separator_id, None, SEPARATOR_KIND))
            continue
        owner = owners[cdx]
        for cp in ch.lower():
            code = _label_id(dictionary, cp, num_classes)
            if code is None:
                kind = WILDCARD
            elif code == blank_id or cp == SEPARATOR:
                kind = WEAK
            else:
                kind = KNOWN
            tokens.append((cp, code, owner, kind))
    return tokens


# ---------------------------------------------------------------------------
# Path search (adapted from WhisperX 3.8.6 / TorchAudio v0.12.1)
# ---------------------------------------------------------------------------

def add_wildcard(emission, blank_id):
    """Append one column: the best non-blank score in each frame.

    Not renormalised (as upstream). Returns (emission, wildcard id).
    """
    import torch
    mask = torch.ones(emission.size(1), dtype=torch.bool)
    mask[blank_id] = False
    column = emission[:, mask].max(dim=1).values
    return torch.cat([emission, column.unsqueeze(1)], dim=1), emission.size(1)


def get_trellis(emission, tokens, blank_id):
    """Best-path scores S[t, j] as a float32 tensor of shape [T + 1, N + 1]."""
    import torch
    num_frames = emission.size(0)
    num_tokens = len(tokens)
    trellis = torch.empty((num_frames + 1, num_tokens + 1), dtype=torch.float32)
    trellis[0, 0] = 0
    trellis[1:, 0] = torch.cumsum(emission[:, blank_id], 0)
    trellis[0, 1:] = -float("inf")
    blank = emission[:, blank_id]
    targets = emission[:, tokens]
    for t in range(num_frames):
        trellis[t + 1, 1:] = torch.maximum(
            trellis[t, 1:] + blank[t],        # stay on the same token
            trellis[t, :-1] + targets[t],     # change to the next token
        )
    return trellis


def backtrack(trellis, emission, tokens, blank_id):
    """Trace the best path. Returns [(token index, frame, probability)] in
    time order, or None when no finite path exists."""
    import numpy as np
    scores = trellis.numpy()
    em = emission.numpy()
    j = scores.shape[1] - 1
    column = scores[:, j]
    t_end = int(np.argmax(column))   # first maximum: the earliest end
    if not math.isfinite(float(column[t_end])) or t_end == 0:
        return None
    path = []
    for t in range(t_end, 0, -1):
        stayed = scores[t - 1, j] + em[t - 1, blank_id]
        changed = scores[t - 1, j - 1] + em[t - 1, tokens[j - 1]]
        moved = bool(changed > stayed)
        label = tokens[j - 1] if moved else blank_id
        # Same 0-d tensor exp as upstream, so scores round identically.
        path.append((j - 1, t - 1, emission[t - 1, label].exp().item()))
        if moved:
            j -= 1
            if j == 0:
                break
    else:
        return None
    path.reverse()
    return path


def merge_repeats(path):
    """One (token index, start frame, end frame exclusive, score) per token."""
    merged = []
    i1 = 0
    while i1 < len(path):
        i2 = i1
        while i2 < len(path) and path[i2][0] == path[i1][0]:
            i2 += 1
        score = sum(path[k][2] for k in range(i1, i2)) / (i2 - i1)
        merged.append((path[i1][0], path[i1][1], path[i2 - 1][1] + 1, score))
        i1 = i2
    return merged


# ---------------------------------------------------------------------------
# One segment
# ---------------------------------------------------------------------------

def _emission_problem(emission, blank_id):
    import torch
    if emission.dim() != 2 or emission.size(0) < 1 or emission.size(1) < 2:
        return True
    if not isinstance(blank_id, int) or not 0 <= blank_id < emission.size(1):
        return True
    return bool(torch.isnan(emission).any() or torch.isposinf(emission).any())


def align_segment(emission, words, dictionary, blank_id, no_spaces,
                  crop_start, crop_end, sample_rate=SAMPLE_RATE):
    """Align one segment's words. Returns {"status", "reason", "words"}.

    emission: [frames, classes] log scores for the crop (CPU tensor).
    crop_start, crop_end: the real sample range the emission came from,
    before any padding. Every word gets exactly one record.
    """
    count = len(words)
    problem = crop_problem(crop_start, crop_end, sample_rate)
    if problem:
        return failed(problem, count)
    lo_ms = -(-crop_start * 1000 // sample_rate)    # ceil
    hi_ms = crop_end * 1000 // sample_rate           # floor
    if lo_ms > hi_ms:
        return failed("too-short", count)

    emission = emission.float()
    if _emission_problem(emission, blank_id):
        return failed("invalid-emissions", count)
    num_frames, num_classes = emission.size(0), emission.size(1)

    targets = build_targets(words, dictionary, blank_id, no_spaces, num_classes)
    if not any(owner is not None for _, _, owner, _ in targets):
        return failed("no-characters", count)
    if len(targets) > num_frames:
        return failed("too-short", count)
    if (num_frames + 1) * (len(targets) + 1) > MAX_TRELLIS_CELLS:
        return failed("too-long", count)

    wildcard_id = None
    if any(kind == WILDCARD for _, _, _, kind in targets):
        emission, wildcard_id = add_wildcard(emission, blank_id)
    ids = [wildcard_id if code is None else code for _, code, _, _ in targets]

    trellis = get_trellis(emission, ids, blank_id)
    path = backtrack(trellis, emission, ids, blank_id)
    if path is None:
        return failed("no-path", count)
    spans = merge_repeats(path)

    # Frame clock: real crop samples, upstream's duration / frames scaling
    # and its two roundings (3 decimal seconds, then whole milliseconds).
    origin = crop_start / float(sample_rate)
    ratio = ((crop_end - crop_start) / float(sample_rate)) / num_frames
    owned = [[] for _ in range(count)]
    for token, start, end, score in spans:
        owner, kind = targets[token][2], targets[token][3]
        if owner is not None:
            owned[owner].append((round(start * ratio + origin, 3),
                                 round(end * ratio + origin, 3),
                                 round(score, 3), kind))

    records = []
    for parts in owned:
        if not parts:
            records.append(dict(UNALIGNED))
            continue
        start_ms = min(max(int(round(min(p[0] for p in parts) * 1000)), lo_ms), hi_ms)
        end_ms = min(max(int(round(max(p[1] for p in parts) * 1000)), lo_ms), hi_ms)
        if any(p[3] == KNOWN for p in parts):
            score = round(sum(p[2] for p in parts) / len(parts), 3)
            records.append({"startMs": start_ms, "endMs": end_ms, "score": score,
                            "quality": "measured"})
        else:
            records.append({"startMs": start_ms, "endMs": end_ms, "score": None,
                            "quality": "interpolated"})
    return {"status": "aligned", "reason": None, "words": records}
