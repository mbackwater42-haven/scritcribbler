#!/usr/bin/env python3
"""Offline checks for backend/kbclient.py (no Flask, no Ollama, no real campaign data).
Run: python3 tests/test_kbclient.py

Builds a tiny synthetic knowledge base in a temp folder and injects fake embedding / answer
functions. Covers input validation, audience filtering, the busy response, citation flags,
index reload, and that questions and answers never reach the log."""
import hashlib
import io
import json
import logging
import math
import os
import re
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
import kbclient  # noqa: E402


def fake_embed(text):
    v = [0.0] * 64
    for w in re.findall(r"[a-z0-9']+", text.lower()):
        v[int(hashlib.md5(w.encode()).hexdigest(), 16) % 64] += 1.0
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


CHUNKS = [
    ("recap_01.md", "Recap", "players", "discord-recap", "The party met a baker named Orla at the harbour market and bought three loaves of rye bread."),
    ("recap_02.md", "Key Points", "players", "discord-recap", "- Tobin pocketed a torn page from the library book.\n- The library was quiet.\n- Marla bought a clockwork owl at the museum shop."),
    ("gm_told.md", "Facts", "players", "gm-told", "The red stone was won from the ghost of Grum in the Saltmarsh isles."),
    ("gm_secrets.md", "Villain", "gm", "gm-told", "The villain is Baron Quillfeather, who secretly serves the Voice."),
    ("prep_01.md", "Old plan", "gm", "scrapped-prep (older plan)", "In the old plan the villain was Count Marlowe and the vault was under his villa."),
    ("pc_ada.md", "Sheet", "players", "foundry-sheet", "Ada is a dwarf cleric. Equipped: mithral breastplate, warhammer."),
]
GLOSSARY = "canonical\ttype\taliases\tscope\tconf\tnote\taudience\nGrumblethorn\tnpc\tGrum\tall\tok\tdragon\tplayers\n"


def build_kb(root, campaign="demo", extra=None):
    chunks = []
    for f, h, aud, prov, text in CHUNKS + (extra or []):
        c = {"file": f, "title": f, "heading": h, "text": text, "provenance": prov, "audience": aud}
        c["vec"] = fake_embed(f"{f} | {h}\n{text}")
        chunks.append(c)
    d = Path(root) / campaign
    (d / "index").mkdir(parents=True, exist_ok=True)
    (d / "index" / f"{campaign}.json").write_text(json.dumps({"campaign": campaign, "built": "test", "chunks": chunks}), encoding="utf-8")
    (d / "glossary.tsv").write_text(GLOSSARY, encoding="utf-8")


failures = []


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f"  {detail}"))
    if not cond:
        failures.append(name)


