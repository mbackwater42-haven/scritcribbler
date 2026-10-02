"""
Campaign knowledge-base lookups for the Scrit Cribbler backend (GM lore Q&A).

The knowledge base itself is DATA that lives OUTSIDE this repo, in a folder named by the
CAMPAIGNKB_DIR environment variable:

    CAMPAIGNKB_DIR/<campaign>/index/<campaign>.json   chunks + embeddings (JSON)
    CAMPAIGNKB_DIR/<campaign>/glossary.tsv            names and aliases (TSV)

Only JSON and TSV are read from there, never code: the folder is synced from another machine,
so nothing in it is ever imported or executed. It may hold GM-only secrets, so questions and
answers are never logged, only sizes and timings.

Unset CAMPAIGNKB_DIR and the feature is off (config_from_env returns None).

The search and prompt logic mirrors the campaign tooling's build/kb.py; keep them in step.
Everything is stdlib so it can be tested without Flask or Ollama (embed_fn / generate_fn are
injectable).
"""
import csv
import json
import logging
import math
import re
import threading
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger("scrit-backend.kb")

PENALTY = 0.06  # older "scrapped plan" prep docs are never searched, but keep the ranking rule identical
BOOST = 0.04    # per glossary entity found in the chunk text
RRF_K = 60      # reciprocal-rank-fusion constant (vector rank + keyword rank)
MAX_QUESTION = 500
DEFAULT_K, MAX_K = 6, 8
CAMPAIGN_RE = re.compile(r"^[a-z0-9]{1,32}$")
NOT_FOUND = "Not in the campaign notes."
THINKING_MODELS = re.compile(r"^(qwen3|deepseek-r1|magistral)", re.I)
STOP = set("a an the of to in on at for and or is are was were be been who what where when which how did do does with by from that this it its as into after before their they them party group they his her he she there then than has have had not no yes any all about up out over".split())


@dataclass
class Config:
    kb_dir: Path
    ollama_base: str = "http://localhost:11434"
    embed_model: str = "nomic-embed-text"
    answer_model: str = "llama3.1:8b"
    num_ctx: int = 8192
    keep_alive: str = "30m"
    lock_wait: float = 5.0  # seconds to wait for the GPU before answering "busy"
    embed_fn: Optional[Callable[[str], list]] = None      # tests inject these
    generate_fn: Optional[Callable[[str], str]] = None


def config_from_env(env, ollama_api_url):
    """Config from environment variables, or None when the knowledge base is not enabled."""
    d = (env.get("CAMPAIGNKB_DIR") or "").strip()
    if not d:
        return None
    p = Path(d)
    if not p.is_dir():
        logger.warning("CAMPAIGNKB_DIR is set but is not a directory; knowledge base disabled")
        return None
    return Config(
        kb_dir=p.resolve(),
        ollama_base=re.sub(r"/api/[a-z]+/?$", "", ollama_api_url.rstrip("/")),
        embed_model=env.get("KB_EMBED_MODEL", "nomic-embed-text"),
        answer_model=env.get("KB_ANSWER_MODEL", "llama3.1:8b"),
        num_ctx=int(env.get("KB_ANSWER_NUM_CTX", env.get("OLLAMA_NUM_CTX", "8192"))),
        keep_alive=env.get("OLLAMA_KEEP_ALIVE", "30m"),
    )


class KBError(Exception):
    def __init__(self, message, status):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------- loading (cached by file mtime)
_cache = {}
_cache_lock = threading.Lock()


def _paths(cfg, campaign):
    base = cfg.kb_dir / campaign
    return base / "index" / f"{campaign}.json", base / "glossary.tsv"


def load_kb(cfg, campaign):
    """(index, alias map) for a campaign, or None if it does not exist. Reloaded when the file changes."""
    if not CAMPAIGN_RE.match(campaign or ""):
        return None
    ipath, gpath = _paths(cfg, campaign)
    try:
        stamp = (ipath.stat().st_mtime_ns, gpath.stat().st_mtime_ns if gpath.exists() else 0)
    except OSError:
        return None
    with _cache_lock:
        hit = _cache.get((str(cfg.kb_dir), campaign))
        if hit and hit[0] == stamp:
            return hit[1], hit[2]
        idx = json.loads(ipath.read_text(encoding="utf-8"))
        amap = {}
        if gpath.exists():
            with open(gpath, newline="", encoding="utf-8") as f:
                for r in csv.DictReader(f, delimiter="\t"):
                    amap[r["canonical"].lower()] = r["canonical"]
                    for a in (r.get("aliases") or "").split("|"):
                        if a.strip():
                            amap[a.strip().lower()] = r["canonical"]
        _cache[(str(cfg.kb_dir), campaign)] = (stamp, idx, amap)
        return idx, amap


def list_campaigns(cfg):
    out = []
    for d in sorted(cfg.kb_dir.iterdir()):
        if d.is_dir() and CAMPAIGN_RE.match(d.name) and (d / "index" / f"{d.name}.json").exists():
            kb = load_kb(cfg, d.name)
            if kb:
                out.append({"id": d.name, "chunks": len(kb[0]["chunks"]), "built": kb[0].get("built", "")})
    return out


