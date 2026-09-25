#!/usr/bin/env python3
"""
Transcription regression check for the Scrit Cribbler backend.

A case is a directory (kept OUT of the repo: it can hold real voices):
  <case>/audio/<speaker>.ogg     one track per speaker, same timeline
  <case>/reference.tsv           <speaker>\t<what was actually said>   (in spoken order)
  <case>/terms.txt               names/items that must come out right, one per line (optional)
  <case>/vocab.txt               campaign vocabulary sent to the backend (optional)

For each case and model it sends every track to /transcribe-chunk, merges lines by time,
and reports:
  WER          word error rate of all speech against the reference (lower is better)
  terms        how many terms.txt entries appear in the transcript (case-insensitive)
  order        fraction of reference lines whose speaker order is preserved
  seconds      backend time for all tracks

Usage:
  tests/transcribe_eval.py --url https://192.168.0.27:5443 --token-file ../recorder/.env \
      --ca ~/Projects/sessionrecapper/pki/ca.crt --models base,small CASE_DIR [CASE_DIR ...]
  Add --vocab to also send vocab.txt (compare with and without), --show to print transcripts.
"""
import argparse
import json
import re
import ssl
import sys
import time
import urllib.request
import uuid
from pathlib import Path


def words(text):
    return re.findall(r"[a-z0-9']+", text.lower().replace("’", "'"))


def wer(ref, hyp):
    """Word-level Levenshtein distance / reference length."""
    r, h = words(ref), words(hyp)
    prev = list(range(len(h) + 1))
    for i, rw in enumerate(r, 1):
        cur = [i] + [0] * len(h)
        for j, hw in enumerate(h, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (rw != hw))
        prev = cur
    return prev[-1] / max(len(r), 1)


def speaker_order(reference, lines):
    """Fraction of consecutive reference speaker changes that appear in the same order in the transcript."""
    ref_turns = [s for i, (s, _) in enumerate(reference) if i == 0 or reference[i - 1][0] != s]
    hyp_turns = [l["speaker"] for i, l in enumerate(lines) if i == 0 or lines[i - 1]["speaker"] != l["speaker"]]
    # Longest common subsequence of speaker turns, relative to the reference.
    m, n = len(ref_turns), len(hyp_turns)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m):
        for j in range(n):
            dp[i + 1][j + 1] = dp[i][j] + 1 if ref_turns[i] == hyp_turns[j] else max(dp[i][j + 1], dp[i + 1][j])
    return dp[m][n] / max(m, 1)


def post_track(url, token, ctx, path, speaker, model, vocab):
    boundary = uuid.uuid4().hex
    fields = {"speaker": speaker, "model": model}
    if vocab:
        fields["vocab"] = vocab
    body = b""
    for k, v in fields.items():
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"{path.name}\"\r\n"
             "Content-Type: audio/ogg\r\n\r\n").encode() + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"{url}/transcribe-chunk", data=body, method="POST", headers={
        "Authorization": f"Bearer {token}", "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, context=ctx, timeout=3600) as res:
        return json.load(res)


def run_case(case, model, args, ctx, token):
    reference = [tuple(l.split("\t", 1)) for l in (case / "reference.tsv").read_text().splitlines() if "\t" in l]
    terms = [t.strip() for t in (case / "terms.txt").read_text().splitlines() if t.strip()] if (case / "terms.txt").exists() else []
    vocab = (case / "vocab.txt").read_text() if args.vocab and (case / "vocab.txt").exists() else ""
    lines, t0 = [], time.time()
    for track in sorted((case / "audio").glob("*.ogg")):
        res = post_track(args.url, token, ctx, track, track.stem, model, vocab)
        lines += [{"speaker": track.stem, **s} for s in res["segments"]]
    seconds = time.time() - t0
    lines.sort(key=lambda l: l["start"])
    hyp_text = " ".join(l["text"] for l in lines)
    ref_text = " ".join(t for _, t in reference)
    found = [t for t in terms if t.lower() in hyp_text.lower()]
    result = {
        "case": case.name, "model": model, "vocab": bool(vocab),
        "wer": round(wer(ref_text, hyp_text), 3),
        "terms": f"{len(found)}/{len(terms)}",
        "missing_terms": [t for t in terms if t not in found],
        "order": round(speaker_order(reference, lines), 2),
        "seconds": round(seconds, 1),
    }
    if args.show:
        result["transcript"] = [f"{l['start']:7.1f} {l['speaker']}: {l['text']}" for l in lines]
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("cases", nargs="+", type=Path)
    p.add_argument("--url", required=True)
    p.add_argument("--token", help="backend token (or use --token-file)")
    p.add_argument("--token-file", type=Path, help=".env file containing BACKEND_TOKEN=")
    p.add_argument("--ca", type=Path, help="CA certificate that signed the backend cert")
    p.add_argument("--lenient-ca", action="store_true",
                   help="accept a CA without keyUsage (the pre-2026-09-25 CA; Python 3.13+ rejects it by default)")
    p.add_argument("--models", default="base,small")
    p.add_argument("--vocab", action="store_true", help="send each case's vocab.txt")
    p.add_argument("--show", action="store_true", help="print merged transcripts")
    args = p.parse_args()

    token = args.token
    if not token and args.token_file:
        m = re.search(r"^BACKEND_TOKEN=(.+)$", args.token_file.read_text(), re.M)
        token = m and m.group(1).strip()
    if not token:
        sys.exit("need --token or --token-file")
    ctx = ssl.create_default_context(cafile=str(args.ca)) if args.ca else ssl.create_default_context()
    if args.lenient_ca:
        ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT

    print(f"{'case':<22}{'model':<8}{'vocab':<7}{'WER':>6}{'terms':>8}{'order':>7}{'secs':>7}  missing terms")
    for case in args.cases:
        for model in args.models.split(","):
            r = run_case(case, model.strip(), args, ctx, token)
            print(f"{r['case']:<22}{r['model']:<8}{str(r['vocab']):<7}{r['wer']:>6}{r['terms']:>8}{r['order']:>7}{r['seconds']:>7}  "
                  f"{', '.join(r['missing_terms'])}")
            for line in r.get("transcript", []):
                print("      " + line)


if __name__ == "__main__":
    main()