with tempfile.TemporaryDirectory() as tmp:
    build_kb(tmp)
    prompts = []

    def fake_generate(prompt):
        prompts.append(prompt)
        return "Marla bought it [2]."

    cfg = kbclient.Config(kb_dir=Path(tmp).resolve(), embed_fn=fake_embed, generate_fn=fake_generate, lock_wait=0.2)
    lock = threading.Lock()
    ask = lambda body: kbclient.handle_ask(body, cfg, lock)  # noqa: E731

    # --- config
    check("config off when CAMPAIGNKB_DIR unset", kbclient.config_from_env({}, "http://x/api/generate") is None)
    check("config off when dir missing", kbclient.config_from_env({"CAMPAIGNKB_DIR": os.path.join(tmp, "nope")}, "http://x/api/generate") is None)
    c2 = kbclient.config_from_env({"CAMPAIGNKB_DIR": tmp}, "http://localhost:11434/api/generate")
    check("ollama base derived from OLLAMA_API_URL", c2 and c2.ollama_base == "http://localhost:11434")

    # --- validation
    check("non-object body -> 400", ask(["x"])[1] == 400)
    check("missing question -> 400", ask({"campaign": "demo"})[1] == 400)
    check("long question -> 400", ask({"campaign": "demo", "question": "x" * 501})[1] == 400)
    check("bad audience -> 400", ask({"campaign": "demo", "question": "hi", "audience": "everyone"})[1] == 400)
    for bad in ["../demo", "demo/../demo", "DEMO", "", None, 7, "nope"]:
        check(f"campaign {bad!r} -> 404", ask({"campaign": bad, "question": "hi"})[1] == 404)

    # --- retrieval and answer
    body, code = ask({"campaign": "demo", "question": "Who bought the clockwork owl?"})
    check("success", code == 200 and body["status"] == "success", body)
    check("keyword search finds the right chunk first", body["sources"] and "clockwork owl" in body["sources"][0]["text"], body["sources"][:1])
    check("citation flagged from [2]", [s["n"] for s in body["sources"] if s["cited"]] == [2], body["sources"])
    check("answer returned", body["answer"] == "Marla bought it [2].")
    check("prompt carries the question and the not-found rule", "Who bought the clockwork owl?" in prompts[-1] and kbclient.NOT_FOUND in prompts[-1])
    cfg.generate_fn = lambda p: "Both [1, 3]."
    body, _ = ask({"campaign": "demo", "question": "bread or stone?"})
    check("grouped citations [1, 3] parsed", sorted(s["n"] for s in body["sources"] if s["cited"]) == [1, 3], body["sources"])
    cfg.generate_fn = fake_generate

    # --- audience and scrapped plan
    body, _ = ask({"campaign": "demo", "question": "Who is the villain?", "audience": "gm"})
    files = [s["file"] for s in body["sources"]]
    check("gm audience can see gm_secrets", "gm_secrets.md" in files, files)
    check("scrapped prep never returned", "prep_01.md" not in files, files)
    body, _ = ask({"campaign": "demo", "question": "Who is the villain?", "audience": "players"})
    files = [s["file"] for s in body["sources"]]
    check("players audience excludes gm chunks", "gm_secrets.md" not in files and "prep_01.md" not in files, files)
    check("players prompt has no secret text", "Quillfeather" not in prompts[-1] and "Marlowe" not in prompts[-1])
    body, _ = ask({"campaign": "demo", "question": "Grum"})
    check("glossary alias boosts the entity chunk", body["sources"][0]["file"] == "gm_told.md", [s["file"] for s in body["sources"]])

    # --- sources only never calls the model
    n_before = len(prompts)
    body, code = ask({"campaign": "demo", "question": "library page", "answer": False})
    check("answer=false returns sources without calling the model", code == 200 and body["answer"] is None and len(prompts) == n_before and body["sources"])

    # --- busy
    lock.acquire()
    try:
        t0 = time.time()
        body, code = ask({"campaign": "demo", "question": "library page"})
        check("busy GPU -> 503 quickly", code == 503 and body["status"] == "busy" and time.time() - t0 < 2, (code, body))
    finally:
        lock.release()
    check("lock released after a normal answer", lock.acquire(timeout=0.1) and (lock.release() or True))

    # --- model errors map to 502 and release the lock
    def boom(prompt):
        raise kbclient.KBError("answer model unavailable", 502)

    cfg.generate_fn = boom
    body, code = ask({"campaign": "demo", "question": "library page"})
    check("model failure -> 502", code == 502 and body["status"] == "error")
    check("lock released after a model failure", lock.acquire(timeout=0.1) and (lock.release() or True))
    cfg.generate_fn = fake_generate

    # --- reload when the index file changes
    check("new chunk not visible yet", all("Zephyr" not in s["text"] for s in ask({"campaign": "demo", "question": "Zephyr"})[0]["sources"]))
    time.sleep(0.05)
    build_kb(tmp, extra=[("recap_03.md", "Recap", "players", "discord-recap", "Zephyr the courier delivered a sealed letter.")])
    body, _ = ask({"campaign": "demo", "question": "Zephyr"})
    check("index reloads after the file changes", "Zephyr" in body["sources"][0]["text"], body["sources"][:1])

    # --- campaigns list
    check("list_campaigns", [c["id"] for c in kbclient.list_campaigns(cfg)] == ["demo"])

    # --- nothing sensitive in the log
    stream = io.StringIO()
    h = logging.StreamHandler(stream)
    logging.getLogger("scrit-backend.kb").addHandler(h)
    logging.getLogger("scrit-backend.kb").setLevel(logging.INFO)
    ask({"campaign": "demo", "question": "SECRETQUESTIONWORD villain Quillfeather"})
    logging.getLogger("scrit-backend.kb").removeHandler(h)
    log = stream.getvalue()
    check("log has a summary line", "kb ask campaign=demo" in log, log)
    check("question text and answer never logged", "SECRETQUESTIONWORD" not in log and "Quillfeather" not in log and "Marla bought" not in log, log)

print("\n" + ("ALL OK" if not failures else f"{len(failures)} FAILED: {failures}"))
sys.exit(1 if failures else 0)