# ---------------------------------------------------------------- retrieval
def _stem(w):
    for suf in ("ing", "ed", "es", "s"):
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            return w[: -len(suf)]
    return w


def toks(text):
    return [_stem(w) for w in re.findall(r"[a-z0-9']+", text.lower()) if w not in STOP and len(w) > 1]


def _lex(idx):
    if "_lex" not in idx:
        docs = [toks(c["title"] + " " + c["heading"] + " " + c["text"]) for c in idx["chunks"]]
        df = {}
        for d in docs:
            for w in set(d):
                df[w] = df.get(w, 0) + 1
        n = len(docs)
        idx["_lex"] = {"docs": docs, "n": n, "avg": sum(map(len, docs)) / max(n, 1),
                       "idf": {w: math.log(1 + (n - c + 0.5) / (c + 0.5)) for w, c in df.items()}}
    return idx["_lex"]


def _bm25(lex, qt, i, k1=1.5, b=0.75):
    d = lex["docs"][i]
    if not d:
        return 0.0
    tf = {}
    for w in d:
        tf[w] = tf.get(w, 0) + 1
    s = 0.0
    for w in set(qt):
        f = tf.get(w, 0)
        if f:
            s += lex["idf"].get(w, 0.0) * f * (k1 + 1) / (f + k1 * (1 - b + b * len(d) / lex["avg"]))
    return s


def cosine(a, b):
    d = sum(x * y for x, y in zip(a, b))
    return d / ((math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))) or 1.0)


def entities_in(query, amap):
    q = query.lower()
    return {c for a, c in amap.items() if len(a) >= 3 and re.search(r"(?<![\w'])" + re.escape(a) + r"(?![\w])", q)}


def search(cfg, idx, amap, q, k=DEFAULT_K, audience="gm"):
    """Top-k [(score, chunk)]. Vector similarity (+entity boost) and BM25 keyword score fused by
    reciprocal rank. Scrapped-plan prep docs are never returned; audience=players returns only
    chunks tagged for players (untagged chunks count as GM-only)."""
    ents = entities_in(q, amap)
    qv = embed_query(cfg, " ".join([q] + sorted(ents)))
    lex = _lex(idx)
    qt = toks(q + " " + " ".join(sorted(ents)))
    cand = []
    for i, c in enumerate(idx["chunks"]):
        if audience == "players" and c.get("audience", "gm") != "players":
            continue
        if c.get("provenance", "").startswith("scrapped-prep"):
            continue
        low = c["text"].lower()
        hits = sum(1 for e in ents if e.lower() in low)
        cand.append((cosine(qv, c["vec"]) + min(hits, 3) * BOOST, _bm25(lex, qt, i), c))
    by_v = sorted(range(len(cand)), key=lambda j: -cand[j][0])
    by_l = [j for j in sorted(range(len(cand)), key=lambda j: -cand[j][1]) if cand[j][1] > 0]
    score = {j: 1.0 / (RRF_K + r) for r, j in enumerate(by_v, 1)}
    for r, j in enumerate(by_l, 1):
        score[j] += 1.0 / (RRF_K + r)
    top = sorted(score, key=lambda j: -score[j])[:k]
    return [(score[j], cand[j][2]) for j in top]


def focus(idx, text, question, n=3, keep_whole=380):
    """Keep the n units (bullets / sentences) of a chunk that best match the question."""
    if len(text) <= keep_whole:
        return text
    units = [u.strip() for u in re.split(r"\n|(?<=[.!?])\s+", text) if u.strip()]
    if len(units) <= n:
        return text
    idf, qs = _lex(idx)["idf"], set(toks(question))
    scored = [(sum(idf.get(w, 1.0) for w in set(toks(u)) & qs), i) for i, u in enumerate(units)]
    ranked = sorted(scored, key=lambda x: (-x[0], x[1]))
    if ranked[0][0] <= 0:
        return text
    keep = {i for s, i in ranked[:n] if s > 0}
    if ranked[0][1] + 1 < len(units):
        keep.add(ranked[0][1] + 1)
    return " ... ".join(units[i].lstrip("- ").strip() for i in sorted(keep))


def reliability(c):
    f = c["file"]
    if f.startswith(("gm_told", "gm_secrets")):
        return "AUTHORITATIVE (stated by the GM)"
    if f.startswith(("pc_", "npc_", "pcbio_")):
        return "character sheet"
    if f.startswith("gm_"):
        return "GM notes"
    if f.startswith("scrit_"):
        return "Session recap (machine-written from audio, GM-editable; names may be misspelled)"
    if f.startswith("recap_"):
        return "Discord recap (machine-written from audio; names may be misspelled)"
    if f.startswith("prep_"):
        return "OLDER SCRAPPED PLAN (may be wrong; the villain's name was changed)"
    return "notes"


def build_prompt(question, hits, idx):
    texts = [focus(idx, c["text"], question) for _, c in hits]
    ex = "\n\n".join(f"[{i}] ({reliability(c)}) {c['file']} > {c['heading']}\n{txt}" for i, ((_, c), txt) in enumerate(zip(hits, texts), 1))
    return f"""You are a lookup assistant for a Dungeon Master's private notes on a D&D campaign. Answer the QUESTION using ONLY the numbered EXCERPTS below.
Rules:
- If the excerpts answer the question, even partly, answer it directly from them.
- Cite the excerpt numbers you used, like [2]. Every statement of fact needs a citation.
- For a yes/no question, start with "Yes" or "No", then one short clarification.
- Only if NO excerpt contains anything relevant, reply with exactly: {NOT_FOUND}  Never write that sentence in an answer that also gives information.
- Never use outside knowledge of published adventures, rulebooks or settings. Do not guess or infer places, people or numbers the excerpts do not state.
- Excerpts are labeled by reliability. AUTHORITATIVE beats GM notes, which beat Discord recaps (machine-written, may misspell names). If excerpts disagree, say they disagree and which one is more reliable.
- Write only the answer: at most four sentences, or a short list. No preamble, no reasoning steps, no "I will look for", no repeating yourself.

EXCERPTS:
{ex}

QUESTION: {question}
ANSWER:""", texts


# ---------------------------------------------------------------- Ollama (CPU embeddings, GPU answers)
def _post_json(url, body, timeout):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def embed_query(cfg, text):
    if cfg.embed_fn:
        return cfg.embed_fn(text)
    try:  # tiny model on CPU: never competes with the answer/recap model for the GPU
        return _post_json(f"{cfg.ollama_base}/api/embeddings",
                          {"model": cfg.embed_model, "prompt": f"search_query: {text}", "keep_alive": cfg.keep_alive,
                           "options": {"num_gpu": 0}}, 60)["embedding"]
    except Exception:
        raise KBError("embedding model unavailable", 502)


def generate(cfg, prompt):
    if cfg.generate_fn:
        return cfg.generate_fn(prompt)
    body = {"model": cfg.answer_model, "prompt": prompt, "stream": False, "keep_alive": cfg.keep_alive,
            "options": {"temperature": 0.1, "num_ctx": cfg.num_ctx, "num_predict": 350}}
    if THINKING_MODELS.match(cfg.answer_model):
        body["think"] = False
    try:
        text = _post_json(f"{cfg.ollama_base}/api/generate", body, 900).get("response", "")
    except Exception:
        raise KBError("answer model unavailable", 502)
    return re.sub(r"<think>.*?</think>\s*", "", text, flags=re.S).strip()


# ---------------------------------------------------------------- the request
def handle_ask(body, cfg, gpu_lock):
    """Answer one question. Returns (json payload, http status). Never logs question or answer text."""
    t0 = time.time()
    if not isinstance(body, dict):
        return {"status": "error", "error": "JSON object expected"}, 400
    question = body.get("question")
    if not isinstance(question, str) or not question.strip():
        return {"status": "error", "error": "question is required"}, 400
    question = question.strip()
    if len(question) > MAX_QUESTION:
        return {"status": "error", "error": f"question is longer than {MAX_QUESTION} characters"}, 400
    audience = body.get("audience", "gm")
    if audience not in ("gm", "players"):
        return {"status": "error", "error": "audience must be gm or players"}, 400
    k = body.get("k", DEFAULT_K)
    k = max(1, min(MAX_K, k)) if isinstance(k, int) and not isinstance(k, bool) else DEFAULT_K
    want_answer = body.get("answer", True) is not False
    campaign = body.get("campaign")
    kb = load_kb(cfg, campaign if isinstance(campaign, str) else "")
    if not kb:  # same reply for malformed and nonexistent names
        return {"status": "error", "error": "unknown campaign"}, 404
    idx, amap = kb
    try:
        hits = search(cfg, idx, amap, question, k, audience)
        answer, texts, cited = "", [], set()
        if want_answer:
            prompt, texts = build_prompt(question, hits, idx)
            if not gpu_lock.acquire(timeout=cfg.lock_wait):
                return {"status": "busy", "error": "The model is busy (a recap may be running). Try again in a minute."}, 503
            try:
                answer = generate(cfg, prompt)
            finally:
                gpu_lock.release()
            for grp in re.findall(r"\[(\d+(?:\s*,\s*\d+)*)\]", answer):
                cited.update(int(n) for n in re.split(r"\s*,\s*", grp))
        else:
            texts = [focus(idx, c["text"], question) for _, c in hits]
    except KBError as e:
        logger.warning("kb ask failed: %s", e)
        return {"status": "error", "error": str(e)}, e.status
    sources = [{"n": i, "file": c["file"], "heading": c["heading"], "reliability": reliability(c),
                "score": round(s, 4), "cited": i in cited, "text": t[:600]}
               for i, ((s, c), t) in enumerate(zip(hits, texts), 1)]
    logger.info("kb ask campaign=%s audience=%s question_chars=%d chunks=%d answer_chars=%d %.1fs",
                campaign, audience, len(question), len(hits), len(answer), time.time() - t0)
    return {"status": "success", "answer": answer if want_answer else None, "model": cfg.answer_model if want_answer else None,
            "audience": audience, "sources": sources, "seconds": round(time.time() - t0, 1)}, 200
